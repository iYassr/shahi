import AVFoundation
import Speech

/// Drives LiveTranscription with the real Apple engine on a Mac: synthesized
/// speech in, streamed at real-time pace in microphone-sized buffers, the way
/// DictationSession feeds it on the phone. Not a substitute for a device check
/// (docs/voice-input.md); it proves the pipeline and the API usage.
@main struct Harness {
  static func main() async {
    guard #available(macOS 26.0, *) else { print("FAIL needs macOS 26"); exit(1) }
    let args = CommandLine.arguments
    let audio = URL(fileURLWithPath: args[1])
    let expected = args.dropFirst(2).map { $0.lowercased() }
    print("speech authorization before:", SFSpeechRecognizer.authorizationStatus().rawValue, "(0 = not determined)")
    guard SpeechTranscriber.isAvailable, let locale = await LiveTranscription.englishLocale() else { print("FAIL SpeechTranscriber unavailable"); exit(1) }
    print("locale:", locale.identifier(.bcp47))
    let session = LiveTranscription(locale: locale)
    do {
      if !(await session.installed()) {
        print("installing Apple's model…")
        try await session.install { value in print(String(format: "  %.0f%%", value * 100)) }
      }
      let started = Date()
      let firstVolatile = Locked<Double?>(nil)
      let volatileUpdates = Locked(0)
      session.onText = { finalized, volatile in
        if !volatile.isEmpty { volatileUpdates.mutate { $0 += 1 } }
        if !volatile.isEmpty { firstVolatile.mutate { if $0 == nil { $0 = Date().timeIntervalSince(started) } } }
      }
      let prepared = Date()
      _ = try await session.begin()
      print(String(format: "begin (model load) %.2fs", Date().timeIntervalSince(prepared)))
      let file = try AVAudioFile(forReading: audio)
      let format = file.processingFormat
      print("input format:", format.sampleRate, "Hz,", format.channelCount, "ch")
      let chunk: AVAudioFrameCount = 4096
      let fed = Date()
      while file.framePosition < file.length {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { break }
        try file.read(into: buffer, frameCount: chunk)
        session.append(buffer)
        // Real-time pace, as a microphone would deliver it.
        try await Task.sleep(nanoseconds: UInt64(Double(buffer.frameLength) / format.sampleRate * 1_000_000_000))
      }
      let spoken = Date().timeIntervalSince(fed)
      let stopping = Date()
      let text = try await session.finish()
      print(String(format: "audio %.1fs; first live words after %.2fs; %d live updates; stop to final text %.2fs",
                   spoken, firstVolatile.value ?? -1, volatileUpdates.value, Date().timeIntervalSince(stopping)))
      print("final:", text)
      print("speech authorization after:", SFSpeechRecognizer.authorizationStatus().rawValue)
      let lower = text.lowercased()
      let missing = expected.filter { !lower.contains($0) }
      if firstVolatile.value == nil { print("FAIL no live text"); exit(1) }
      if !missing.isEmpty { print("FAIL missing:", missing); exit(1) }
      print("PASS")
    } catch {
      print("FAIL", error.localizedDescription); exit(1)
    }
  }
}

final class Locked<T>: @unchecked Sendable {
  private var stored: T
  private let lock = NSLock()
  init(_ value: T) { stored = value }
  var value: T { lock.lock(); defer { lock.unlock() }; return stored }
  func mutate(_ change: (inout T) -> Void) { lock.lock(); change(&stored); lock.unlock() }
}
