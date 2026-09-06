import XCTest

/// External-app UI harness. The app must already be installed on the leased
/// simulator; this target never builds, signs or installs Tram Spotter itself.
@MainActor
final class TramSpotterUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "cz.zabolotny.tramspotter")

    override func setUpWithError() throws {
        continueAfterFailure = false
        // Assert explicit controls rather than depending on arbitrary delays.
        app.launchArguments = []
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func button(_ label: String, timeout: TimeInterval = 15) -> XCUIElement {
        let element = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", label, label + ",")).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Missing button: \(label)\n\(app.debugDescription)")
        return element
    }

    private func settle(_ seconds: TimeInterval = 1) {
        // A bounded delay is intentional for visual samples of animations.
        // Existence/selection assertions below independently verify controls.
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func openFleet() {
        // Phones deliberately launch at the compact home-sheet detent, where
        // the body row exists in AX below the screen. Use its visible pinned
        // search action; both controls open the same fleet search screen.
        let browse = button("Browse the fleet")
        let entry = browse.isHittable ? browse : button("Search lines, trams and stops")
        XCTAssertTrue(entry.isHittable, "Home fleet search is not reachable")
        entry.tap()
    }

    private func tapSegment(_ label: String) {
        let segment = app.segmentedControls.buttons[label].firstMatch
        if segment.waitForExistence(timeout: 3) {
            segment.tap()
            XCTAssertTrue(segment.isSelected, "Native segment did not select: \(label)")
        } else {
            // Some native wrappers expose segments as top-level buttons.
            // No coordinate guessing: a missing native label is a test failure.
            let fallback = app.buttons[label].firstMatch
            XCTAssertTrue(fallback.exists, "Native segment absent from accessibility: \(label)\n\(app.debugDescription)")
            fallback.tap()
        }
    }

    func test01Inspector() throws {
        app.launch()
        let settings = button("Settings")
        XCTAssertTrue(settings.isHittable, "Inspector covers the home Settings control")
        settings.tap()
        let debug = app.switches["Debug mode"]
        XCTAssertTrue(debug.waitForExistence(timeout: 10))
        if debug.value as? String != "1" { debug.tap() }
        button("Close").tap()
        let expand = app.buttons["Развернуть инспектор трекинга"]
        if expand.exists { expand.tap() }
        let settingsWithPanel = button("Settings")
        XCTAssertTrue(settingsWithPanel.isHittable, "Expanded inspector covers Settings")
        settingsWithPanel.tap()
        XCTAssertTrue(app.switches["Debug mode"].waitForExistence(timeout: 10))
        button("Close").tap()
        shot("inspector-empty")
        openFleet()
        let tram = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tram ")).firstMatch
        XCTAssertTrue(tram.waitForExistence(timeout: 20), "No live tram available to inspect")
        tram.tap()
        XCTAssertTrue(app.staticTexts["Свежесть · четыре разных возраста"].waitForExistence(timeout: 15))
        shot("inspector-selected-overview")
        button("Пауза").tap()
        XCTAssertTrue(app.buttons["Продолжить"].exists)
        shot("inspector-paused")
        button("Продолжить").tap()
        tapSegment("История")
        settle(2)
        shot("inspector-history")
        tapSegment("Сервер")
        settle(4)
        XCTAssertTrue(app.staticTexts["Свежая публикация"].waitForExistence(timeout: 30),
                      "Trajectory stream has not recovered; see diagnostics screenshot")
        let publication = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^[0-9]+ / [0-9]+$")).firstMatch
        XCTAssertTrue(publication.exists)
        let publicationBefore = publication.label
        settle(5)
        XCTAssertNotEqual(publication.label, publicationBefore, "No trajectory publication advanced during the live sample")
        shot("inspector-server")
        // Use the real panel's bounds on both compact and regular layouts.
        // React Native Fabric assigns testID to the wrapping Other element;
        // its actual UIScrollView is a child in the observed native AX tree.
        let panelHost = app.otherElements["tracking-inspector-scroll"]
        XCTAssertTrue(panelHost.waitForExistence(timeout: 5))
        let panel = panelHost.scrollViews.firstMatch
        XCTAssertTrue(panel.exists)
        let firstCard = app.staticTexts["Лента профилей · телефон"].firstMatch
        let cardYBefore = firstCard.frame.minY
        panel.swipeUp()
        XCTAssertLessThan(firstCard.frame.minY, cardYBefore - 8,
                          "Gesture did not scroll the inspector content")
        shot("inspector-server-scrolled")
        tapSegment("Справка")
        shot("inspector-help")
        tapSegment("Обзор")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.buttons["Пауза"].waitForExistence(timeout: 10))
        settle(2)
        shot("inspector-after-background")
        button("Свернуть инспектор трекинга").tap()
        XCTAssertTrue(app.buttons["Развернуть инспектор трекинга"].exists)
        shot("inspector-collapsed")
    }

    func test02AllModelMechanisms() throws {
        for id in ["t3", "t3rp", "t3rplf", "kt8d5", "14t", "15t", "52t"] {
            // XCUIApplication.open(URL) is a supported XCTest API since iOS16.4.
            app.open(URL(string: "fablespotsthetram://model/\(id)")!)
            let front = button("Inspect the front of the tram", timeout: 40)
            shot("\(id)-whole")
            front.tap()
            settle(1)
            shot("\(id)-front")
            button("Inspect the rear of the tram").tap()
            settle(1)
            shot("\(id)-rear")
            button("Show the whole tram").tap()
            let doors = app.switches["Open model doors"]
            XCTAssertTrue(doors.waitForExistence(timeout: 10))
            if doors.value as? String == "1" { doors.tap(); settle(2) }
            doors.tap()
            XCTAssertEqual(doors.value as? String, "1")
            settle(0.5)
            shot("\(id)-doors-opening")
            settle(1.3)
            shot("\(id)-doors-open")
            doors.tap()
            settle(2)
            XCTAssertEqual(doors.value as? String, "0")
            shot("\(id)-doors-closed")
            // The whole-tram preset hides the far-side indicator. Head-on
            // samples expose both lamps for an actual left/right blink review.
            button("Inspect the front of the tram").tap()
            settle(1)
            tapSegment("Left")
            // Several samples cover one800ms period; screenshots are evidence
            // for visual review, not a pixel-level assertion of blink timing.
            for tick in 0..<3 { settle(0.3); shot("\(id)-left-\(tick)") }
            tapSegment("Right")
            for tick in 0..<3 { settle(0.3); shot("\(id)-right-\(tick)") }
            tapSegment("Off")
            button("Show the whole tram").tap()
            settle(1)
            shot("\(id)-before-pinch")
            app.pinch(withScale: 1.35, velocity: 1)
            settle(1)
            shot("\(id)-after-pinch")
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.40))
            let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.42))
            from.press(forDuration: 0.1, thenDragTo: to)
            shot("\(id)-orbit-after-drag")
            XCUIDevice.shared.press(.home)
            app.activate()
            XCTAssertTrue(app.buttons["Close 3D viewer"].waitForExistence(timeout: 10))
            button("Inspect the front of the tram").tap()
            settle(1)
            shot("\(id)-front-after-background")
            button("Close 3D viewer").tap()
        }
    }

    func test03MapGeometry() throws {
        app.launch()
        // The benchmark launch-argument camera is development-only. Exercise
        // the Release map with real gestures in its unobstructed right region.
        let mapPoint = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.35))
        for _ in 0..<5 { mapPoint.doubleTap(); settle(0.6) }
        openFleet()
        let tram = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tram ")).firstMatch
        XCTAssertTrue(tram.waitForExistence(timeout: 20))
        // Opening the card engages follow at the current zoom and recenters
        // the selected vehicle after the zoom gestures.
        tram.tap()
        XCTAssertTrue(app.buttons["Close tram details"].waitForExistence(timeout: 10))
        settle(4)
        shot("map-selected-detail")
        settle(2)
        shot("map-selected-detail-later")
    }
}
