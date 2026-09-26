import XCTest

/// Run on the dedicated fixture simulator at default size and AX5. B17 drew
/// terminal width controls over Escape and sent a key instead of resizing.
final class TerminalWidthTests: XCTestCase {
    func testWidthControlsDoNotSendTerminalKeys() throws {
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.beginPairing()
        try app.pair(Fixture.primary)
        let tallScreen = (1...36).map { "Synthetic terminal row \($0)" }.joined(separator: "\n")
        try Fixture.call(Fixture.primary + 1, "scenario", body: ["patch": ["screens": ["w1:p2": tallScreen]]], prefix: "__stub")
        let row = app.buttons["row-w1:p2"]
        // AX5 may put it below the initial viewport and virtualization window.
        for _ in 0..<12 where !row.exists || !row.isHittable { app.swipeUp() }
        XCTAssertTrue(row.isHittable)
        row.tap()
        app.buttons["view-screen"].tap()
        let narrow = app.buttons["width-60"]
        XCTAssertTrue(narrow.waitForExistence(timeout: 10))
        XCTAssertTrue(narrow.isHittable)
        let escape = app.buttons["Escape"]
        XCTAssertTrue(escape.exists)
        XCTAssertFalse(narrow.frame.intersects(escape.frame), "width control overlaps the terminal key")
        narrow.tap()
        XCTAssertTrue(narrow.isSelected, "the tap did not select the narrower terminal")
        let writes = try Fixture.call(Fixture.primary, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertTrue(writes.isEmpty, "resizing the terminal sent input to the agent")
    }
}
