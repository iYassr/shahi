import XCTest

/// Start e2e/hosted/server.ts on 7572. Use a dedicated simulator: this test
/// signs out before pairing. Writes terminate at the recording stub.
final class ReleaseSmokeTests: XCTestCase {
    private func fixture(_ path: String, method: String = "POST") throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:7572/__hosted/" + path)!)
        request.httpMethod = method
        let done = expectation(description: path)
        var result: Result<Data, Error>?
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error { result = .failure(error) }
            else if (response as? HTTPURLResponse)?.statusCode == 200, let data = data { result = .success(data) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try JSONSerialization.jsonObject(with: XCTUnwrap(result).get()) as! [String: Any]
    }

    func testPairReadSendAndResume() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        if !app.buttons["intro-continue"].exists && !app.buttons["confirm-pair"].exists {
            for _ in 0..<4 {
                if app.tabBars.buttons["Settings"].exists { break }
                let back = app.navigationBars.buttons.firstMatch
                if back.exists { back.tap() }
            }
            app.tabBars.buttons["Settings"].tap()
            let signOut = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Sign out'")).firstMatch
            for _ in 0..<6 {
                if signOut.exists && signOut.isHittable { break }
                app.swipeUp()
            }
            signOut.tap()
            app.alerts.buttons["Sign out"].tap()
            XCTAssertTrue(app.buttons["intro-continue"].waitForExistence(timeout: 60))
        }
        let code = try fixture("reset")["code"] as! String
        XCUIDevice.shared.system.open(URL(string: code)!)
        let confirm = app.buttons["confirm-pair"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 20), "open the isolated fixture pairing code first")
        XCTAssertTrue(app.staticTexts["127.0.0.1:7572"].exists, "must only pair with the recording fixture")
        confirm.tap()
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
        let latest = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '↓'")).firstMatch
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
        _ = try fixture("disconnect")
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
            writes = try fixture("writes", method: "GET")["writes"] as! [[String: Any]]
            if writes.count >= 2 { break }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual((writes.last?["body"] as? [String: Any])?["text"] as? String, "release-smoke-after-reconnect")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.lifetime = .keepAlways
        add(shot)
        _ = try fixture("revoke")
        XCTAssertTrue(app.buttons["intro-continue"].waitForExistence(timeout: 15), "revocation must return to onboarding")
    }
}
