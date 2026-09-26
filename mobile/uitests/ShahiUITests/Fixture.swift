import CryptoKit
import XCTest

/// The encrypted recording fixtures these tests pair with: `e2e/hosted/server.ts`,
/// a relay and a box in one process, whose every write ends at the recording
/// stub. Nothing here reaches herdr or a real computer.
///
/// The ports come from `SHAHI_FIXTURE_PORT` and `SHAHI_SECOND_FIXTURE_PORT`
/// (run.sh passes them through), defaulting to 7572 and 7672 — which the
/// hosted Playwright configs also bind, so a run beside those needs others.
enum Fixture {
    static let primary = port("SHAHI_FIXTURE_PORT", 7572)
    static let secondary = port("SHAHI_SECOND_FIXTURE_PORT", 7672)

    private static func port(_ name: String, _ fallback: Int) -> Int {
        ProcessInfo.processInfo.environment[name].flatMap { Int($0) } ?? fallback
    }

    /// Calls a `/__hosted/*` control route and returns its JSON.
    @discardableResult
    static func call(_ port: Int, _ path: String, method: String = "POST", body: [String: Any]? = nil, prefix: String = "__hosted") throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/\(prefix)/\(path)")!)
        request.httpMethod = method
        request.timeoutInterval = 10
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let done = DispatchSemaphore(value: 0)
        var result: Result<Data, Error> = .failure(URLError(.timedOut))
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) }
            else if (response as? HTTPURLResponse)?.statusCode == 200, let data { result = .success(data) }
            else { result = .failure(URLError(.badServerResponse)) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 15)
        return try JSONSerialization.jsonObject(with: result.get()) as! [String: Any]
    }

    /// The prompt texts the fixture's stub recorded, in order.
    static func promptTexts(_ port: Int) throws -> [String] {
        let writes = try call(port, "writes", method: "GET")["writes"] as! [[String: Any]]
        return writes.compactMap { ($0["body"] as? [String: Any])?["text"] as? String }
    }

    /// The id the app files a relay computer under: SHA-256 of `["relay", serverId]`.
    static func computerID(pairingCode code: String) -> String {
        let fields = URLComponents(string: "https://fixture.invalid/?" + code.components(separatedBy: "#")[1])!.queryItems!
        let serverID = fields.first(where: { $0.name == "server" })!.value!
        let identity = try! JSONSerialization.data(withJSONObject: ["relay", serverID], options: [.fragmentsAllowed])
        return SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
    }
}

/// Getting the app from whatever state the previous test left it in to the
/// one the next test needs. Every test starts from here: XCTest runs a class's
/// tests alphabetically, and a test that assumed onboarding failed whenever an
/// earlier one had left the app paired (September 2026 review).
extension XCUIApplication {
    private var atRest: Bool {
        buttons["intro-continue"].exists || buttons["add-computer"].exists || buttons["switch-server"].exists
            || tabBars.buttons["Settings"].exists
    }

    /// Waits for one of the app's resting places: onboarding, the saved
    /// computers, a computer that cannot be reached, or the tabs. A test that
    /// ended inside a pane leaves it pushed over the tab bar, so back out first.
    func settle(file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline {
            if atRest { return }
            let back = navigationBars.buttons.matching(NSPredicate(format: "identifier == 'BackButton' OR label == 'Back'")).firstMatch
            if back.exists && back.isHittable { back.tap() } else { Thread.sleep(forTimeInterval: 0.5) }
        }
        XCTFail("the app never reached onboarding, its saved computers or its tabs", file: file, line: line)
    }

    /// Opens the Computers screen from the tabs.
    func openComputers(file: StaticString = #filePath, line: UInt = #line) {
        tabBars.buttons["Settings"].tap()
        let row = buttons.matching(NSPredicate(format: "label CONTAINS 'Computers'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), file: file, line: line)
        row.tap()
        XCTAssertTrue(buttons["add-computer"].waitForExistence(timeout: 10), file: file, line: line)
    }

    /// Taps Add a computer, scrolled clear of the floating tab bar.
    func tapAddComputer() {
        let button = buttons["add-computer"]
        for _ in 0..<8 {
            if button.exists && button.isHittable && button.frame.midY < frame.height - 120 { break }
            swipeUp()
        }
        button.tap()
    }

    /// Opens pairing from wherever the app is, keeping every saved computer:
    /// the tests that pair a second computer rely on the first staying.
    func beginPairing(file: StaticString = #filePath, line: UInt = #line) {
        settle(file: file, line: line)
        if buttons["intro-continue"].exists { return }
        if buttons["switch-server"].exists { buttons["switch-server"].tap() }
        if !buttons["add-computer"].waitForExistence(timeout: 5) { openComputers(file: file, line: line) }
        tapAddComputer()
        XCTAssertTrue(buttons["intro-continue"].waitForExistence(timeout: 15), file: file, line: line)
    }

    /// Signs out of every saved computer, back to onboarding with nothing
    /// saved: for a test whose ending depends on there being no other
    /// computer, such as revocation returning to onboarding.
    func signOutEverywhere(file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<8 {
            settle(file: file, line: line)
            if buttons["intro-continue"].exists { return }
            if buttons["switch-server"].exists {
                // A computer that cannot be reached: its way out is the saved computers.
                buttons["switch-server"].tap()
                continue
            }
            if buttons["add-computer"].exists {
                // The saved computers with none chosen: choose one, then sign out of it.
                let saved = buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'computer-'")).firstMatch
                XCTAssertTrue(saved.exists, "saved computers listed without a computer", file: file, line: line)
                saved.tap()
                _ = tabBars.buttons["Settings"].waitForExistence(timeout: 20)
                continue
            }
            tabBars.buttons["Settings"].tap()
            let signOut = buttons.matching(NSPredicate(format: "label CONTAINS 'Sign out'")).firstMatch
            for _ in 0..<6 {
                if signOut.exists && signOut.isHittable && signOut.frame.midY < frame.height - 120 { break }
                swipeUp()
            }
            signOut.tap()
            alerts.buttons["Sign out"].tap()
            _ = buttons["intro-continue"].waitForExistence(timeout: 20)
        }
        XCTAssertTrue(buttons["intro-continue"].exists, "could not sign out of every saved computer", file: file, line: line)
    }

    /// Pairs with the fixture on `port` from the pairing screen and returns the
    /// computer id. `prepare` runs after the fixture is reset and before its
    /// code is opened.
    @discardableResult
    func pair(_ port: Int, prepare: () throws -> Void = {}, file: StaticString = #filePath, line: UInt = #line) throws -> String {
        XCTAssertTrue(buttons["intro-continue"].waitForExistence(timeout: 15), file: file, line: line)
        let code = try Fixture.call(port, "reset")["code"] as! String
        try prepare()
        XCUIDevice.shared.system.open(URL(string: code)!)
        let confirm = buttons["confirm-pair"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 30), "the pairing code never opened its confirmation", file: file, line: line)
        XCTAssertTrue(staticTexts["127.0.0.1:\(port)"].exists, "must only pair with the recording fixture", file: file, line: line)
        confirm.tap()
        XCTAssertTrue(tabBars.buttons["Settings"].waitForExistence(timeout: 30), "pairing did not reach the tabs", file: file, line: line)
        return Fixture.computerID(pairingCode: code)
    }
}
