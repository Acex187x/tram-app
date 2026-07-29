# Calibration analysis — 2026-07-28 — two independent line 12 rides

Two new v4 rider recordings from `~/Downloads` provide the first independent
confirmation set after the 2026-07-20 hold/latency changes. Both rides are on
line 12 and the same 52T model, but use different vehicles and partially
overlapping route spans. They are therefore independent trips, not yet an
independent route/model class.

**Result: the logged on-device error is materially lower than on the 20 July
reference ride. Across the two new rides, mean |sim − rider| is 89.9 m and p90
is 205.9 m, versus 135.7 m and 305.7 m on 20 July. The already-shipped 45 s
stop-hold bound is strongly confirmed. No additional engine constant passes
the multi-ride robustness gate, so this round intentionally ships no physics
change.**

## 1. Input and data quality

| recording | line / model / tram | usable GPS | AVL fixes | stops | shape span |
|---|---:|---:|---:|---:|---:|
| `20260728-172812-9507.jsonl` | 12 / 52t / 9507 | 1,066 | 30 | 14 | 3,300–9,843 m |
| `20260728-182204-9506.jsonl` | 12 / 52t / 9506 | 551 | 16 | 7 | 3,715–6,829 m |

Both files parse as complete v4 rides. Their filtered route offsets are good:
ride 9507 has `fOffM` p50/p90 7.3/13.5 m and ride 9506 5.1/8.9 m; all metrics
below use the runbook's `fOffM < 30 m` gate. GPS accuracy p50 is 11.7 and
13.2 m respectively. The older 13-second line 31 export remains unusable.

## 2. Logged ground-truth result

`fLagM = simDist − fDist`; negative means the rendered tram is behind the
physical tram carrying the phone.

| ride | mean \|fLagM\| | p50 | p90 | signed mean | sim ahead |
|---|---:|---:|---:|---:|---:|
| 2026-07-20, line 17 kt8d5 (reference) | 135.7 m | 98.6 m | 305.7 m | −85.3 m | 34.7% |
| 2026-07-28, 9507 | 94.8 m | 65.2 m | 226.3 m | −66.7 m | 33.0% |
| 2026-07-28, 9506 | 80.5 m | 53.3 m | 191.1 m | −25.6 m | 44.8% |
| **new rides combined** | **89.9 m** | **61.3 m** | **205.9 m** | **−52.7 m** | **37.0%** |

Against the older reference, the combined new recordings show about **34%
lower mean absolute error** and **33% lower p90**. This is corroborating
evidence rather than a strict A/B measurement: route, vehicle family, time and
traffic differ. Crucially, both new trips improve in the same direction.

The remaining error is still generated mainly while moving. Cruise mean
absolute error is 110.4/101.3 m on 9507/9506, while dwell error is only
33.7/23.8 m. Signed cruise bias remains behind (−79.5/−42.3 m), but the second
ride's dwell samples are slightly ahead (+19.9 m), warning against globally
pushing every target farther forward.

## 3. Replay parity correction

Before evaluating constants, `ride_replay.py` was brought back into parity
with the current engine's 2026-07-27 observation handling:

- teleport detection now uses the gap-aware 500–1,500 m threshold;
- a candidate fix is compared at its ingestion-time projected position;
- both ingestion and target projection cap advance at `V_CRUISE_REF_MS`.

This is calibration-tool parity only; it does not modify production physics.
Without it, slow but valid feed gaps were replayed as teleports and candidate
deltas were not trustworthy.

## 4. Constant sweep and gate decision

Aggregate replay over all three good rides (line 17 kt8d5 plus both line 12
52T trips):

| configuration | mean \|error\| | p90 | signed | decision |
|---|---:|---:|---:|---|
| pre-change hold 60 s | 169.3 m | 350.4 m | −146.5 m | rejected baseline |
| hold 45 s, no latency | 124.8 m | 270.8 m | −71.6 m | confirms R11 |
| **shipped hold 45 + latency 3 s** | **117.3 m** | **264.9 m** | **−54.1 m** | retain |
| latency 10 s probe | 103.3 m | 214.0 m | −10.9 m | reject: trips disagree |
| trail 5 m | 111.6 m | 255.3 m | −38.9 m | reject: only 4.9%, below noise gate |
| catch-up 1.55 | 116.7 m | 258.1 m | −46.8 m | reject: negligible |

The tempting latency-10 result is not robust. On ride 9507 it improves the
shipped replay 123.6 → 116.3 m, but moves the signed result from −32 m to +38 m;
on ride 9506 it **regresses** 84.0 → 97.0 m and pushes the already-ahead bias
to +71 m. Trail 5 m improves the two new trips by only 7.5% and 3.6%, below
the runbook's ~10% single-ride noise threshold. Catch-up, bias half-life,
curve factor, cruise reference and TOD probes likewise lack consistent,
material support.

The important positive result is the previously shipped stop-hold correction:
relative to hold 60, the current configuration improves replay mean absolute
error **163.1 → 123.6 m (−24%)** on 9507 and **138.6 → 84.0 m (−39%)** on
9506. Both independent trips confirm the mechanism and direction identified
on 20 July.

Fleet replay remains the unchanged safety gate on
`session-2026-07-11.jsonl`: OLD → NEW fresh-fix median 133.3 → 124.9 m
(−6.3%), fresh-sim p90 448.3 → 399.6 m (−10.9%); the current S70 smooth layer
also remains neutral-to-positive versus R62 (median 125.2 → 124.8 m, p90
390.6 → 382.7 m).

## 5. Decision and next data

No new production physics constants are changed in this round. The new data
validates that the current tracking is substantially better, and specifically
confirms hold-45 plus the conservative 3 s latency correction. Moving farther
toward the aggregate optimum would overfit two trips sharing line and model.

Highest-value next recordings remain:

1. an AM-peak trip, to test `TOD_PACE_TABLE`/`TOD_DWELL_TABLE` rather than a
   global pace hack;
2. a centre-crossing or street-running route, to separate signal/congestion
   effects from line 12/17 right-of-way;
3. another vehicle family, to make any per-model acceleration conclusion
   identifiable.
