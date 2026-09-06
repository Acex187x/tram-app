# iPad native build34 evidence

Six XCTest flows passed (537seconds): selected-tram inspector and advancing publication, all seven model controls, selected map geometry, measured map zoom15/16/17, iPad viewer rotation, and explicitly synthetic ride timing metadata. The summary is preserved here. Full attachments remain in `/tmp/tram-r2-native34-ipad/attachments/named`.

The XCTest landscape attachments had a capture/orientation crop defect. A focused rotation rerun passed38seconds after explicit application launch initialized accessibility; direct `simctl io EXACT_UDID screenshot` captures at the same landscape front state show the complete15T and T3R.PLF interfaces, roof and controls. The direct screenshots retained here are unmodified device pixel buffers (portrait dimensions with rotated landscape content). They show no black strip or missing controls, unlike the XCTest attachments.

Build34 does not contain the later skin feature or raw-world presentation changes; it cannot validate those runtime paths.
