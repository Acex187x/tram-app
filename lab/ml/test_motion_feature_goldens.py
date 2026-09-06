"""Shared v4 parity fixture. Regenerate explicitly with --write after protocol review.

The checked-in numbers come from the authoritative research implementation, not
from the TS counterpart. No training target rows or production identifiers occur.
"""
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from zoneinfo import ZoneInfo
import pandas as pd
from research_motion_features import add_motion_history, motion_at, MOTION_FEATURES

FIXTURE = Path(__file__).parent / 'fixtures' / 'motion-features-v4.json'
PRAGUE = ZoneInfo('Europe/Prague')


def cases():
    geo = dict(shapeId='shape', totalM=2000, stops=[[0, 'start'], [500, 'current'], [1000, 'next'], [1800, 'last']])
    def row(obs, dist, **kw):
        return dict(key='v', tripId='trip', routeId='L1', observedAtMs=obs,
                    receivedAtMs=obs+5000, shapeDistM=dist, nextStopId='next',
                    lastStopId=None, statePosition='on_track', coordinates=[14., 50.], **kw)
    def change(r, **kw): return {**r, **kw}
    def case(name, rows, geoms=None):
        return dict(name=name, geometries=geoms or {'trip': geo}, rows=rows, horizonOffsetsMs=[0, 180000, 360000, 720000])
    base = 1788559140000  # Fri 2026-09-04 21:59 UTC; crosses Saturday midnight in Prague.
    return [
        case('receipt-reordering-and-duplicates', [row(100000, 100),
             change(row(130000, 400), receivedAtMs=170000), row(150000, 500),
             change(row(150000, 900), receivedAtMs=175000)]),
        case('pace-decay-trip-reset-and-older-new-trip', [row(100000, 100), row(130000, 400),
             change(row(160000, 650), nextStopId='last'),
             change(row(80000, 0), tripId='new', receivedAtMs=200000)]),
        case('standing-needs-axis-and-gps', [change(row(100000, 400), statePosition='at_stop'),
             change(row(120000, 480), statePosition='at_stop', coordinates=[14.001, 50.]),
             change(row(140000, 481), statePosition='at_stop', coordinates=[14.001, 50.]),
             change(row(160000, 482), statePosition='at_stop', coordinates=[14.001, 50.]),
             change(row(180000, 482), statePosition='at_stop', coordinates=[14.002, 50.]),
             row(200000, 482)]),
        case('standing-cap-and-stale-row', [change(row(100000+i*20000, 480), statePosition='at_stop') for i in range(9)] +
             [change(row(180000, 490), statePosition='at_stop', receivedAtMs=300000)]),
        case('missing-ambiguous-and-first-next-platform', [
             change(row(100000, 100), nextStopId='repeat'),
             change(row(120000, 120), nextStopId=None),
             change(row(140000, 140), nextStopId='unknown'),
             change(row(160000, 160), nextStopId='start')],
             {'trip': {**geo, 'stops': [[0,'start'],[100,'repeat'],[200,'middle'],[300,'repeat']]}}),
        case('exact-current-identity-is-diagnostic-only', [
             change(row(100000, 200), lastStopId='current'),
             change(row(120000, 700), lastStopId='contradiction'),
             change(row(140000, 1000), lastStopId=None)]),
        case('prague-midnight-weekend-context', [row(base, 100), row(base+30000, 220), row(base+60000, 520), row(base+90000, 1000)]),
        case('pace-gates-and-clamps', [row(100000,100), row(104000,180), row(109000,190),
             row(139000,204), row(169000,219), row(199000,879), row(229000,1540),
             row(350000,1600), row(380000,1590), change(row(410000,1700), nextStopId=None)]),
        case('stationary-on-track-does-not-mean-boarding', [row(100000,480), row(120000,481), row(140000,482)]),
        case('equal-receipts-preserve-input-order', [change(row(100000,100), receivedAtMs=160000),
             change(row(150000,600), receivedAtMs=160000), change(row(120000,300), receivedAtMs=160000)]),
        case('fleet-independent-history', [row(100000,100), change(row(110000,500), key='other'), row(130000,400),
             change(row(140000,560), key='other')]),
        case('trust-cap-retained-memory', [row(100000+i*10000,100+i*80) for i in range(14)]),
        case('missing-geometry-does-not-learn', [change(row(100000,100), tripId='absent'), change(row(130000,400),tripId='absent')]),
    ]


def evaluate(case):
    calls = []
    def pace_at(_cells, shape, route, distance, hour_band, day_type, at_ms):
        calls.append(dict(shapeId=shape, routeId=route, distM=distance, hourBand=hour_band, dayType=day_type, observedAtMs=at_ms))
        return 5 + hour_band + (2 if day_type == 'weekend' else 0)
    frame = pd.DataFrame([dict(key=r['key'], tripId=r['tripId'], routeId=r['routeId'],
        obsAtMs=r['observedAtMs'], seenAtMs=r['receivedAtMs'], shapeDistM=r['shapeDistM'],
        nextStopId=r['nextStopId'], statePos=r['statePosition'], lng=r['coordinates'][0], lat=r['coordinates'][1]) for r in case['rows']])
    geoms = {key: (g['shapeId'],g['totalM'],g['stops']) for key,g in case['geometries'].items()}
    result = add_motion_history(frame, geoms, {}, pace_at, PRAGUE)
    rows = []
    for i, row in enumerate(case['rows']):
        p = SimpleNamespace(**result.iloc[i].to_dict())
        rows.append(dict(fresh=bool(p.motionFresh), queries=[dict(atMs=row['receivedAtMs']+offset,
            values=motion_at(p,row['receivedAtMs']+offset)) for offset in case['horizonOffsetsMs']]))
    return dict(rows=rows, paceCalls=calls)


def artifact():
    return dict(featureVersion=4, featureNames=MOTION_FEATURES,
        authority='lab/ml/research_motion_features.py', scenarios=[{**c, 'expected':evaluate(c)} for c in cases()])


class MotionFeatureGoldens(unittest.TestCase):
    def test_shared_fixture_matches_python_authority(self):
        self.assertEqual(json.loads(FIXTURE.read_text()), artifact())


if __name__ == '__main__':
    if '--write' in sys.argv:
        FIXTURE.write_text(json.dumps(artifact(), indent=2, allow_nan=False)+'\n')
    else:
        unittest.main()
