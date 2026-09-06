import XCTest
import UIKit

/// External-app UI harness. The app must already be installed on the leased
/// simulator; this target never builds, signs or installs Tram Spotter itself.
@MainActor
final class TramSpotterUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "cz.zabolotny.tramspotter")

    override func setUpWithError() throws {
        continueAfterFailure = false
        // Assert explicit controls rather than depending on arbitrary delays.
        app.launchArguments = []
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let openAlert = springboard.alerts.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Tram Spotter", "TramSpotter")).firstMatch
        if openAlert.exists && openAlert.buttons["Open"].exists { openAlert.buttons["Open"].tap() }
        addUIInterruptionMonitor(withDescription: "Open the already-authorized Tram Spotter deeplink") { alert in
            guard alert.label.localizedCaseInsensitiveContains("Tram Spotter") || alert.label.localizedCaseInsensitiveContains("TramSpotter") else { return false }
            let open = alert.buttons["Open"]
            if open.exists { open.tap(); return true }
            return false
        }
    }

    func test09ViewerIdleAndResume() throws {
        app.launch()
        app.open(URL(string: "fablespotsthetram://model/kt8d5")!)
        button("Show the whole tram", timeout: 40).tap()
        settle(3)
        shot("thermal-viewer-idle-start")
        // Bounded quiet window for the external process CPU sampler. No
        // interaction, auto-orbit or active mechanism should submit GL work.
        settle(65)
        shot("thermal-viewer-idle-end")
        let doors = app.switches["Open model doors"]
        doors.tap(); settle(2)
        XCTAssertEqual(doors.value as? String, "1")
        shot("thermal-viewer-door-open")
        XCUIDevice.shared.press(.home)
        settle(15)
        app.activate()
        button("Inspect the front of the tram").tap()
        shot("thermal-viewer-resumed-front")
        button("Close 3D viewer").tap()
    }

    func test06RideTimingMetadata() throws {
        // The runner stages the explicitly synthetic UI-only fixture. It is
        // never used as route/GPS accuracy evidence or a user ride recording.
        app.launch()
        let rides = button("Recorded rides")
        if !rides.isHittable {
            // The phone home sheet starts compact; drag its actual accessible
            // grabber into the expanded detent before reaching the body row.
            let grabber = app.descendants(matching: .any)["Home sheet"].firstMatch
            XCTAssertTrue(grabber.exists, "Missing accessible home-sheet grabber")
            let start = grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
            start.press(forDuration: 0.15, thenDragTo: end)
            settle(1)
        }
        XCTAssertTrue(rides.isHittable, "Recorded rides is not reachable in the expanded home sheet")
        rides.tap()
        let row = app.buttons["Preview ride ui-only-timing-fixture.jsonl on the map"]
        XCTAssertTrue(row.waitForExistence(timeout: 15), "Stage ride-timing-ui-only.jsonl before this test")
        let value = row.value as? String ?? ""
        XCTAssertTrue(value.contains("2 eligible · 3 excluded"), value)
        XCTAssertTrue(value.contains("1 unknown input availability"), value)
        XCTAssertTrue(value.contains("1 clock mismatch"), value)
        XCTAssertTrue(value.contains("1 later input"), value)
        XCTAssertTrue(row.isHittable, "Timing metadata made the ride row unreachable")
        shot("ride-timing-ui-only-fixture")
        let evidence = XCTAttachment(string: value)
        evidence.name = "ride-timing-accessibility-counts"
        evidence.lifetime = .keepAlways
        add(evidence)
        button("Close").tap()
    }

    func test07SkinImportAndPreview() throws {
        // Runner stages a labelled synthetic UV package in the app's Files
        // folder. It is not evidence of any real advertising assignment.
        app.launch()
        app.open(URL(string: "fablespotsthetram://skins")!)
        func importPackage() {
            button("Import skin package").tap()
            let browse = app.buttons["Browse"].firstMatch
            if browse.waitForExistence(timeout: 3) && browse.isHittable { browse.tap() }
            let local = app.cells.matching(NSPredicate(format: "label == %@ OR label == %@", "On My iPad", "On My iPhone"))
            if let visible = local.allElementsBoundByIndex.first(where: { $0.isHittable }) { visible.tap(); settle(0.5) }
            let folder = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "Tram Spotter"))
            if let visible = folder.allElementsBoundByIndex.first(where: { $0.isHittable }) { visible.tap(); settle(0.5) }
            let files = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "qa-uv-kt8.skin"))
            if !files.firstMatch.waitForExistence(timeout: 3) {
                let search = app.searchFields.firstMatch
                XCTAssertTrue(search.exists, "Files browser has neither staged file nor search")
                search.tap(); dismissKeyboardEducation()
                let clear = search.buttons["Clear text"]
                if clear.exists { clear.tap() }
                search.typeText("qa-uv-kt8"); dismissKeyboardEducation()
                let submit = app.keyboards.buttons["search"].firstMatch
                if submit.exists && submit.isHittable { submit.tap() }
            }
            XCTAssertTrue(files.firstMatch.waitForExistence(timeout: 20), "Staged package not found in native Files picker: \(app.debugDescription)")
            let file = try? XCTUnwrap(files.allElementsBoundByIndex.first(where: { $0.isHittable }))
            XCTAssertNotNil(file, "Staged file is not reachable: \(app.debugDescription)")
            file?.tap()
            XCTAssertTrue(app.buttons["Preview skin UV TEST · not a real advertisement"].waitForExistence(timeout: 30), "Import did not complete: \(app.debugDescription)")
        }
        importPackage()
        shot("skin-imported-library")
        let registration = app.textFields["Vehicle registration for skin"]
        XCTAssertTrue(registration.exists)
        registration.tap(); registration.typeText("777777")
        let hideKeyboard = app.keyboards.buttons["Hide keyboard"].firstMatch
        if hideKeyboard.exists && hideKeyboard.isHittable { hideKeyboard.tap() }
        let skinScroll = app.scrollViews.containing(.textField, identifier: "Vehicle registration for skin").firstMatch
        XCTAssertTrue(skinScroll.exists)
        let assign = button("Assign to vehicle")
        if !assign.isHittable { scrollSheet(skinScroll, up: true); settle(1) }
        shot("skin-assignment-before-submit")
        XCTAssertTrue(assign.isHittable, "Assignment action remains obscured after scrolling the actual sheet")
        assign.tap()
        let alert = app.alerts["Assignment saved"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10)); alert.buttons.firstMatch.tap(); settle(1)
        let reset = app.buttons["Reset skin for vehicle 777777"]
        for _ in 0..<5 { if reset.isHittable { break }; scrollSheet(skinScroll, up: true); settle(0.5) }
        shot("skin-assignment-saved")
        XCTAssertTrue(reset.isHittable, "Reset remains unreachable: \(app.debugDescription)"); reset.tap()
        let preview = button("Preview skin UV TEST · not a real advertisement")
        for _ in 0..<5 { if preview.isHittable { break }; scrollSheet(skinScroll, up: false); settle(0.5) }
        preview.tap()
        button("Inspect the front of the tram", timeout: 40).tap()
        settle(3); shot("skin-uv-front")
        button("Inspect the rear of the tram").tap()
        settle(2); shot("skin-uv-rear")
        button("Show the whole tram").tap()
        settle(2); shot("skin-uv-whole")
        let doors = app.switches["Open model doors"]
        XCTAssertTrue(doors.waitForExistence(timeout: 10))
        if doors.value as? String != "1" { doors.tap() }
        settle(2); shot("skin-uv-doors-open")
        button("Close 3D viewer").tap()
        importPackage() // Same ID creates a new immutable native asset version.
        shot("skin-reimported-library")
    }

    func test08SkinMapAssignment() throws {
        // Requires test07's imported synthetic package. Assignment is allowed
        // only on this leased Simulator and is reset before the test exits.
        app.launch()
        let mapPoint = app.coordinate(withNormalizedOffset: CGVector(dx: 0.80, dy: 0.35))
        for _ in 0..<3 { mapPoint.doubleTap(); settle(0.6) }
        openFleet()
        button("KT8D5").tap()
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Tram ", "KT8")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "No live KT8 available for a labelled simulator-only UV check")
        let match = try XCTUnwrap(row.label.range(of: "^Tram [0-9]+", options: .regularExpression))
        let registrationNumber = String(row.label[match]).replacingOccurrences(of: "Tram ", with: "")
        var temporaryAssigned = false
        defer {
            if temporaryAssigned {
                app.open(URL(string: "fablespotsthetram://skins")!)
                let select = app.buttons["Select skin UV TEST · not a real advertisement"]
                if select.waitForExistence(timeout: 5) { select.tap() }
                let reset = app.buttons["Reset skin for vehicle \(registrationNumber)"]
                let scroll = app.scrollViews.containing(.textField, identifier: "Vehicle registration for skin").firstMatch
                if scroll.exists { for _ in 0..<7 { if reset.isHittable { break }; scrollSheet(scroll, up: true); settle(0.3) } }
                if reset.isHittable { reset.tap() }
            }
        }
        let identity = XCTAttachment(string: row.label + " — temporary synthetic UV TEST, reset after capture")
        identity.name = "skin-map-temporary-identity"; identity.lifetime = .keepAlways; add(identity)
        row.tap(); settle(2)
        for _ in 0..<2 { mapPoint.doubleTap(); settle(0.6) }
        let follow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Return to following")).firstMatch
        if follow.exists && follow.isHittable { follow.tap() }
        settle(3); shot("skin-map-standard")
        app.open(URL(string: "fablespotsthetram://skins")!)
        button("Select skin UV TEST · not a real advertisement").tap()
        let input = app.textFields["Vehicle registration for skin"]
        let scroll = app.scrollViews.containing(.textField, identifier: "Vehicle registration for skin").firstMatch
        for _ in 0..<5 { if input.isHittable { break }; scrollSheet(scroll, up: true); settle(0.3) }
        input.tap(); input.typeText(registrationNumber)
        let hide = app.keyboards.buttons["Hide keyboard"].firstMatch
        if hide.exists && hide.isHittable { hide.tap() }
        let assign = button("Assign to vehicle")
        for _ in 0..<5 { if assign.isHittable { break }; scrollSheet(scroll, up: true); settle(0.3) }
        assign.tap()
        let alert = app.alerts["Assignment saved"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10)); alert.buttons.firstMatch.tap(); settle(1)
        temporaryAssigned = true
        closeSkinSheets(); settle(5); shot("skin-map-assigned-uv")
        app.open(URL(string: "fablespotsthetram://skins")!)
        button("Select skin UV TEST · not a real advertisement").tap()
        let reset = app.buttons["Reset skin for vehicle \(registrationNumber)"]
        let currentScroll = app.scrollViews.containing(.textField, identifier: "Vehicle registration for skin").firstMatch
        for _ in 0..<7 { if reset.isHittable { break }; scrollSheet(currentScroll, up: true); settle(0.3) }
        XCTAssertTrue(reset.isHittable, "Temporary assignment must be reset: \(app.debugDescription)")
        reset.tap(); temporaryAssigned = false
        closeSkinSheets(); settle(4); shot("skin-map-reset-standard")
    }

    private func scrollSheet(_ scroll: XCUIElement, up: Bool) {
        // Gestures begin inside the observed visible sheet above the keyboard,
        // never in an occluded bottom region whose events type keyboard keys.
        let frame = scroll.frame
        let keyboard = app.keyboards.firstMatch
        let bottom = keyboard.exists ? min(frame.maxY, keyboard.frame.minY) : frame.maxY
        let high = max(frame.minY + 35, bottom - 25)
        let low = max(frame.minY + 20, high - min(240, frame.height * 0.55))
        let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: ((up ? high : low) - frame.minY) / frame.height))
        let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: ((up ? low : high) - frame.minY) / frame.height))
        start.press(forDuration: 0.1, thenDragTo: end)
    }

    private func closeSkinSheets() {
        for _ in 0..<4 {
            let visibleTitle = app.staticTexts.matching(NSPredicate(format: "label == %@", "Tram skins")).allElementsBoundByIndex.contains(where: { $0.isHittable })
            if !visibleTitle { break }
            let close = app.buttons.matching(NSPredicate(format: "label == %@", "Close")).allElementsBoundByIndex.first(where: { $0.isHittable })
            XCTAssertNotNil(close, "Visible skin sheet has no reachable native Close")
            close?.tap(); settle(1)
        }
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label == %@", "Tram skins")).allElementsBoundByIndex.contains(where: { $0.isHittable }), "Skin sheet still covers the map")
    }

    private func dismissKeyboardEducation() {
        // Fresh iPhone Simulators present native first-use keyboard education
        // inside the Files picker. It blocks file taps until Continue is used.
        for _ in 0..<3 {
            let education = app.staticTexts.matching(NSPredicate(format:
                "label == %@ OR label == %@ OR label == %@", "Type English and Czech", "Slide to Type", "Speed up your typing by sliding your finger across the letters to compose a word.")).firstMatch
            if !education.exists { break }
            guard let next = app.buttons.matching(NSPredicate(format: "label == %@", "Continue")).allElementsBoundByIndex.first(where: { $0.isHittable }) else { break }
            next.tap(); settle(0.5)
        }
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
        app.launch() // Establish accessibility before a standalone deep-link run.
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
            for (tick, interval) in [0.19, 0.37, 0.53, 0.23].enumerated() {
                settle(interval); shot("\(id)-left-\(tick)")
            }
            tapSegment("Right")
            for (tick, interval) in [0.23, 0.53, 0.37, 0.19].enumerated() {
                settle(interval); shot("\(id)-right-\(tick)")
            }
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

    private func measuredZoom() -> Double {
        let value = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^z[0-9]+\\.[0-9]+$")).firstMatch
        XCTAssertTrue(value.waitForExistence(timeout: 5), "Measured zoom is absent from Server diagnostics")
        return Double(value.label.dropFirst()) ?? .nan
    }

    func test05ViewerRotation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .pad,
                      "The iPhone app supports portrait; rotation coverage belongs to iPad")
        defer { XCUIDevice.shared.orientation = .portrait }
        XCUIDevice.shared.orientation = .portrait
        app.launch() // Establish the AX session when this test runs alone.
        for id in ["15t", "t3rplf"] {
            app.open(URL(string: "fablespotsthetram://model/\(id)")!)
            button("Inspect the front of the tram", timeout: 40).tap()
            settle(2)
            shot("\(id)-rotation-portrait-front")
            XCUIDevice.shared.orientation = .landscapeLeft
            let landscapeDeadline = Date().addingTimeInterval(10)
            while app.frame.width <= app.frame.height && Date() < landscapeDeadline { settle(0.5) }
            shot("\(id)-rotation-requested-landscape")
            let rotationState = XCTAttachment(string: "Requested landscapeLeft; device=\(XCUIDevice.shared.orientation.rawValue); app=\(app.frame); SpringBoard=\(XCUIApplication(bundleIdentifier: "com.apple.springboard").frame)")
            rotationState.name = "\(id)-rotation-state"; rotationState.lifetime = .keepAlways; add(rotationState)
            XCTAssertGreaterThan(app.frame.width, app.frame.height, "The app did not rotate to landscape")
            shot("\(id)-rotation-landscape-front")
            button("Inspect the rear of the tram").tap()
            settle(2)
            shot("\(id)-rotation-landscape-rear")
            XCUIDevice.shared.orientation = .portrait
            settle(3)
            XCTAssertLessThan(app.frame.width, app.frame.height, "The app did not return to portrait")
            shot("\(id)-rotation-portrait-rear")
            button("Close 3D viewer").tap()
        }
    }

    func test04AssemblyZooms() throws {
        app.launch()
        button("Settings").tap()
        let debug = app.switches["Debug mode"]
        XCTAssertTrue(debug.waitForExistence(timeout: 10))
        if debug.value as? String != "1" { debug.tap() }
        button("Close").tap()
        openFleet()
        let tram = app.buttons.matching(NSPredicate(format:
            "label BEGINSWITH %@ AND (label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@)",
            "Tram ", "15T", "14T", "52T", "KT8")).firstMatch
        XCTAssertTrue(tram.waitForExistence(timeout: 20), "No articulated tram in the visible fleet rows")
        let identity = XCTAttachment(string: tram.label)
        identity.name = "assembly-selected-identity"
        identity.lifetime = .keepAlways
        add(identity)
        tram.tap()
        settle(3)
        let expand = app.buttons["Развернуть инспектор трекинга"]
        if expand.exists { expand.tap() }
        tapSegment("Сервер")
        settle(2)
        // Gesture zoom is checked against the actual measured camera, not an
        // assumed pinch ratio or a development-only launch fixture.
        for target in [15.0, 16.0, 17.0] {
            for attempt in 0..<10 {
                let current = measuredZoom()
                if abs(current - target) <= 0.15 { break }
                button("Свернуть инспектор трекинга").tap()
                // XCTest/Mapbox applies a gesture threshold before zooming;
                // tiny nominal pinches can produce no motion at all. Supply a
                // bounded stronger correction, then remeasure both directions.
                let delta = target - current
                let gain = attempt >= 3 ? 1.65 : 1.25
                let ratio = min(2.0, max(0.5, pow(2.0, delta * gain)))
                app.pinch(withScale: CGFloat(ratio), velocity: target > current ? 1 : -1)
                settle(1)
                let follow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Return to following")).firstMatch
                if follow.exists && follow.isHittable { follow.tap(); settle(1) }
                button("Развернуть инспектор трекинга").tap()
                settle(1.2)
            }
            let actual = measuredZoom()
            XCTAssertEqual(actual, target, accuracy: 0.15, "Could not reach measured target zoom")
            let zoom = XCTAttachment(string: "target=\(target), measured=\(actual)")
            zoom.name = "assembly-camera-z\(Int(target))"
            zoom.lifetime = .keepAlways
            add(zoom)
            shot("assembly-source-z\(Int(target))")
            button("Свернуть инспектор трекинга").tap()
            settle(2)
            shot("assembly-map-z\(Int(target))")
            settle(2)
            shot("assembly-map-z\(Int(target))-later")
            button("Развернуть инспектор трекинга").tap()
            settle(1.2)
        }
        button("Свернуть инспектор трекинга").tap()
    }

}
