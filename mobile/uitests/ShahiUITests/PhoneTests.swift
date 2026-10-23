import XCTest

/// Checks only a physical iPhone can answer, run by run-phone.sh against a
/// disposable computer it starts on the Mac and reaches through Shahi's relay.
/// The phone is someone's own: these tests keep its saved computers, add the
/// disposable one, revoke only that one and return to the computer that was
/// open. They never use `signOutEverywhere`, and screenshots are taken of the
/// disposable computer's terminal only.
final class PhoneTests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment

    override func setUpWithError() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("PhoneTests run on a physical iPhone, through run-phone.sh")
        #else
        continueAfterFailure = false
        #endif
    }

    private func required(_ name: String) throws -> String {
        guard let value = env[name], !value.isEmpty else { throw XCTSkip("\(name) is not set; run through run-phone.sh") }
        return value
    }

    /// Installs the TestFlight build named by SHAHI_PHONE_BUILD, so the checks
    /// below run on the build about to ship rather than whatever the phone had.
    func testInstallsTheTestFlightBuild() throws {
        let build = try required("SHAHI_PHONE_BUILD")
        let testFlight = XCUIApplication(bundleIdentifier: "com.apple.TestFlight")
        XCUIDevice.shared.system.open(URL(string: "itms-beta://beta.itunes.apple.com/v1/app/6813370698")!)
        XCTAssertTrue(testFlight.wait(for: .runningForeground, timeout: 30), "TestFlight did not open")
        let offered = testFlight.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "(\(build))")).firstMatch
        XCTAssertTrue(offered.waitForExistence(timeout: 30), "TestFlight does not offer build \(build): \(Self.controls(testFlight))")
        let open = testFlight.buttons.matching(NSPredicate(format: "label ==[c] 'Open'")).firstMatch
        let install = testFlight.buttons.matching(NSPredicate(format: "label ==[c] 'Install' OR label ==[c] 'Update'")).firstMatch
        if install.waitForExistence(timeout: 10) {
            install.tap()
            // Replacing an App Store copy asks first.
            let confirm = testFlight.alerts.buttons.matching(NSPredicate(format: "label ==[c] 'Install' OR label ==[c] 'Continue'")).firstMatch
            if confirm.waitForExistence(timeout: 5) { confirm.tap() }
        }
        XCTAssertTrue(open.waitForExistence(timeout: 900), "build \(build) did not finish installing: \(Self.controls(testFlight))")
    }

    /// The Screen of an 89-row, 171-column terminal, the size of a laptop
    /// running herdr full screen: it must scroll both ways and sideways. The
    /// simulator found it stuck in October 2026 (b799745, 0284d28); this is
    /// the same check where it matters, by finger-sized swipes on glass.
    func testScreenScrollsATallTerminal() throws {
        let code = try required("SHAHI_PHONE_PAIR_CODE")
        let pane = try required("SHAHI_PHONE_PANE")
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        dismissBetaWelcome()
        let previous = openComputer(app)
        // A pairing link opens its confirmation from anywhere in the app, so
        // the test does not go through Add a computer.
        open(code)
        let confirm = app.buttons["confirm-pair"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 30), "the pairing code never opened its confirmation")
        confirm.tap()
        let scratch = Fixture.computerID(pairingCode: code)
        addTeardownBlock { self.forget(app, scratch, returningTo: previous) }
        XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 30), "pairing did not reach the tabs")

        // A shell is listed under the Shells filter, whose chip has only its
        // words, so the pane is opened by the route the app itself pushes.
        let paneID = pane.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        open("shahi://pane/\(paneID)?computer=\(scratch)&view=screen")
        let screenTab = app.buttons["view-screen"]
        XCTAssertTrue(screenTab.waitForExistence(timeout: 30), "the disposable computer's pane did not open")
        if !screenTab.isSelected { screenTab.tap() }
        let terminal = app.descendants(matching: .any).matching(identifier: "terminal-down").firstMatch
        XCTAssertTrue(terminal.waitForExistence(timeout: 30), "Screen showed no terminal")
        Thread.sleep(forTimeInterval: 3)

        // Two pictures with nothing done between them must match, or a
        // changed picture below would prove nothing about scrolling.
        let opened = picture(terminal, "1 opened, expected at the bottom with the prompt")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(picture(terminal, nil), opened, "the terminal kept changing on its own")
        terminal.swipeDown(); terminal.swipeDown()
        Thread.sleep(forTimeInterval: 1.5)
        let earlier = picture(terminal, "2 after two swipes down, earlier rows")
        XCTAssertNotEqual(earlier, opened, "swiping down did not move the Screen")
        terminal.swipeUp(); terminal.swipeUp(); terminal.swipeUp()
        Thread.sleep(forTimeInterval: 1.5)
        let later = picture(terminal, "3 after three swipes up, back at the bottom")
        XCTAssertNotEqual(later, earlier, "swiping up did not move the Screen")
        terminal.swipeLeft()
        Thread.sleep(forTimeInterval: 1.5)
        let across = picture(terminal, "4 after a swipe left, the right of the rows")
        XCTAssertNotEqual(across, later, "swiping sideways did not move the Screen")
    }

    /// PNG bytes of the element, attached to the result under `name` if given.
    private func picture(_ element: XCUIElement, _ name: String?) -> Data {
        let shot = element.screenshot()
        if let name {
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        return shot.pngRepresentation
    }

    /// A beta's first launch after a TestFlight install shows TestFlight's
    /// "Share Feedback" welcome over the app, drawn by StoreKit's service; it
    /// took every tap of the first phone runs (23 October 2026), so neither
    /// Add a computer nor Pair with this computer reached Shahi.
    private func dismissBetaWelcome() {
        let storeKit = XCUIApplication(bundleIdentifier: "com.apple.ios.StoreKitUIService")
        let next = storeKit.buttons.matching(NSPredicate(format: "label ==[c] 'Continue' OR label ==[c] 'Done' OR label ==[c] 'Got It'")).firstMatch
        // Asking a service that has closed fails the test ("Error getting
        // main window"), so each page is looked for only while it is showing.
        for _ in 0..<4 {
            Thread.sleep(forTimeInterval: 1)
            guard storeKit.state == .runningForeground, next.exists else { return }
            next.tap()
        }
    }

    /// Opens a link as the system would, accepting iOS's offer to open it in
    /// Shahi if it asks. Only that offer's Open is pressed: any other system
    /// alert on someone's phone is theirs to answer.
    private func open(_ link: String) {
        XCUIDevice.shared.system.open(URL(string: link)!)
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons
            .matching(NSPredicate(format: "label ==[c] 'Open'")).firstMatch
        if allow.waitForExistence(timeout: 2) { allow.tap() }
    }

    /// Opens the Computers screen by the app's own link. `openComputers`
    /// finds Settings' row by its English words, which change with the
    /// interface language a phone's owner chose; the link does not.
    private func showComputers(_ app: XCUIApplication) {
        if app.buttons["add-computer"].exists { return }
        open("shahi://computers")
        XCTAssertTrue(app.buttons["add-computer"].waitForExistence(timeout: 15), "the Computers screen did not open")
    }

    /// A pairing card left by an earlier run names a computer that run-phone.sh
    /// has since removed, and is not one of the places `settle` waits for.
    private func cancelPairing(_ app: XCUIApplication) {
        let cancel = app.buttons["confirm-cancel"]
        if cancel.waitForExistence(timeout: 2) { cancel.tap() }
    }

    /// The identifier of the computer the app has open, read from the
    /// Computers screen; nil when nothing is saved.
    private func openComputer(_ app: XCUIApplication) -> String? {
        cancelPairing(app)
        app.settle()
        if app.buttons["intro-continue"].exists { return nil }
        if app.buttons["switch-server"].exists { app.buttons["switch-server"].tap() }
        showComputers(app)
        return app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'computer-'")).allElementsBoundByIndex
            .first { !$0.identifier.hasPrefix("computer-actions-") && $0.isSelected }?.identifier
    }

    /// Revokes the disposable computer, and only it, then reopens the one
    /// that was open before. Runs however the test ended.
    private func forget(_ app: XCUIApplication, _ computer: String, returningTo previous: String?) {
        app.activate()
        cancelPairing(app)
        app.settle()
        if app.buttons["switch-server"].exists { app.buttons["switch-server"].tap() }
        showComputers(app)
        let more = app.buttons["computer-actions-\(computer)"]
        for _ in 0..<6 where !(more.exists && more.isHittable) { app.swipeUp() }
        guard more.exists else { return }
        more.tap()
        let revoke = app.buttons["revoke-computer-\(computer)"]
        XCTAssertTrue(revoke.waitForExistence(timeout: 5), "could not revoke the disposable computer; remove it in Settings, Computers")
        revoke.tap()
        // The confirmation's words follow the phone's language.
        app.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Revoke access", "Revocar acceso", "إلغاء صلاحية الوصول"])).firstMatch.tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: more)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 15), .completed, "the disposable computer is still saved")
        guard let previous else { return }
        let card = app.buttons[previous]
        for _ in 0..<6 where !(card.exists && card.isHittable) { app.swipeDown() }
        if card.exists && !card.isSelected { card.tap() }
    }

    /// The buttons and version-like texts of an app, for a failure message;
    /// never the rest of what another app shows.
    private static func controls(_ app: XCUIApplication) -> String {
        let buttons = app.buttons.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }.prefix(20)
        let versions = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { $0.contains("(") && $0.contains(")") }.prefix(10)
        return "buttons \(Array(buttons)), versions \(Array(versions))"
    }
}
