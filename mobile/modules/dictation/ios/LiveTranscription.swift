import AVFoundation
import Speech

/// A failure worded for the person dictating; the JavaScript side shows it as is.
struct DictationFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/**
 Apple's SpeechTranscriber, fed live audio, reporting text as it settles.

 SpeechTranscriber is the model Apple uses for Notes and Voice Memos; it is the
 most accurate on-device engine Apple offers and needs no model of our own.
 DictationTranscriber, the older model, is deliberately not a fallback: it
 measured several times the error rate (Lyonesse, LibriSpeech, July 2026). The
 transcriber reports volatile text and replaces it with final text for each
 stretch of speech. `fastResults` is on: measured with `tests/run.sh` on an M-series
 Mac (macOS 27, 2026-09-29), the first live words took 4.1 s without it and
 1.0 s with it, while the final text and the 0.2 s from stop to final text were
 the same.

 Platform-neutral on purpose, so `tests/run.sh` can drive the real engine on a
 Mac with synthesized speech. Audio capture lives in DictationSession.
 */
@available(iOS 26.0, macOS 26.0, *)
final class LiveTranscription: @unchecked Sendable {
  /// The person's own English (en-GB, en-AU…) when Apple has it, else US English.
  static func englishLocale() async -> Locale? {
    for identifier in Locale.preferredLanguages + ["en-US"] {
      let candidate = Locale(identifier: identifier)
      guard candidate.language.languageCode == .english else { continue }
      if let supported = await SpeechTranscriber.supportedLocale(equivalentTo: candidate) { return supported }
    }
    return nil
  }

  let locale: Locale
  private let transcriber: SpeechTranscriber
  private let analyzer: SpeechAnalyzer
  private let converter = BufferConverter()
  // Set once in `begin`, before audio arrives; read by the audio thread after.
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var format: AVAudioFormat?
  private var reading: Task<Void, Error>?
  private let lock = NSLock()
  private var finalized = ""
  private var volatile = ""
  /// Every change of the settled and tentative text, on an arbitrary thread.
  var onText: @Sendable (_ finalized: String, _ volatile: String) -> Void = { _, _ in }

  init(locale: Locale) {
    self.locale = locale
    transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
    analyzer = SpeechAnalyzer(modules: [transcriber])
  }

  /// Whether Apple's model for this locale is on the device. iOS can remove an unused one.
  func installed() async -> Bool {
    await AssetInventory.status(forModules: [transcriber]) == .installed
  }

  /**
   Downloads Apple's model for this locale. The files are Apple's, shared with
   other apps and updated by the system; the app only reserves its language.
   */
  func install(progress: @escaping @Sendable (Double) -> Void) async throws {
    let status = await AssetInventory.status(forModules: [transcriber])
    guard status != .unsupported else { throw DictationFailure(message: "This iPhone cannot transcribe English on-device.") }
    guard status != .installed else { return }
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else { return }
    let observation = request.progress.observe(\.fractionCompleted, options: [.initial, .new]) { value, _ in progress(value.fractionCompleted) }
    defer { observation.invalidate() }
    try await request.downloadAndInstall()
  }

  /// Loads the model and starts analysis; returns the format `append` converts to.
  func begin() async throws -> AVAudioFormat {
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw DictationFailure(message: "Voice input could not start on this iPhone.")
    }
    self.format = format
    try await analyzer.prepareToAnalyze(in: format)
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .unbounded)
    input = continuation
    let transcriber = self.transcriber
    reading = Task { [weak self] in
      for try await result in transcriber.results {
        self?.take(String(result.text.characters), final: result.isFinal)
      }
    }
    try await analyzer.start(inputSequence: stream)
    return format
  }

  /// Hands a buffer of microphone audio to the analyzer. Called on the audio thread.
  func append(_ buffer: AVAudioPCMBuffer) {
    guard let format, let input, let converted = converter.convert(buffer, to: format) else { return }
    input.yield(AnalyzerInput(buffer: converted))
  }

  /// Stops taking audio and waits for the last words to settle. Returns everything said.
  func finish() async throws -> String {
    input?.finish()
    if input != nil { try await analyzer.finalizeAndFinishThroughEndOfInput() }
    _ = try await reading?.value
    return text().finalized.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func cancel() async {
    input?.finish()
    reading?.cancel()
    await analyzer.cancelAndFinishNow()
  }

  func text() -> (finalized: String, volatile: String) {
    lock.lock(); defer { lock.unlock() }
    return (finalized, volatile)
  }

  private func take(_ piece: String, final: Bool) {
    lock.lock()
    if final {
      finalized = LiveTranscription.join(finalized, piece)
      volatile = ""
    } else {
      volatile = piece
    }
    let snapshot = (finalized, volatile)
    lock.unlock()
    onText(snapshot.0, snapshot.1)
  }

  /// Joins settled pieces with one space where neither side brings its own.
  static func join(_ text: String, _ piece: String) -> String {
    guard !text.isEmpty, !piece.isEmpty else { return text + piece }
    if text.last!.isWhitespace || piece.first!.isWhitespace { return text + piece }
    return text + " " + piece
  }
}

/// Microphone audio arrives at the hardware's rate; the analyzer wants its own
/// format, and a mismatch produces nothing and no error (dev.to, June 2026).
final class BufferConverter: @unchecked Sendable {
  private var converter: AVAudioConverter?

  func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    if buffer.format == format { return buffer }
    if converter?.inputFormat != buffer.format || converter?.outputFormat != format {
      converter = AVAudioConverter(from: buffer.format, to: format)
      converter?.primeMethod = .none
    }
    guard let converter else { return nil }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var consumed = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, state in
      if consumed { state.pointee = .noDataNow; return nil }
      consumed = true
      state.pointee = .haveData
      return buffer
    }
    return status == .error || output.frameLength == 0 ? nil : output
  }
}
