import XCTest

/// Reading mode must keep your place. You scroll back up a Claude or codex
/// conversation to re-read something; glancing at the raw screen, or leaving
/// the pane and coming back, must not throw you to the newest message and make
/// you find your spot again by hand.
///
/// This drives the app already paired on the booted simulator, reading a real
/// transcript over the relay. The observable is content-independent: the
/// "Latest ↓" pill shows exactly when you are away from the tail, so "place
/// kept" is "still away after coming back", and the numbered `MARK nnn`
/// markers in the seeded conversation let it check you came back to the *same*
/// message, not merely a non-tail one.
final class ReaderPlaceTests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")

    override func setUp() {
        continueAfterFailure = false
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "app did not come to the foreground")
        goToAgentsRoot()
    }

    private func byId(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }
    private func goToAgentsRoot() {
        for _ in 0..<4 {
            let back = app.navigationBars.buttons.firstMatch
            guard back.exists && back.isHittable else { break }
            back.tap()
        }
        let agents = app.tabBars.buttons["Agents"]
        if agents.waitForExistence(timeout: 5) { agents.tap() }
    }
    private func drag(_ y0: CGFloat, _ y1: CGFloat) {
        let a = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y0))
        let b = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y1))
        a.press(forDuration: 0.05, thenDragTo: b)
    }
    /// The pill is present exactly when the reader is away from the newest message.
    private func awayFromTail() -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '↓'")).firstMatch.exists
    }
    /// The number of the topmost visible `MARK nnn` marker, or nil if none.
    private func topMark() -> Int? {
        let sts = app.staticTexts
        var best: (CGFloat, Int)? = nil
        for i in 0..<sts.count {
            let e = sts.element(boundBy: i)
            let f = e.frame
            guard f.minY >= 118, f.minY <= 780, e.isHittable else { continue }
            guard let r = e.label.range(of: #"MARK (\d{3})"#, options: .regularExpression) else { continue }
            let num = Int(e.label[r].dropFirst(5)) ?? -1
            if best == nil || f.minY < best!.0 { best = (f.minY, num) }
        }
        return best?.1
    }

    /// Open the first agent pane and make sure the conversation reader is shown.
    private func openReader() {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'row-'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no agent rows to open")
        row.tap()
        let read = byId("view-read")
        XCTAssertTrue(read.waitForExistence(timeout: 8), "the read/screen toggle never appeared")
        read.tap()  // force the reader even if this pane was last left on the terminal
        // Land on the tail first, so the starting point is the same every run.
        Thread.sleep(forTimeInterval: 1.0)
        let pill = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '↓'")).firstMatch
        if pill.exists { pill.tap(); Thread.sleep(forTimeInterval: 0.8) }
    }

    // Note: this path is held by the overlay design — the reader's list is laid
    // *under* the terminal, never unmounted on a toggle — not by scrollMemory,
    // which is why disabling the restore does not break it. It guards against a
    // regression that goes back to unmounting the list on the read/screen flip.
    func testReaderKeepsItsPlaceAcrossTheScreenToggle() throws {
        openReader()
        XCTAssertFalse(awayFromTail(), "the reader did not start at the newest message")

        // Scroll back up the conversation.
        for _ in 0..<5 { drag(0.30, 0.85) }
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertTrue(awayFromTail(), "scrolling up did not leave the tail")
        guard let mark = topMark() else {
            throw XCTSkip("needs a pane whose transcript is long and carries MARK nnn markers — see README")
        }

        // Glance at the raw screen and back — this unmounts and remounts the reader.
        byId("view-screen").tap()
        byId("view-read").tap()
        Thread.sleep(forTimeInterval: 1.0)

        XCTAssertTrue(awayFromTail(),
                      "the reader snapped back to the newest message across the screen toggle")
        if let after = topMark() {
            XCTAssertLessThanOrEqual(abs(after - mark), 2,
                "the reader reopened at MARK \(after), not where it was left (MARK \(mark))")
        }
    }

    func testReaderKeepsItsPlaceAcrossLeavingThePane() throws {
        openReader()
        XCTAssertFalse(awayFromTail(), "the reader did not start at the newest message")

        for _ in 0..<5 { drag(0.30, 0.85) }
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertTrue(awayFromTail(), "scrolling up did not leave the tail")
        guard let mark = topMark() else {
            throw XCTSkip("needs a pane whose transcript is long and carries MARK nnn markers — see README")
        }

        // Leave the pane entirely and reopen it: the route unmounts the whole
        // screen, so only the remembered place survives.
        app.navigationBars.buttons.firstMatch.tap()
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'row-'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "did not return to the list")
        row.tap()
        Thread.sleep(forTimeInterval: 1.2)

        XCTAssertTrue(awayFromTail(),
                      "reopening the pane snapped the reader back to the newest message")
        if let after = topMark() {
            XCTAssertLessThanOrEqual(abs(after - mark), 2,
                "reopening the pane landed at MARK \(after), not where it was left (MARK \(mark))")
        }
    }
}
