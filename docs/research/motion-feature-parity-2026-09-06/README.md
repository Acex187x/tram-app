# Captured motion-feature parity

[Report](report.json): Python and TypeScript agree exactly on13,230 values
(378 archived fixes ×5 horizons ×7 appended columns), including23 learned-pace
callback results. The TypeScript run uses the real `MotionFeatureHistory` and
`LearnedModel.paceAt`; Python uses `add_motion_history`, `motion_at`, and the exact
pure `service.py` pace/trust functions extracted by AST without starting ML models.

The capture covers7 vehicles,14 geometries and10,797 slow learned cells. At the
first horizon129 rows have nonzero pace,164 have positive trust, and378 have an
inferred predecessor platform. None has positive stationary evidence; that
branch and ambiguous/missing platforms are covered by the shared synthetic
[goldens](../../../lab/ml/fixtures/README.md).

This is numerical parity, **not a historical accuracy evaluation**. Archived
distances have already passed `FUSE_FIX_AXIS`; receipt timestamps are producer
batch epochs rather than exact Lab arrival; learned cells are frozen at export
and include later learning relative to early rows. The original thirteen ML
columns and raw-versus-fused coordinate audit require their separate gates.

Reproduce after decompressing
[input](../../testing/fixtures/tracking-2026-09-06-motion-parity-inputs.json.gz):

```sh
npx tsx --tsconfig lab/tsconfig.runtime.json bench/src/motion-feature-parity.ts INPUT.json > TS.json
python3 lab/ml/check_motion_feature_parity.py INPUT.json TS.json REPORT.json
```

Python requires NumPy/pandas. The report records input and authoritative Python
source SHA-256 hashes. The captured [TypeScript output](../../testing/fixtures/tracking-2026-09-06-motion-parity-ts.json.gz)
is retained for comparison. Evaluation horizons are0/30/120/180/360 seconds after
the archived receipt epoch; none advances the history from a future target.


## Historical feature sensitivity reconstruction

`bench/src/reconstruct-historical-motion-rows.ts` reconstructs833 original
emissions from the frozen segmented chain, with13 query horizons ×20 finite
features each. All833 anchors match an archived post-fusion axis within0.1 m
and have a producer receipt no later than the original target-grid issue time.
The actual TypeScript feature builder receives a frozen later slow model and
a separate corridor model updated only with receipt-available historical pairs.
Motion history likewise advances only before each original query issue.

This is approximate sensitivity evidence, not the actual historical serving
feature matrix. The slow-cell export is later than the queries (and affects
tripPaceRatio); exact Lab receipts, removal/quarantine events and corridor state
before the archive start were not captured. No ground-truth rows enter history.
The backend owns downstream model inference and sequence scoring. Local output:
`/tmp/tram-r2-historical-feature-rows.json` (833 outputs,0 exclusions,25362 consumed
fixes,24688 corridor pairs,409 trip resets).
