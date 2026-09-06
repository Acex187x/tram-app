# Motion feature parity

`motion-features-v4.json` contains synthetic receipt sequences and exact numerical
outputs from `research_motion_features.py`. It does not contain production fixes
or prediction targets. The seven fields append to the unchanged thirteen-column
ML contract; they are not a separate model version negotiation mechanism.

Run both language checks after changing either builder:

```sh
python3 lab/ml/test_motion_feature_goldens.py
python3 -m unittest discover -s lab/ml -p test_research_motion_features.py
npx jest __tests__/backend-motion-features.test.ts --runInBand
```

Python needs NumPy and pandas, already present in the training environment. Only
after an intentional protocol review, regenerate the fixture with
`python3 lab/ml/test_motion_feature_goldens.py --write`; rerun both checks. Do not
regenerate it to hide a TypeScript mismatch.

Coverage includes stable receipt reordering and ties, stale/duplicate observation
epochs, trip changes including older observation epochs, multiple vehicles,
Prague Friday-to-Saturday midnight, pace admission boundaries, decayed confidence,
unknown and repeated next-stop IDs, stationary traffic/axis/GPS contradictions,
and exact platform identity disagreements. The latter are diagnostic provenance,
and do not alter the numeric platform inference.

`MotionFeatureHistory` accepts observations in nondecreasing receipt order. The
caller supplies the axis/geometry used by training and the learned pace callback
at the observation midpoint and epoch. Querying a horizon never updates history.
A query preceding the latest receipt returns unknown because this bounded online
helper does not retain historic information sets. Production should prune missing
vehicle keys after fleet changes; an additional 2048-key capacity bound evicts the
least recently observed key. Confidence has a 180-second half-life, **no hard
180-second expiry**; learned ratio memory shrinks towards one at later horizons.
