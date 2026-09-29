import AVFoundation
import Speech
import UIKit

/**
 The microphone side of dictation on iPhone.

 One dictation at a time, named by a lease id, so a conversation that was
 closed never stops or receives a newer one. Audio goes from the microphone
 straight into Apple's analyzer and is never written to disk.

 Whatever ends a dictation keeps what was said: a call, a lost headset, the
 app going to the background or the time limit finishes it and reports the
 settled text as `stopped`, where discarding it would lose words the person
 already saw on screen.
 */
@available(iOS 26.0, *)
@MainActor final class DictationSession {
  /// Long enough for any prompt; short enough that a forgotten microphone stops.
  static let maximumSeconds: Double = 300
  /// How long after the microphone starts an engine reconfiguration is our own doing.
  static let settled: TimeInterval = 1


  var send: @MainActor @Sendable ([String: Any]) -> Void = { _ in }
  private var lease: String?
  private var live: LiveTranscription?
  private let engine = AVAudioEngine()
  private var tapped = false
  private var listeningSince = Date.distantPast
  private var limit: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []

  init() {
    let center = NotificationCenter.default
    let stops: [(Notification.Name, @Sendable (Notification) -> Bool)] = [
      (AVAudioSession.interruptionNotification, { note in
        (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue
      }),
      // A headset taken away; a new one arriving changes the engine's
      // configuration instead, reported below.
      (AVAudioSession.routeChangeNotification, { note in
        (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
      }),
      (.AVAudioEngineConfigurationChange, { _ in true }),  // but see `settled`
      (AVAudioSession.mediaServicesWereResetNotification, { _ in true }),
      (UIApplication.didEnterBackgroundNotification, { _ in true }),
    ]
    for (name, applies) in stops {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
        guard applies(note) else { return }
        MainActor.assumeIsolated {
          guard let self, let id = self.lease, self.tapped else { return }
          // Our own session setup can reconfigure the engine a moment after it
          // starts; a headset arriving later is what this is for.
          if note.name == .AVAudioEngineConfigurationChange, Date().timeIntervalSince(self.listeningSince) < Self.settled { return }
          Task { await self.stopOnItsOwn(id, reason: "interrupted") }
        }
      })
    }
  }

  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  /// Whether this iPhone can dictate with Apple's best model, and whether that model is here yet.
  func availability() async -> [String: Any] {
    guard SpeechTranscriber.isAvailable, let locale = await LiveTranscription.englishLocale() else {
      return ["available": false, "installed": false]
    }
    return ["available": true, "installed": await LiveTranscription(locale: locale).installed()]
  }

  /// Fetches Apple's English model, reporting progress as `download` events for `id`.
  func install(_ id: String) async throws {
    guard let locale = await LiveTranscription.englishLocale() else { throw unavailable }
    let send = self.send
    try await LiveTranscription(locale: locale).install { fraction in
      Task { @MainActor in send(["id": id, "kind": "download", "fraction": fraction]) }
    }
  }

  func start(_ id: String) async throws {
    guard lease == nil else { throw DictationFailure(message: "Dictation is already running in another conversation.") }
    lease = id
    do {
      guard SpeechTranscriber.isAvailable, let locale = await LiveTranscription.englishLocale() else { throw unavailable }
      guard await AVAudioApplication.requestRecordPermission() else {
        throw DictationFailure(message: "Microphone access is off. Turn it on for Shahi in Settings to dictate.")
      }
      try check(id)
      let transcription = LiveTranscription(locale: locale)
      // iOS can remove a model nobody used for a while; the JavaScript side
      // installs it again when it hears this.
      guard await transcription.installed() else { throw DictationFailure(message: "Apple's English speech model needs to be downloaded again.") }
      let send = self.send
      transcription.onText = { finalized, volatile in
        Task { @MainActor in send(["id": id, "kind": "text", "finalized": finalized, "volatile": volatile]) }
      }
      live = transcription

      // Apple's own speech sample records this way: the plain signal, no
      // voice-chat processing, other audio lowered while the person talks.
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .measurement, options: [.duckOthers, .allowBluetoothHFP])
      try audio.setActive(true)
      _ = try await transcription.begin()
      try check(id)

      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else { throw DictationFailure(message: "No microphone is available.") }
      var lastLevel = Date.distantPast
      input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
        transcription.append(buffer)
        let now = Date()
        guard now.timeIntervalSince(lastLevel) >= 0.08 else { return }
        lastLevel = now
        let level = DictationSession.level(of: buffer)
        Task { @MainActor in send(["id": id, "kind": "level", "level": level]) }
      }
      tapped = true
      listeningSince = Date()
      engine.prepare()
      try engine.start()
      limit = Task { [weak self] in
        try? await Task.sleep(for: .seconds(Self.maximumSeconds))
        guard !Task.isCancelled else { return }
        await self?.stopOnItsOwn(id, reason: "limit")
      }
    } catch {
      await discard()
      throw error is CancellationError ? DictationFailure(message: "Dictation was cancelled.") : error
    }
  }

  /// Stops listening and returns everything said, once the last words have settled.
  func finish(_ id: String) async throws -> String {
    guard lease == id, let live else { throw DictationFailure(message: "There is no dictation to finish.") }
    stopAudio()
    self.live = nil
    defer { lease = nil }
    do { return try await live.finish() }
    catch { throw DictationFailure(message: "What you said could not be transcribed. Please try again.") }
  }

  func cancel(_ id: String) async {
    guard lease == id else { return }
    await discard()
  }

  func close() {
    guard lease != nil else { return }
    Task { await discard() }
  }

  private func stopOnItsOwn(_ id: String, reason: String) async {
    guard lease == id, let settled = live?.text().finalized else { return }
    let text = (try? await finish(id)) ?? settled.trimmingCharacters(in: .whitespacesAndNewlines)
    send(["id": id, "kind": "stopped", "reason": reason, "text": text])
  }

  private func discard() async {
    stopAudio()
    await live?.cancel()
    live = nil
    lease = nil
  }

  private func stopAudio() {
    limit?.cancel(); limit = nil
    if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    if engine.isRunning { engine.stop() }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func check(_ id: String) throws {
    guard lease == id else { throw CancellationError() }
  }

  private var unavailable: DictationFailure {
    DictationFailure(message: "Dictation needs Apple's on-device English model, which this iPhone does not support.")
  }

  /// The loudness of a buffer, 0 to 1 over a 50 dB range, for the level meter.
  nonisolated static func level(of buffer: AVAudioPCMBuffer) -> Double {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
    let rms = (sum / Float(buffer.frameLength)).squareRoot()
    let decibels = 20 * log10(max(rms, 0.000_01))
    return Double(max(0, min(1, (decibels + 50) / 50)))
  }
}
