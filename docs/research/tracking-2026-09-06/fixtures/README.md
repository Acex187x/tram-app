# Public tracking fixtures

These files contain public fleet observations, trajectory publications and
geometry only. `manifest.json` records both uncompressed and gzip SHA-256.
They contain no ride/user GPS, server database or credentials. Deterministic gzip
uses timestamp zero. Keeping these immutable inputs prevents a later producer
update from silently changing the comparison.

The legacy fixture reproduces the previously excluded visible corrections:

```sh
node bench/scripts/build-replay.mjs --baseline-ref=93720af --out=/tmp/tram-build31.cjs
node /tmp/tram-build31.cjs docs/research/tracking-2026-09-06/fixtures/legacy-visible-corrections-wire.jsonl.gz docs/research/tracking-2026-09-06/fixtures/legacy-visible-corrections-geometry.json.gz 30 300 1788677017107 120
```

The segmented fixtures compare the recorded previous implementation and the
selected intermediate server counterfactual using identical explicit segment
boundaries. They predate the later v4 live activation. Each segment warms for
60 seconds; geometry is a static historical study input, not native cache event
history. Missing intermediate server publications end a segment.

```sh
node bench/scripts/build-replay.mjs --out=/tmp/tram-current.cjs
REPLAY_SEGMENTS=docs/research/tracking-2026-09-06/fixtures/segmented-windows.json.gz node /tmp/tram-current.cjs docs/research/tracking-2026-09-06/fixtures/segmented-phase-service-wire.jsonl.gz docs/research/tracking-2026-09-06/fixtures/segmented-geometry.json.gz
```

Use the exact start/end values retained by each segment, and the report/source
hashes in `client-segmented-display.json`. The source tree evolves: a newer
controller's result must be labeled as a new run, never substituted for the
stored baseline numbers. Native source acknowledgements are immediate in Node
replay; platform rendering, delivery congestion and power need device evidence.

### Geometry-receipt / world-continuity capture

`geometry-receipt-manifest.json` identifies the complete public candidate wire,
actual geometry response receipts and the immutable pre-world compiled replay.
The final pack is only the positional CLI argument: current replay starts empty
when wire geometry events exist and applies those events at their receipt times.

After decompressing the files to `/tmp/tram-geometry-replay`, run the current
`bench/src/replay-wire.ts` as a Node bundle (this keeps unused native adapters out of the replay):

```sh
npx esbuild bench/src/replay-wire.ts --bundle --platform=node --tsconfig=bench/tsconfig.json --external:react-native '--external:expo-*' --outfile=/tmp/tram-geometry-replay/replay.cjs
node /tmp/tram-geometry-replay/replay.cjs /tmp/tram-geometry-replay/geometry-receipt-candidate-wire.jsonl /tmp/tram-geometry-replay/geometry-receipt-final-pack.json 30 300 1788694533625 0
node /tmp/tram-geometry-replay/replay.cjs /tmp/tram-geometry-replay/geometry-receipt-candidate-wire.jsonl /tmp/tram-geometry-replay/geometry-receipt-final-pack.json 30 770 1788694653625 120
```

The pre-world bundle accepts the same arguments. Its original audit lacks the
new world-vector and raw-target-lag fields, but preserves historical client
motion and the all-frame relocation accounting. The comparison JSON adds the
same current `DisplayAudit` to both implementations; no motion code is replaced
in the baseline. Capture timing and source hashes are retained in the manifest
and `geometry-world-continuity-audit.json`.
