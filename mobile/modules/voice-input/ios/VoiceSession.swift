import AVFoundation
import Speech
import UIKit

struct VoiceFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// One recording belongs to one sheet. Every mutating call names that lease;
/// closing an old conversation must never stop or receive a newer recording.
@available(iOS 26.0, *)
@MainActor final class VoiceSession: NSObject, AVAudioRecorderDelegate {
  private var lease: String?
  private var recorder: AVAudioRecorder?
  private var folder: URL?
  private var analyzer: SpeechAnalyzer?
  private var module: (any SpeechModule)?
  private var transcriber: SpeechTranscriber?
  private var dictation: DictationTranscriber?
  private var download: Progress?
  private var observers: [NSObjectProtocol] = []
  private var stopping = false
  var changed: ([String: Any]) -> Void = { _ in }
  static let maximumSeconds = 300.0

  override init() {
    super.init()
    // A recording can survive a killed process only as a protected temporary
    // file. Remove those leftovers when this module is first opened again.
    let root = FileManager.default.temporaryDirectory
    for url in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
      where url.lastPathComponent.hasPrefix("shahi-voice-") { try? FileManager.default.removeItem(at: url) }
    for name in [UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification,
                 AVAudioSession.mediaServicesWereResetNotification, AVAudioSession.routeChangeNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
        // Category changes caused by our own setup are not an interruption.
        if note.name == AVAudioSession.routeChangeNotification {
          let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
          if reason != AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { return }
        }
        if note.name == AVAudioSession.interruptionNotification {
          let kind = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
          if kind != AVAudioSession.InterruptionType.began.rawValue { return }
        }
        // The observer runs on the main queue. Handle it before another sheet
        // can claim the microphone, rather than queueing an unowned callback.
        MainActor.assumeIsolated { [weak self] in
          guard let self, let id = self.lease else { return }
          self.cancel(id)
          self.changed(["id": id, "kind": "interrupted"])
        }
      })
    }
  }

  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  func support() async -> [String: Any] {
    let modern = SpeechTranscriber.isAvailable ? await SpeechTranscriber.supportedLocales : []
    let fallback = await DictationTranscriber.supportedLocales
    let installed = Set((await SpeechTranscriber.installedLocales).map { $0.identifier(.bcp47) })
    let dictationInstalled = Set((await DictationTranscriber.installedLocales).map { $0.identifier(.bcp47) })
    let modernIDs = Set(modern.map { $0.identifier(.bcp47) })
    var seen = Set<String>()
    let locales: [[String: Any]] = (modern + fallback).compactMap { locale in
      let id = locale.identifier(.bcp47)
      guard seen.insert(id).inserted else { return nil }
      return ["id": id, "name": Locale.current.localizedString(forIdentifier: id) ?? id,
              "installed": modernIDs.contains(id) ? installed.contains(id) : dictationInstalled.contains(id)]
    }.sorted { ($0["name"] as! String).localizedStandardCompare($1["name"] as! String) == .orderedAscending }
    let preferred = Locale(identifier: Locale.preferredLanguages.first ?? Locale.current.identifier)
    let preferredLocale = SpeechTranscriber.isAvailable ? await SpeechTranscriber.supportedLocale(equivalentTo: preferred) : nil
    let fallbackLocale = await DictationTranscriber.supportedLocale(equivalentTo: preferred)
    return ["available": !locales.isEmpty, "locales": locales,
            "preferred": (preferredLocale ?? fallbackLocale)?.identifier(.bcp47) ?? "",
            "maximumSeconds": Self.maximumSeconds]
  }

  private func check(_ id: String) throws {
    guard lease == id, !Task.isCancelled else { throw CancellationError() }
  }

  func prepare(_ id: String, localeID: String, allowDownload: Bool) async throws -> Bool {
    guard lease == nil else { throw VoiceFailure(message: "Another voice recording is already open.") }
    lease = id
    do {
      let locale = Locale(identifier: localeID)
      if SpeechTranscriber.isAvailable, let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
        try check(id)
        let value = SpeechTranscriber(locale: supported, preset: .transcription)
        transcriber = value; module = value
      } else if let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
        try check(id)
        let value = DictationTranscriber(locale: supported, preset: .longDictation)
        dictation = value; module = value
      } else { throw VoiceFailure(message: "On-device transcription is unavailable for this language on this iPhone.") }
      try check(id)
      guard let module else { throw VoiceFailure(message: "Voice input is unavailable.") }
      let state = await AssetInventory.status(forModules: [module])
      try check(id)
      guard state != .unsupported else { throw VoiceFailure(message: "This iPhone cannot transcribe this language on-device.") }
      if state != .installed {
        // iOS can evict unused models between opening the sheet and recording.
        // Return to an explicit download button instead of downloading silently.
        guard allowDownload else { cancel(id); return false }
        // Reservations belong to this app. Keep one voice language reserved;
        // Apple owns the shared files and decides when unused assets are removed.
        for reserved in await AssetInventory.reservedLocales where reserved.identifier(.bcp47) != localeID {
          try check(id)
          await AssetInventory.release(reservedLocale: reserved)
        }
        try check(id)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
          try check(id)
          download = request.progress
          try await request.downloadAndInstall()
        }
      }
      try check(id)
      download = nil
      return true
    } catch {
      cancel(id)
      if error is CancellationError { throw error }
      throw (error as? VoiceFailure) ?? VoiceFailure(message: "The language could not be prepared. Check your connection and available storage, then try again.")
    }
  }

  func progress(_ id: String) -> Double {
    lease == id ? download?.fractionCompleted ?? 0 : 0
  }

  func start(_ id: String) async throws {
    try check(id)
    guard recorder == nil, module != nil else { throw VoiceFailure(message: "Voice input is not ready.") }
    let allowed = await AVAudioApplication.requestRecordPermission()
    try check(id)
    guard allowed else {
      cancel(id)
      throw VoiceFailure(message: "Microphone access is off. Enable it for Shahi in Settings to record a prompt.")
    }
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
      try audio.setActive(true)
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("shahi-voice-" + UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
        attributes: [.protectionKey: FileProtectionType.complete])
      folder = directory
      var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
      var protectedDirectory = directory; try protectedDirectory.setResourceValues(excluded)
      let value = try AVAudioRecorder(url: directory.appendingPathComponent("recording.caf"), settings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
      ])
      value.delegate = self; recorder = value
      guard value.record(forDuration: Self.maximumSeconds) else { throw VoiceFailure(message: "The microphone could not start. Try again after any call or other recording finishes.") }
    } catch { cancel(id); throw (error as? VoiceFailure) ?? VoiceFailure(message: "The microphone could not start. Please try again.") }
  }

  func stop(_ id: String) async throws -> String {
    try check(id)
    guard !stopping, let recorder, let module else { throw VoiceFailure(message: "There is no recording to transcribe.") }
    stopping = true
    recorder.delegate = nil
    recorder.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    let engine = SpeechAnalyzer(modules: [module])
    analyzer = engine
    // Read finalized segments only; no provisional text can be duplicated.
    let modern = transcriber; let fallback = dictation
    let results = Task { () throws -> String in
      var text = ""
      if let modern { for try await result in modern.results where result.isFinal { text += String(result.text.characters) } }
      else if let fallback { for try await result in fallback.results where result.isFinal { text += String(result.text.characters) } }
      return text
    }
    do {
      let file = try AVAudioFile(forReading: recorder.url)
      if let end = try await engine.analyzeSequence(from: file) { try await engine.finalizeAndFinish(through: end) }
      else { await engine.cancelAndFinishNow() }
      let text = try await results.value.trimmingCharacters(in: .whitespacesAndNewlines)
      try check(id)
      cancel(id)
      guard !text.isEmpty else { throw VoiceFailure(message: "No speech was recognized. Try again closer to the microphone.") }
      return text
    } catch {
      results.cancel(); await engine.cancelAndFinishNow(); cancel(id)
      if error is CancellationError { throw error }
      throw (error as? VoiceFailure) ?? VoiceFailure(message: "This recording could not be transcribed on-device. Please try again.")
    }
  }

  func cancel(_ id: String) {
    guard lease == id else { return }
    lease = nil
    recorder?.delegate = nil; recorder?.stop(); recorder = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    download?.cancel(); download = nil
    if let engine = analyzer { Task { await engine.cancelAndFinishNow() } }
    analyzer = nil; module = nil; transcriber = nil; dictation = nil; stopping = false
    if let folder { try? FileManager.default.removeItem(at: folder) }; folder = nil
  }

  func close() { if let id = lease { cancel(id) } }

  nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    Task { @MainActor [weak self] in
      guard let self, recorder === self.recorder, let id = self.lease, !self.stopping else { return }
      if flag { self.changed(["id": id, "kind": "limit"]) }
      else { self.cancel(id); self.changed(["id": id, "kind": "interrupted"]) }
    }
  }
}
