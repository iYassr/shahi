import ExpoModulesCore
import PDFKit
import UIKit

public class ShahiDocumentsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShahiDocuments")
    View(ShahiPDFView.self) {
      Events("onLoadError")
      Prop("base64") { (view: ShahiPDFView, value: String) in view.load(value) }
    }
    AsyncFunction("share") { (base64: String, name: String, promise: Promise) in
      guard let data = Data(base64Encoded: base64.padding(toLength: ((base64.count + 3) / 4) * 4, withPad: "=", startingAt: 0)), data.count <= 25 * 1024 * 1024 else {
        promise.reject(DocumentException("invalid_file", "This file could not be saved.")); return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject(DocumentException("no_presenter", "The share sheet is unavailable.")); return
      }
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent("shahi-share-" + UUID().uuidString)
      let safeName = URL(fileURLWithPath: name).lastPathComponent
      let url = folder.appendingPathComponent(safeName.isEmpty || safeName == "." || safeName == ".." ? "download" : safeName)
      do {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = presenter.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        sheet.completionWithItemsHandler = { _, _, _, error in
          try? FileManager.default.removeItem(at: folder)
          if error != nil { promise.reject(DocumentException("share_failed", "The file could not be shared.")) }
          else { promise.resolve(nil) }
        }
        presenter.present(sheet, animated: true)
      } catch {
        try? FileManager.default.removeItem(at: folder)
        promise.reject(DocumentException("save_failed", "The file could not be saved."))
      }
    }.runOnQueue(.main)
  }
}
/**
 * A failed Save/Share, in the words the sheet shows. `promise.reject(code,
 * description)` reaches JavaScript as "share_failed: undefined reason",
 * because Expo builds the message from `reason`, which only a subclass sets —
 * the same trap as TunnelException, found here by the pre-release docs pass.
 */
final class DocumentException: Exception, @unchecked Sendable {
  private let failure: String
  private let message: String
  init(_ code: String, _ message: String) {
    failure = code
    self.message = message
    super.init()
    name = code
  }
  override var reason: String { message }
  override var code: String { failure }
}
final class ShahiPDFView: ExpoView, PDFViewDelegate {
  private let pdf = PDFView()
  let onLoadError = EventDispatcher()
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    pdf.autoScales = true
    pdf.displayMode = .singlePageContinuous
    pdf.displayDirection = .vertical
    pdf.delegate = self
    addSubview(pdf)
  }
  // A previewed PDF is untrusted: an agent may have downloaded it from
  // anywhere. Without a delegate, PDFView hands every link annotation's URL
  // to the system, so a tap opened whatever its author chose — another app's
  // scheme, a phishing page, a pairing link (pre-release review). The web
  // preview renders pages to a canvas and follows no links; this matches it.
  // Links inside the document are destinations, not URLs, and still work.
  func pdfViewWillClick(onLink sender: PDFView, with url: URL) {}
  override func layoutSubviews() { super.layoutSubviews(); pdf.frame = bounds }
  func load(_ value: String) {
    guard let data = Data(base64Encoded: value.padding(toLength: ((value.count + 3) / 4) * 4, withPad: "=", startingAt: 0)), data.count <= 25 * 1024 * 1024,
          let document = PDFDocument(data: data), !document.isLocked else {
      pdf.document = nil
      onLoadError(["message": "This PDF cannot be previewed. Save it to open in another app."])
      return
    }
    pdf.document = document
  }
}
