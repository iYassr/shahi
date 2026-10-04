import XCTest

/// Compiled Release coverage for Reader questions and the terminal's current
/// answer controls. All writes end at the disposable encrypted recording fixture.
final class CodexQuestionTests: XCTestCase {
    private let paneID = "w1:p2"
    private let draft = "codex-question-unsent-draft"

    private func prepare(_ port: Int, prompt: [String: Any]? = nil) throws {
        var session = try Fixture.call(port + 1, "session", method: "GET", prefix: "api")
        var panes = session["panes"] as! [[String: Any]]
        for index in panes.indices where panes[index]["paneId"] as? String == paneID {
            panes[index]["title"] = "Codex question fixture"
            panes[index]["agent"] = "codex"
            panes[index]["status"] = prompt == nil ? "idle" : "blocked"
            panes[index]["hasPrompt"] = prompt != nil
            panes[index]["prompt"] = prompt.map { $0 as Any } ?? NSNull()
            panes[index]["activity"] = NSNull()
        }
        session["panes"] = panes
        let questions: [[String: Any]] = [
            ["text": "Earlier database question?", "options": [["label": "Archived choice", "description": "Keep the original question wording."]]],
            ["text": "What project name?", "options": []],
        ]
        let messages: [[String: Any]] = [["id": "codex-reader-question", "role": "agent", "at": 1,
            "blocks": [["kind": "tool", "name": "functions.request_user_input", "summary": "Earlier database question?", "result": NSNull(), "questions": questions]]]]
        try Fixture.call(port + 1, "scenario", body: ["patch": [
            "session": session, "transcripts": [paneID: messages],
            "prompts": prompt.map { [paneID: $0] } ?? [:],
        ]], prefix: "__stub")
    }

    private func answer(_ port: Int) throws -> [String: Any] {
        var writes: [[String: Any]] = []
        for _ in 0..<40 {
            writes = try Fixture.call(port, "writes", method: "GET")["writes"] as! [[String: Any]]
            if !writes.isEmpty { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertEqual(writes.count, 1, "a choice must produce one answer, with no prompt or raw-key write")
        XCTAssertEqual(writes.first?["path"] as? String, "/api/panes/w1%3Ap2/answer")
        return writes.first?["body"] as? [String: Any] ?? [:]
    }

    func testHistoryCurrentAnswerAndEditableDraft() throws {
        continueAfterFailure = false
        let port = Fixture.primary
        let app = XCUIApplication(bundleIdentifier: "app.shahi.mobile")
        app.activate()
        app.signOutEverywhere()
        app.descendants(matching: .any)["language-en"].tap()
        try app.pair(port) { try self.prepare(port) }
        let row = app.descendants(matching: .any)["row-\(paneID)"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        XCTAssertTrue(app.buttons["view-read"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["What project name?"].waitForExistence(timeout: 15), "free-text questions stay visible outside Activity")
        XCTAssertTrue(app.staticTexts["Keep the original question wording."].exists, "question descriptions must render without expanding a tool")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Archived choice'")).firstMatch.exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Archived choice'")).firstMatch.exists, "transcript options are history, not terminal controls")
        XCTAssertEqual((try Fixture.call(port, "writes", method: "GET")["writes"] as! [[String: Any]]).count, 0)

        let current: [String: Any] = ["question": "Which database now?", "answer": "digit", "promptId": "native-codex-current-question",
            "options": [["index": 1, "label": "SQLite", "selected": true], ["index": 2, "label": "Postgres", "selected": false]]]
        try prepare(port, prompt: current)
        let postgres = app.buttons["2. Postgres"]
        XCTAssertTrue(postgres.waitForExistence(timeout: 15))
        postgres.tap()
        let posted = try answer(port)
        XCTAssertEqual(posted["promptId"] as? String, "native-codex-current-question")
        XCTAssertEqual(posted["question"] as? String, "Which database now?")
        XCTAssertEqual(posted["label"] as? String, "Postgres")
        // The stub deliberately keeps the pre-answer frame. Observe more than
        // two fast polling ticks so an immediately hidden card cannot pass by
        // reappearing as fresh, actionable controls after the next read.
        let until = Date().addingTimeInterval(1.6)
        while Date() < until {
            XCTAssertFalse(postgres.exists, "an answered appearance must not be rearmed by its old frame")
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertEqual((try Fixture.call(port, "writes", method: "GET")["writes"] as! [[String: Any]]).count, 1)

        let editable: [String: Any] = ["question": "Choose another database?", "answer": "digit", "promptId": "native-codex-editable-question",
            "options": [["index": 1, "label": "SQLite", "selected": true], ["index": 2, "label": "Other", "selected": false],
                ["index": 3, "label": "Add notes", "key": "Tab", "selected": false, "textInput": true]]]
        try prepare(port, prompt: editable)
        XCTAssertTrue(app.buttons["Add notes"].waitForExistence(timeout: 15), "a new prompt identity must offer its own choices")
        XCTAssertFalse(app.buttons["3. Add notes"].exists, "the Tab action has no invented answer number")
        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText(draft)
        let compact = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Waiting:'")).firstMatch
        if compact.exists { compact.tap() }
        let addNotes = app.buttons["Add notes"]
        XCTAssertTrue(addNotes.waitForExistence(timeout: 10))
        addNotes.tap()
        let selected = try answer(port)
        XCTAssertEqual(selected["promptId"] as? String, "native-codex-editable-question")
        XCTAssertEqual(selected["label"] as? String, "Add notes")
        XCTAssertEqual(selected["index"] as? Int, 3)
        XCTAssertEqual(composer.value as? String, draft, "choosing a field keeps the draft and sends none of its text")
        XCTAssertTrue(app.buttons["1. SQLite"].isEnabled, "an editable selection is not a completed answer; predefined choices remain available")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the editable selection focuses the composer")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Codex current question and unsent editable draft"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        try Fixture.call(port, "revoke")
        XCTAssertTrue(app.buttons["intro-continue"].waitForExistence(timeout: 15))
    }
}
