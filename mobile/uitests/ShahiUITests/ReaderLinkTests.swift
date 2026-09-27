import XCTest

/// Plain URLs were still inert in TestFlight 19. Exercise the native text
/// responder, selection menu and browser handoff against synthetic output.
final class ReaderLinkTests: XCTestCase {
    func testBareURLCanBeCopiedAndOpened() throws {
        continueAfterFailure = false
        let port = Fixture.primary
        let url = "http://127.0.0.1:\(port)/reader-link-check?one=1&two=2"
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.signOutEverywhere()
        try app.pair(port) {
            try Fixture.call(port + 1, "scenario", body: [
                "patch": ["transcripts": ["w1:p2": [[
                    "id": "reader-url-regression", "role": "agent", "at": 1,
                    "blocks": [["kind": "text", "text": "Open this result: \(url)."]]
                ]]]]
            ], prefix: "__stub")
        }
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-' AND label CONTAINS 'Convert PDF'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let link = app.links[url]
        XCTAssertTrue(link.waitForExistence(timeout: 15), "the bare URL must be an accessible link")
        link.press(forDuration: 1.2)
        XCTAssertEqual(app.state, .runningForeground, "holding a URL must copy without opening the browser")

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "copied URL must be available to paste")
        paste.tap()
        XCTAssertEqual(composer.value as? String, url, "copy only the URL, excluding sentence punctuation")

        link.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "tapping the URL must open the browser")
        app.activate()
        XCTAssertTrue(link.waitForExistence(timeout: 10), "returning from the browser must preserve Reader")
    }
}
