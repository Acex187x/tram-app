# Downstream policy attribution

These are targeted diagnostic samples, not representative fleet estimates.
`lab/scripts/analyze-policy.ts` selects only a captured revision received before
its next observation timestamp, keeps older revisions when a newer one arrived
late, and evaluates optional velocities using the actual shared evaluator.
Raw AVL shape positions remain proxies; known contradictory axes must be
excluded from calibration.

## Stop identifiers

Across 6,270 unique `at_stop` observations in the production capture, 3,245 were
within 30 m of a served platform. Of those, 3,229 matched `lastStopId`, none
matched `nextStopId`, and 16 matched neither. A separate client capture confirms
the direction of this result. `learned.update` stores dwell/release under the
wire's next-stop key. The current-anchor modal lookup uses the same key and is
self-consistent, but a future driver stop asks by its actual platform ID and
therefore retrieves another platform's dwell evidence.

Legacy cells cannot simply be renamed: at a route branch, the same successor
key can contain observations from several predecessor platforms. A trip-aware
successor adapter is only approximate reuse. Reconstructing actual-platform
cells would require replaying observation pairs with their trip geometry and
an unambiguous platform match into a new aggregate family. Keep the current
modal key semantics until such a migration is explicit.

A controlled successor-adapter experiment on 211 same future observations
changed opinion MAE 106.90→105.87 m, with no kinematic violations and unchanged
p90. Its baseline reconstructed the captured generator within 1.07 m MAE;
uncaptured queue leadership and later sampled learned surfaces remain
limitations. This does not explain most of the downstream error and has not
changed runtime policy.

## Pace and shape constraints

The production case-enriched history has 419 eligible pairs: raw ML MAE
59.1 m, opinion 106.2 m, smooth 110.6 m. Of these, 334 have a moving opinion,
with raw 66.1 m versus opinion 115.1 m. Literal platform holds alone therefore
cannot explain the loss. The worst old jam case, vehicle 9379, repeats the
already-fixed at-stop→on-track false-jam mechanism of vehicle 9402.

A generous curve-only minimum travel time was integrated over 8,170 observed
moving intervals. It exceeded the observed interval by over 10% in 220 cases
and by over 25% in 75. This omits stops and starting acceleration, and noisy AVL
projection may explain individual violations; it is not permission to remove
curve safety bounds.

Changing the entire learned pace band is not a supported fix. On the same
211-case reconstruction, widening only its upper ratio 1.2→2.0 changed MAE
106.90→105.99 m; lowering the lower ratio 0.8→0.3 worsened it to 109.18 m.
Both retained kinematic gates. These were isolated bundled counterfactuals;
production and candidate constants remain unchanged.

The exact candidate vehicle 9511 case is more specific: skipping a request
stop leaves the next planned stop beyond the ML horizon. The `tau === null`
branch then applies the final 30-second ML tail pace to the entire current
leg, although the beginning of the ML trajectory predicts much faster travel.
An exact-input local-horizon fallback experiment retained 326 observations
whose baseline reconstructed within 2 m (mean reconstruction 0.05/0.07 m).
Opinion MAE changed 96.95→93.74 m and smooth 111.72→108.41 m, but opinion
phantom dips increased 2→4 and individual errors regressed by up to 61 m.
The final runtime retains the frozen pace rule. Reproducible inputs, scripts
and the full gate discussion are in the
[client investigation](../../testing/client-tracking-2026-09-05.md).

## Invalid route axis

Vehicle 8772 repeatedly reported `s=0`, while its GPS lay about 10 km from the
served start and neither reported last/next stop existed on that variant. The
GPS was near a different part/direction of the route; global projection would
invent an axis. Do not tune motion to fit this observation or count it as a
clean physical error. The separately committed geometry-coherence amendment
requires two independent contradictions before rejecting an axis and mandates
recovery on coherent evidence, with raw GPS shown honestly as stale.

## Duplicate service of the current platform

Native vehicle 9128 supplied the concrete case. The published 06:18:48.226Z
revision held its opinion at the observed station-zone position 1891.35 m,
then scheduled another hold at 1948.4 m for the same Dělnická platform
(geometry 1949.568 m). Its smooth hold at 1927.62 m explained the screenshot's
36.3 m deviation exactly. This was an emitted server hold, not a paused client
animation. The first known modal dwell remains intentional; the extra future
service was caused by a plan that used only platform distance, ignoring the
current last-stop identity.

The accepted 2026-09-06 protocol amendment consumes that one occurrence only
with exact ordered current/next stop identities and sequences, a nonterminal
unique current platform, a modal anchor strictly before it by at most 150 m,
and no intervening distinct platform. It also reuses the existing skipped-stop
ML-crossing trim blind. Without that blind, the raw curve still priced the
removed second dwell and produced four extra opinion speed dips. This is a
station-zone evidence rule: GPS itself was often 75 m before the platform;
it is not a global projection correction.

On 513 exact captured generator inputs, 381 future observations were eligible;
326 had baseline reconstruction within 2 m (mean 0.054/0.070 m). The accepted
change gives opinion MAE **96.95→91.85 m**, smooth **111.72→106.78 m**.
Opinion speed dips remain 2→2, smooth 10→9; curve, collision and mid-segment
stop violations remain zero. Infeasible stops fall 5→3 and 10→4. At-stop truth
has zero new >30 m smooth overshoots and zero >30 m absolute-error regressions
(eight improvements). On-track truth has four new >30 m overshoots and five
large regressions versus seven large improvements. This bounded tradeoff was
accepted for the private candidate; it is not a claim every observation improves.
The [machine-readable summary](served-platform-counterfactual-summary.json)
includes state-specific errors and gates.

An independent exact-case duplicate counter reconstructed 72 opinion and 40
smooth duplicate profiles across 73 surface-covered cases and found zero after
consumption (actual profiles contained 73/40; 28 further cases lacked sampled
surfaces). This is an emitted-profile and one-emission counterfactual, not a
claim about realized stops or a full chained fleet replay. Learned surfaces
were sampled later in 250 m bins; reconstruction filtering limits that confound.

The sequential guard was checked separately. In the full 61.6-minute source
capture, 3,521 mapped AT_STOP→ON_TRACK transitions within 120 s with unchanged
stop identities all landed at or beyond the current platform. The morning
capture had 264 more, also all at/beyond. Thus the ordinary axis plan excludes
that platform on the next real moving fix. A retained exact 9271 fixture tests
both captured emissions with the candidate's first curve as the next seam:
no duplicate dwell returns, the client-projected seam is continuous, and
physical gates pass. A hypothetical moving fix still before the platform
conservatively resumes the ordinary plan; no unsupported persistent served-stop
state was added. That input pattern was absent in the measured transitions.

Reproduce with `node lab/scripts/counterfactual-served-stop.mjs CAPTURE_DIR`.
The capture directory needs the paired wire, debug/debug-extra and derived
surfaces from this investigation. The retained public-input regression fixture
is [served-platform-exact-fixture.json](served-platform-exact-fixture.json),
and `backend-served-platform.test.ts` covers bounds, missing/reversed metadata,
terminal/intervening/loop exclusions and successive emissions.
