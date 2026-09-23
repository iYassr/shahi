import XCTest

/// Reading mode must keep your place. You scroll back up a Claude or codex
/// conversation to re-read something; glancing at the raw screen, or leaving
/// the pane and coming back, must not throw you to the newest message and make
/// you find your spot again by hand.
///
/// This pairs with the recording fixture (`Fixture.primary`) and reads its
/// 140-message conversation, "Convert PDF to markdown", whose messages carry
/// `message-long-<n>` ids. It used to need a real computer and a transcript
/// seeded by appending rows to a real `~/.claude` file; the September 2026
/// review moved it here, where it runs anywhere and touches nothing real. The
/// observable is content-independent: the "Go to latest" pill is present
/// exactly when you are away from the tail, so "place kept" is "still away
/// after coming back", and the message ids say whether it came back to the
/// *same* message, not merely a non-tail one.
final class ReaderPlaceTests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "app did not come to the foreground")
        // A fresh pairing every time: whatever an earlier test left, this one
        // starts on the fixture's Agents list at its default scenario.
        app.beginPairing()
        try app.pair(Fixture.primary)
    }

    private func byId(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
    private func drag(_ y0: CGFloat, _ y1: CGFloat) {
        let a = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y0))
        let b = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y1))
        a.press(forDuration: 0.05, thenDragTo: b)
    }
    /// The pill is present exactly when the reader is away from the newest message.
    private func awayFromTail() -> Bool { byId("go-to-latest").exists }

    /// The number of the topmost message on screen, below the navigation bar.
    private func topMessage() -> Int? {
        let top = app.navigationBars.firstMatch.frame.maxY
        let messages = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message-long-'"))
        var best: (y: CGFloat, n: Int)? = nil
        for message in messages.allElementsBoundByIndex {
            let frame = message.frame
            guard frame.minY >= top, frame.minY < app.frame.maxY, let n = Int(message.identifier.dropFirst("message-long-".count)) else { continue }
            if best == nil || frame.minY < best!.y { best = (frame.minY, n) }
        }
        return best?.n
    }

    /// Opens the long conversation in the reader, settled at its newest message.
    private func openReader() {
        let row = byId("row-w1:p2")
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the fixture's long conversation is not listed")
        row.tap()
        let read = byId("view-read")
        XCTAssertTrue(read.waitForExistence(timeout: 10), "the read/screen toggle never appeared")
        read.tap()
        XCTAssertTrue(byId("message-long-139").waitForExistence(timeout: 15), "the conversation never reached its newest message")
        Thread.sleep(forTimeInterval: 1.0)
    }

    /// Scrolls back up the conversation and returns the message at the top.
    private func scrollBack() throws -> Int {
        XCTAssertFalse(awayFromTail(), "the reader did not start at the newest message")
        for _ in 0..<5 { drag(0.30, 0.85) }
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertTrue(awayFromTail(), "scrolling up did not leave the tail")
        return try XCTUnwrap(topMessage(), "no message on screen after scrolling back")
    }

    // Note: this path is held by the overlay design — the reader's list is laid
    // *under* the terminal, never unmounted on a toggle — not by scrollMemory,
    // which is why disabling the restore does not break it. It guards against a
    // regression that goes back to unmounting the list on the read/screen flip.
    func testReaderKeepsItsPlaceAcrossTheScreenToggle() throws {
        openReader()
        let mark = try scrollBack()

        byId("view-screen").tap()
        byId("view-read").tap()
        Thread.sleep(forTimeInterval: 1.0)

        XCTAssertTrue(awayFromTail(), "the reader snapped back to the newest message across the screen toggle")
        let after = try XCTUnwrap(topMessage(), "no message on screen after the toggle")
        XCTAssertLessThanOrEqual(abs(after - mark), 2, "the reader came back at message \(after), not where it was left (\(mark))")
    }

    func testReaderKeepsItsPlaceAcrossLeavingThePane() throws {
        openReader()
        let mark = try scrollBack()

        // Leave the pane entirely and reopen it: the route unmounts the whole
        // screen, so only the remembered place survives.
        app.navigationBars.buttons.matching(NSPredicate(format: "identifier == 'BackButton' OR label == 'Back'")).firstMatch.tap()
        let row = byId("row-w1:p2")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "did not return to the list")
        row.tap()
        Thread.sleep(forTimeInterval: 1.2)

        XCTAssertTrue(awayFromTail(), "reopening the pane snapped the reader back to the newest message")
        let after = try XCTUnwrap(topMessage(), "no message on screen after reopening")
        XCTAssertLessThanOrEqual(abs(after - mark), 2, "reopening the pane landed at message \(after), not where it was left (\(mark))")
    }
}
