import XCTest

/// Two isolated encrypted fixtures (`Fixture.primary`, `Fixture.secondary`);
/// neither reaches herdr. Every test pairs from whatever state the one before
/// it left, through `beginPairing`, so the class passes in XCTest's order.
final class ComputerSwitchTests: XCTestCase {
    private var computerIDs: [Int: String] = [:]
    private let primary = Fixture.primary
    private let secondary = Fixture.secondary
    private func fixture(_ port: Int, _ path: String, method: String = "POST", body: [String: Any]? = nil) throws -> [String: Any] {
        try Fixture.call(port, path, method: method, body: body)
    }
    private func pair(_ app: XCUIApplication, _ port: Int, update: Bool = false) throws {
        computerIDs[port] = try app.pair(port, prepare: {
            guard update else { return }
            _ = try self.fixture(port, "control", body: [
                "control": 1, "serverId": "fixture", "buildId": "old", "api": ["min": 5, "max": 5],
                "capabilities": ["sessions", "computer-updates", "device-revocation"],
                "backend": ["state": "connected", "version": "0.9.0", "protocol": 22],
                "update": ["managed": true, "channel": "stable", "phase": "available", "current": "0.3.0", "available": "0.3.1"]
            ])
        })
    }
    private func computers(_ app: XCUIApplication) { app.openComputers() }
    private func addComputer(_ app: XCUIApplication) { app.tapAddComputer() }
    private func choose(_ app: XCUIApplication, _ port: Int) {
        let row = app.buttons["computer-" + computerIDs[port]!]
        for _ in 0..<6 { if row.exists && row.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 20))
    }
    private func send(_ app: XCUIApplication, _ text: String) {
        app.tabBars.buttons["Agents"].tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-' AND label CONTAINS 'Convert PDF'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20)); row.tap()
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10)); composer.tap(); composer.typeText(text)
        app.buttons["Send"].tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10))
        app.navigationBars.buttons.firstMatch.tap()
    }
    func testSwitchBothWaysAndRestore() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.beginPairing()
        try pair(app, primary)
        computers(app); addComputer(app)
        XCTAssertTrue(app.buttons["saved-computers"].waitForExistence(timeout: 10))
        try pair(app, secondary)
        computers(app); choose(app, primary)
        send(app, "switch-check-a")
        computers(app); choose(app, secondary)
        send(app, "switch-check-b")
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 40))
        computers(app)
        let current = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'computer-' AND label CONTAINS 'Current computer' AND label CONTAINS %@", ":\(secondary)")).firstMatch
        XCTAssertTrue(current.waitForExistence(timeout: 10))
        choose(app, primary)
        send(app, "switch-check-a-again")
        let a = try fixture(primary, "writes", method: "GET")["writes"] as! [[String: Any]]
        let b = try fixture(secondary, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertEqual(a.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }, ["switch-check-a", "switch-check-a-again"])
        XCTAssertEqual(b.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }, ["switch-check-b"])
        computers(app)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }
    func testSilentNetworkLossAndColdOfflineLaunchRecover() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.beginPairing()
        try pair(app, primary)
        send(app, "before-network-loss")
        func waitForConnection(after count: Int) throws {
            for _ in 0..<150 {
                if (try fixture(primary, "connections", method: "GET")["handshakes"] as! Int) > count { return }
                Thread.sleep(forTimeInterval: 0.1)
            }
            XCTFail("The saved computer did not reconnect automatically")
        }
        for _ in 0..<2 {
            let before = try fixture(primary, "connections", method: "GET")["handshakes"] as! Int
            XCUIDevice.shared.press(.home)
            _ = try fixture(primary, "blackhole")
            app.activate()
            try waitForConnection(after: before)
        }
        send(app, "after-network-return")
        _ = try fixture(primary, "offline")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["switch-server"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["intro-continue"].exists)
        let before = try fixture(primary, "connections", method: "GET")["handshakes"] as! Int
        _ = try fixture(primary, "online")
        try waitForConnection(after: before)
        send(app, "after-offline-launch")
        let writes = try fixture(primary, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertEqual(writes.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }, ["before-network-loss", "after-network-return", "after-offline-launch"])
        XCTAssertEqual(try fixture(primary, "device-count", method: "GET")["count"] as? Int, 1)
    }
    func testOfflineComputerCanBeSwitchedWithoutSigningOut() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        // The existing simulator may have a saved connection. Use the product's
        // Add flow so the new pairing is an explicit choice.
        app.beginPairing()
        try pair(app, primary)
        computers(app); addComputer(app)
        try pair(app, secondary)
        _ = try fixture(secondary, "offline")
        let bannerSwitch = app.buttons["switch-computer"]
        XCTAssertTrue(app.staticTexts["Computer disconnected"].waitForExistence(timeout: 20))
        app.swipeDown()
        XCTAssertTrue(bannerSwitch.waitForExistence(timeout: 20))
        bannerSwitch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        choose(app, primary)
        send(app, "offline-switch-a")
        computers(app); choose(app, secondary)
        let switchServer = app.buttons["switch-server"]
        XCTAssertTrue(app.staticTexts["Computer disconnected"].waitForExistence(timeout: 20))
        app.terminate(); app.launch()
        XCTAssertTrue(switchServer.waitForExistence(timeout: 40)); switchServer.tap()
        // Both records must remain after using the offline Switch server action.
        XCTAssertTrue(app.buttons["computer-" + computerIDs[primary]!].exists)
        XCTAssertTrue(app.buttons["computer-" + computerIDs[secondary]!].exists)
        choose(app, primary)
        _ = try fixture(secondary, "online")
        _ = try fixture(primary, "revoke")
        XCTAssertTrue(app.buttons["add-computer"].waitForExistence(timeout: 20), "revocation must open the remaining saved computers")
        XCTAssertFalse(app.buttons["intro-continue"].exists)
        choose(app, secondary)
        send(app, "after-other-computer-revoked")
        let writes = try fixture(secondary, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertEqual(writes.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }, ["after-other-computer-revoked"])
    }

    func testAllComputersStayLive() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.beginPairing()
        try pair(app, primary)
        computers(app); addComputer(app)
        try pair(app, secondary)
        for port in [primary, secondary, primary] {
            let trigger = app.buttons["computer-switcher"]
            XCTAssertTrue(trigger.waitForExistence(timeout: 15)); trigger.tap()
            let row = app.buttons["quick-computer-" + computerIDs[port]!]
            XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        }
        for port in [primary, secondary] {
            let counts = try fixture(port, "connections", method: "GET")
            XCTAssertEqual(counts["live"] as? Int, 1)
            XCTAssertEqual(counts["handshakes"] as? Int, 1, "Switching must reuse the encrypted connection")
        }
        computers(app)
        let revoke = app.buttons["revoke-computer-" + computerIDs[secondary]!]
        for _ in 0..<6 { if revoke.exists && revoke.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(revoke.waitForExistence(timeout: 10)); revoke.tap()
        app.alerts.buttons["Revoke access"].tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: revoke)
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 15), .completed)
        XCTAssertEqual(try fixture(secondary, "connections", method: "GET")["live"] as? Int, 0)
        XCTAssertEqual(try fixture(secondary, "device-count", method: "GET")["count"] as? Int, 0)
        choose(app, primary)
        send(app, "still-live-after-revoke")
        let remaining = try fixture(primary, "connections", method: "GET")
        XCTAssertEqual(remaining["live"] as? Int, 1)
        XCTAssertEqual(remaining["handshakes"] as? Int, 1)
        computers(app)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }

    func testComputerUpdatePreservesPairing() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.beginPairing()
        try pair(app, primary, update: true)
        let update = app.buttons["Update computer"]
        XCTAssertTrue(update.waitForExistence(timeout: 15))
        // A restored list offset can put the header under the translucent
        // navigation bar. XCTest reports it hittable but the bar takes the tap.
        for _ in 0..<6 {
            if update.isHittable && update.frame.minY > app.navigationBars.firstMatch.frame.maxY + 8 { break }
            app.swipeDown()
        }
        update.tap()
        XCTAssertTrue(app.staticTexts["Restarting Shahi · reconnecting automatically…"].waitForExistence(timeout: 10))
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: update)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 20), .completed)
        XCTAssertEqual(try fixture(primary, "device-count", method: "GET")["count"] as? Int, 1)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["intro-continue"].exists)
        send(app, "after-computer-update")
        let writes = try fixture(primary, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertEqual(writes.filter { $0["path"] as? String == "/api/control/update" }.count, 1)
        XCTAssertTrue(writes.contains { ($0["body"] as? [String: Any])?["text"] as? String == "after-computer-update" })
        app.tabBars.buttons["Settings"].tap()
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }

}
