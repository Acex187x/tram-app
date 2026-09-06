# Private tracking review build

The 2026-09-05 candidate uses production vehicle identities and route geometry,
and a separate private trajectory publisher, version-3 ML service and inspector.
See [the isolated server runbook](../../lab/isolated/README.md) for endpoints,
artifacts and startup verification. No production service rollout or Git push
is part of this review build.

The phone must reach `10.10.10.1` through the home LAN/IPsec route. This is a
temporary review dependency, not a public production endpoint. An unreachable
trajectory service must appear as an offline/degraded source in the inspector;
the app must not present old predictions as current observations.

## Build and install

Acquire an `ios-resource` build slot first and hold it through installation.
For simulator builds, acquire a simulator lease and use its exact UDID.

```sh
python3 scripts/build/ios-candidate.py \
  --destination 'platform=iOS,id=<paired-device-UDID>' \
  --development-team '<Apple-development-team-ID>' \
  --derived-data /tmp/tram-fleet-device
xcrun devicectl device install app --device <CoreDevice-ID> \
  /tmp/tram-fleet-device/Build/Products/Release-iphoneos/TramSpotter.app
```

The script sets the private trajectory and inspector URLs during the Release
bundle build. It temporarily adds a scoped ATS exception for `10.10.10.1`, a
local-network purpose string and build number 31 (overridable with
`--build-number`) to the generated Info.plist,
then restores the original file even on failure. Arbitrary HTTP loads remain
disabled. The generated iOS project is not the source of production settings.

Inspect the built Info.plist and actual bundled URLs before installing. Confirm
fresh clock responses, advancing publication sequence and individual curves on
the real phone; Mac reachability alone is insufficient. Preserve the current
candidate server for user review. See [iPad pairing diagnosis](ipad-network-discovery.md)
if the device is reachable on the LAN but absent from CoreDevice.

## Evidence boundaries

- GLB validation checks geometry, bounds, material budgets and mechanism data.
  It does not replace simulator inspection of silhouettes, windows and markings.
- Offline ML holdout scores measure prediction error against later observed AVL
  fixes, not rider GPS or full application accuracy. Use paired publication-time
  eligible forecasts for live comparisons and include night data explicitly.
- Replay smoothness checks measure actual frame-producing paths. Simulator CPU
  measurements are host process measurements, not real-device energy results.
- Door and indicator controls are demonstrations in the model viewer. They do
  not claim access to live vehicle door or turn-signal telemetry.
