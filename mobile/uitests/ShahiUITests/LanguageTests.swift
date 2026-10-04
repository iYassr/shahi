import XCTest

/// An isolated simulator and recording fixture only. Every draft remains unsent.
final class LanguageTests: XCTestCase {
  func shot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }

  func select(_ language: String, in app: XCUIApplication) {
    let button = app.descendants(matching: .any)["language-\(language)"]
    for _ in 0..<8 {
      if button.exists && button.isHittable { button.tap(); return }
      app.swipeUp()
    }
    XCTFail("The language choice must remain reachable in Settings.")
  }

  func testLanguagesPreserveConversationAndDraft() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
    app.activate()
    // Revocation returns this disposable fixture pair to onboarding, including
    // when a preceding language run stopped before restoring English.
    try Fixture.call(Fixture.primary, "revoke")
    XCTAssertTrue(app.buttons["intro-continue"].waitForExistence(timeout: 30))
    XCTAssertTrue(app.descendants(matching: .any)["language-en"].waitForExistence(timeout: 15), "start from the isolated simulator's onboarding")
    app.descendants(matching: .any)["language-en"].tap()
    app.descendants(matching: .any)["language-ar"].tap()
    XCTAssertTrue(app.staticTexts["توصيل الكمبيوتر"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'لم يعد هذا الهاتف'")).firstMatch.exists, "the existing access-ended notice follows a language change")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'ألصق هذين السطرين'")).firstMatch.exists, "React Compiler must see the locale dependency for composed authored copy")
    XCTAssertTrue(app.staticTexts["herdr plugin install iYassr/shahi"].exists, "commands remain original")
    shot(app, "Arabic onboarding")
    app.descendants(matching: .any)["language-es"].tap()
    XCTAssertTrue(app.staticTexts["Conecta tu equipo"].waitForExistence(timeout: 10))
    shot(app, "Spanish onboarding")
    app.descendants(matching: .any)["language-en"].tap()
    try app.pair(Fixture.primary)
    let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-' AND label CONTAINS 'Convert PDF'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    row.tap()
    let composer = app.textViews.firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 15))
    composer.tap(); composer.typeText("language-test-unsent-draft")
    app.navigationBars.buttons.firstMatch.tap()
    app.tabBars.buttons["Settings"].tap()
    select("ar", in: app)
    XCTAssertTrue(app.staticTexts["اللغة"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.navigationBars["الإعدادات"].waitForExistence(timeout: 10), "native navigation titles update in place")
    shot(app, "Arabic Settings")
    app.tabBars.buttons["الوكلاء"].tap()
    XCTAssertTrue(row.waitForExistence(timeout: 15), "agent conversation titles stay original")
    row.tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 15))
    XCTAssertEqual(composer.value as? String, "language-test-unsent-draft", "changing language must not clear a draft")
    try Fixture.call(Fixture.primary, "offline")
    XCTAssertTrue(app.staticTexts["الكمبيوتر غير متصل"].waitForExistence(timeout: 20), "connection health follows the selected language")
    app.navigationBars.buttons.firstMatch.tap()
    app.tabBars.buttons["الإعدادات"].tap()
    select("es", in: app)
    XCTAssertTrue(app.navigationBars["Ajustes"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Equipo desconectado"].waitForExistence(timeout: 10), "the same connection notice changes language without changing its error")
    shot(app, "Spanish Settings")
    try Fixture.call(Fixture.primary, "online")
    app.tabBars.buttons["Agentes"].tap()
    XCTAssertTrue(row.waitForExistence(timeout: 15))
    row.tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 15))
    XCTAssertEqual(composer.value as? String, "language-test-unsent-draft")
    app.navigationBars.buttons.firstMatch.tap()
    app.tabBars.buttons["Ajustes"].tap()
    select("en", in: app)
    app.tabBars.buttons["Agents"].tap()
  }
}
