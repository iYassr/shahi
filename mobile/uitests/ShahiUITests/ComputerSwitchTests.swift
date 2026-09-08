import XCTest
import CryptoKit

/// Two isolated encrypted fixtures on 7572 and 7672; neither reaches herdr.
final class ComputerSwitchTests: XCTestCase {
    private var computerIDs: [Int: String] = [:]
    private func fixture(_ port: Int, _ path: String, method: String = "POST", body: [String: Any]? = nil) throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/__hosted/\(path)")!)
        request.httpMethod = method
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let done = expectation(description: path)
        var data: Data?
        URLSession.shared.dataTask(with: request) { body, _, _ in data = body; done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
        return try JSONSerialization.jsonObject(with: XCTUnwrap(data)) as! [String: Any]
    }
    private func pair(_ app: XCUIApplication, _ port: Int, update: Bool = false) throws {
        XCTAssertTrue(app.buttons["intro-continue"].waitForExistence(timeout: 15))
        let code = try fixture(port, "reset")["code"] as! String
        if update {
            _ = try fixture(port, "control", body: [
                "control": 1, "serverId": "fixture", "buildId": "old", "api": ["min": 5, "max": 5],
                "capabilities": ["sessions", "computer-updates", "device-revocation"],
                "backend": ["state": "connected", "version": "0.9.0", "protocol": 22],
                "update": ["managed": true, "channel": "stable", "phase": "available", "current": "0.3.0", "available": "0.3.1"]
            ])
        }
        let fields = URLComponents(string: "https://fixture.invalid/?" + code.components(separatedBy: "#")[1])!.queryItems!
        let serverID = fields.first(where: { $0.name == "server" })!.value!
        let identity = try JSONSerialization.data(withJSONObject: ["relay", serverID], options: [.fragmentsAllowed])
        computerIDs[port] = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        XCUIDevice.shared.system.open(URL(string: code)!)
        XCTAssertTrue(app.buttons["confirm-pair"].waitForExistence(timeout: 30))
        app.buttons["confirm-pair"].tap()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 30))
    }
    private func computers(_ app: XCUIApplication) {
        app.tabBars.buttons["Settings"].tap()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Computers'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        XCTAssertTrue(app.buttons["add-computer"].waitForExistence(timeout: 10))
    }
    private func addComputer(_ app: XCUIApplication) {
        let button = app.buttons["add-computer"]
        for _ in 0..<8 {
            if button.exists && button.isHittable && button.frame.midY < app.frame.height - 120 { break }
            app.swipeUp()
        }
        button.tap()
    }
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
        try pair(app, 7572)
        computers(app); addComputer(app)
        XCTAssertTrue(app.buttons["saved-computers"].waitForExistence(timeout: 10))
        try pair(app, 7672)
        computers(app); choose(app, 7572)
        send(app, "switch-check-a")
        computers(app); choose(app, 7672)
        send(app, "switch-check-b")
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 40))
        computers(app)
        let current = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'computer-' AND label CONTAINS 'Current computer' AND label CONTAINS ':7672'")).firstMatch
        XCTAssertTrue(current.waitForExistence(timeout: 10))
        choose(app, 7572)
        send(app, "switch-check-a-again")
        let a = try fixture(7572, "writes", method: "GET")["writes"] as! [[String: Any]]
        let b = try fixture(7672, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertEqual(a.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }, ["switch-check-a", "switch-check-a-again"])
        XCTAssertEqual(b.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }, ["switch-check-b"])
        computers(app)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }
    func testOfflineComputerCanBeSwitchedWithoutSigningOut() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["add-computer"].exists || app.tabBars.buttons["Settings"].exists || app.buttons["intro-continue"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 40), .completed)
        // The existing simulator may have a saved connection. Use the product's
        // Add flow so the new pairing is an explicit choice.
        if app.buttons["switch-server"].exists { app.buttons["switch-server"].tap() }
        if app.buttons["add-computer"].exists { addComputer(app) }
        else if app.tabBars.buttons["Settings"].exists { computers(app); addComputer(app) }
        try pair(app, 7572)
        computers(app); addComputer(app)
        try pair(app, 7672)
        _ = try fixture(7672, "offline")
        let bannerSwitch = app.buttons["switch-computer"]
        XCTAssertTrue(app.staticTexts["Computer disconnected"].waitForExistence(timeout: 20))
        app.swipeDown()
        XCTAssertTrue(bannerSwitch.waitForExistence(timeout: 20))
        bannerSwitch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        choose(app, 7572)
        send(app, "offline-switch-a")
        computers(app); choose(app, 7672)
        let switchServer = app.buttons["switch-server"]
        XCTAssertTrue(app.staticTexts["Computer disconnected"].waitForExistence(timeout: 20))
        app.terminate(); app.launch()
        XCTAssertTrue(switchServer.waitForExistence(timeout: 40)); switchServer.tap()
        // Both records must remain after using the offline Switch server action.
        XCTAssertTrue(app.buttons["computer-" + computerIDs[7572]!].exists)
        XCTAssertTrue(app.buttons["computer-" + computerIDs[7672]!].exists)
        choose(app, 7572)
        _ = try fixture(7672, "online")
        _ = try fixture(7572, "revoke")
        XCTAssertTrue(app.buttons["add-computer"].waitForExistence(timeout: 20), "revocation must open the remaining saved computers")
        XCTAssertFalse(app.buttons["intro-continue"].exists)
        choose(app, 7672)
        send(app, "after-other-computer-revoked")
        let writes = try fixture(7672, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertEqual(writes.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }, ["after-other-computer-revoked"])
    }

    func testAllComputersStayLive() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["add-computer"].exists || app.tabBars.buttons["Settings"].exists || app.buttons["intro-continue"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 40), .completed)
        if app.buttons["switch-server"].exists { app.buttons["switch-server"].tap() }
        if app.buttons["add-computer"].exists { addComputer(app) }
        else if app.tabBars.buttons["Settings"].exists { computers(app); addComputer(app) }
        try pair(app, 7572)
        computers(app); addComputer(app)
        try pair(app, 7672)
        for port in [7572, 7672, 7572] {
            let trigger = app.buttons["computer-switcher"]
            XCTAssertTrue(trigger.waitForExistence(timeout: 15)); trigger.tap()
            let row = app.buttons["quick-computer-" + computerIDs[port]!]
            XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 15))
        }
        for port in [7572, 7672] {
            let counts = try fixture(port, "connections", method: "GET")
            XCTAssertEqual(counts["live"] as? Int, 1)
            XCTAssertEqual(counts["handshakes"] as? Int, 1, "Switching must reuse the encrypted connection")
        }
        computers(app)
        let revoke = app.buttons["revoke-computer-" + computerIDs[7672]!]
        for _ in 0..<6 { if revoke.exists && revoke.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(revoke.waitForExistence(timeout: 10)); revoke.tap()
        app.alerts.buttons["Revoke access"].tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: revoke)
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 15), .completed)
        XCTAssertEqual(try fixture(7672, "connections", method: "GET")["live"] as? Int, 0)
        XCTAssertEqual(try fixture(7672, "device-count", method: "GET")["count"] as? Int, 0)
        choose(app, 7572)
        send(app, "still-live-after-revoke")
        let remaining = try fixture(7572, "connections", method: "GET")
        XCTAssertEqual(remaining["live"] as? Int, 1)
        XCTAssertEqual(remaining["handshakes"] as? Int, 1)
        computers(app)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }

    func testComputerUpdatePreservesPairing() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.buttons["add-computer"].exists || app.tabBars.buttons["Settings"].exists || app.buttons["intro-continue"].exists || app.buttons["switch-server"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 40), .completed)
        if app.buttons["switch-server"].exists { app.buttons["switch-server"].tap() }
        if app.buttons["add-computer"].exists { addComputer(app) }
        else if app.tabBars.buttons["Settings"].exists { computers(app); addComputer(app) }
        try pair(app, 7572, update: true)
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
        XCTAssertEqual(try fixture(7572, "device-count", method: "GET")["count"] as? Int, 1)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["intro-continue"].exists)
        send(app, "after-computer-update")
        let writes = try fixture(7572, "writes", method: "GET")["writes"] as! [[String: Any]]
        XCTAssertEqual(writes.filter { $0["path"] as? String == "/api/control/update" }.count, 1)
        XCTAssertTrue(writes.contains { ($0["body"] as? [String: Any])?["text"] as? String == "after-computer-update" })
        app.tabBars.buttons["Settings"].tap()
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
    }

}
