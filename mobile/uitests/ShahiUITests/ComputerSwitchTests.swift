import XCTest
import CryptoKit

/// Two isolated encrypted fixtures on 7572 and 7672; neither reaches herdr.
final class ComputerSwitchTests: XCTestCase {
    private var computerIDs: [Int: String] = [:]
    private func fixture(_ port: Int, _ path: String, method: String = "POST") throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/__hosted/\(path)")!)
        request.httpMethod = method
        let done = expectation(description: path)
        var data: Data?
        URLSession.shared.dataTask(with: request) { body, _, _ in data = body; done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
        return try JSONSerialization.jsonObject(with: XCTUnwrap(data)) as! [String: Any]
    }
    private func pair(_ app: XCUIApplication, _ port: Int) throws {
        XCTAssertTrue(app.buttons["intro-continue"].waitForExistence(timeout: 15))
        let code = try fixture(port, "reset")["code"] as! String
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
        computers(app); app.buttons["add-computer"].tap()
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
        if app.buttons["add-computer"].exists { app.buttons["add-computer"].tap() }
        else if app.tabBars.buttons["Settings"].exists { computers(app); app.buttons["add-computer"].tap() }
        try pair(app, 7572)
        computers(app); app.buttons["add-computer"].tap()
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
        XCTAssertTrue(switchServer.waitForExistence(timeout: 20))
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

}
