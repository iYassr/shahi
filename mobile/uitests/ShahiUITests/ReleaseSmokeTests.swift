import XCTest

/// Start e2e/hosted/server.ts on `Fixture.primary`. Use a dedicated simulator:
/// this test signs out of every saved computer first, because it ends by
/// proving that revoking the only computer returns to onboarding. Writes
/// terminate at the recording stub.
final class ReleaseSmokeTests: XCTestCase {
    func testPairReadSendAndResume() throws {
        continueAfterFailure = false
        let port = Fixture.primary
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.signOutEverywhere()
        try app.pair(port)
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-' AND label CONTAINS 'Convert PDF'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "pairing did not reach the dashboard")
        app.tabBars.buttons["Spaces"].tap()
        app.tabBars.buttons["Agents"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let reader = app.buttons["view-read"]
        XCTAssertTrue(reader.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Message 140:'")).firstMatch.waitForExistence(timeout: 15), "the actual transcript must render, not just its empty-state shell")
        for _ in 0..<3 {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        // By identifier: the pill's accessibility label is "Go to latest", which
        // replaced the "Latest ↓" this matched until the September 2026 review
        // found the test could no longer pass.
        let latest = app.descendants(matching: .any)["go-to-latest"]
        XCTAssertTrue(latest.waitForExistence(timeout: 10), "scrolling must leave following mode")
        app.buttons["view-screen"].tap()
        reader.tap()
        XCTAssertTrue(latest.exists, "screen toggle must keep reading position")
        app.navigationBars.buttons.firstMatch.tap()
        row.tap()
        XCTAssertTrue(latest.waitForExistence(timeout: 10), "reopening must keep reading position")
        latest.tap()
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText("release-smoke-synthetic-reply")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["release-smoke-synthetic-reply"].waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(reader.waitForExistence(timeout: 15), "foreground resume lost the pane")
        try Fixture.call(port, "disconnect")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        composer.tap()
        composer.typeText("release-smoke-after-reconnect")
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts["release-smoke-after-reconnect"].waitForExistence(timeout: 15))
        // Echo alone does not prove delivery. Check the fixture's recorded
        // writes, including absence of a duplicate after reconnect.
        var writes: [[String: Any]] = []
        for _ in 0..<20 {
            writes = try Fixture.call(port, "writes", method: "GET")["writes"] as! [[String: Any]]
            if writes.count >= 2 { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual((writes.last?["body"] as? [String: Any])?["text"] as? String, "release-smoke-after-reconnect")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.lifetime = .keepAlways
        add(shot)
        try Fixture.call(port, "revoke")
        XCTAssertTrue(app.buttons["intro-continue"].waitForExistence(timeout: 15), "revocation must return to onboarding")
    }
}
