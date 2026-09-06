"""Compare actual TS builders with authoritative Python on a bounded capture.

Usage: python check_motion_feature_parity.py INPUT_JSON TS_OUTPUT_JSON REPORT_JSON
Extract only service's pure pace functions via AST, avoiding model/server startup.
Receipt precision and frozen-cell limitations stay in the resulting report.
"""
import ast
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from zoneinfo import ZoneInfo
import pandas as pd
from research_motion_features import add_motion_history, motion_at, MOTION_FEATURES

input_path, ts_path, report_path = map(Path, sys.argv[1:4])
source = Path(__file__).parent / 'service.py'
parsed = ast.parse(source.read_text())
pure = ast.Module(body=[node for node in parsed.body if isinstance(node, ast.FunctionDef)
    and node.name in ('pace_at', 'trusted_weight')], type_ignores=[])
namespace = {}
exec(compile(pure, str(source), 'exec'), namespace)
data, ts = json.loads(input_path.read_text()), json.loads(ts_path.read_text())
cells = {}
for row in data['cellRows']:
    cells.setdefault(row['tbl'], {})[row['cellKey']] = (row['mean'], row['weight'], row['updatedAtMs'])
geoms = {trip: (g['shapeId'], g['totalM'], [(s['distM'],s['stopId']) for s in g['stops']])
         for trip, g in data['geometries'].items()}
pace_calls = []
def pace_at(cells, shape, route, distance, band, day, at_ms):
    value = namespace['pace_at'](cells, shape, route, distance, band, day, at_ms)
    pace_calls.append(dict(shapeId=shape, routeId=route, distM=distance,
        observedAtMs=at_ms, hourBand=band, dayType=day, value=value))
    return value
frame = add_motion_history(pd.DataFrame(data['fixes']), geoms, cells, pace_at, ZoneInfo('Europe/Prague'))
max_error = [0.] * 7
mismatches = []
for output in ts['outputs']:
    p = SimpleNamespace(**frame.iloc[output['index']].to_dict())
    if bool(p.motionFresh) != output['fresh']: mismatches.append(dict(index=output['index'], kind='fresh'))
    for offset, actual in zip(ts['offsets'], output['values']):
        expected = motion_at(p, p.seenAtMs + offset)
        for column, (a, b) in enumerate(zip(actual, expected)):
            error = abs(a - b)
            max_error[column] = max(max_error[column], error)
            if error > 1e-9: mismatches.append(dict(index=output['index'], offset=offset,
                feature=MOTION_FEATURES[column], actual=a, expected=b, error=error))
if len(pace_calls) != len(ts['paceCalls']): mismatches.append(dict(kind='pace-call-count'))
max_pace_error = 0.
for py, runtime in zip(pace_calls, ts['paceCalls']):
    if {k:v for k,v in py.items() if k!='value'} != {k:v for k,v in runtime.items() if k!='value'}:
        mismatches.append(dict(kind='pace-call-context', python=py, typescript=runtime))
    max_pace_error = max(max_pace_error, abs(py['value']-runtime['value']))
    if abs(py['value']-runtime['value']) > 1e-9: mismatches.append(dict(kind='pace-value', python=py, typescript=runtime))
report = dict(kind='Real-input seven-column cross-language numerical parity, with real learned pace callbacks',
    passed=not mismatches, rows=len(data['fixes']), vehicles=len({r['key'] for r in data['fixes']}),
    geometries=len(geoms), learnedCells=len(data['cellRows']), horizonOffsetsMs=ts['offsets'],
    numericalComparisons=len(data['fixes'])*len(ts['offsets'])*7,
    firstHorizonCoverage={name:sum(bool(row['values'][0][column]) for row in ts['outputs'])
        for name,column in [('nonzeroPace',0),('positiveTrust',1),('inferredPlatform',5),('stationaryEvidence',6)]},
    paceCalls=len(pace_calls), maxPaceError=max_pace_error,
    maxFeatureError=dict(zip(MOTION_FEATURES,max_error)), mismatchCount=len(mismatches), mismatches=mismatches[:20],
    inputSha256=hashlib.sha256(input_path.read_bytes()).hexdigest(),
    sourceSha256={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [source,Path(__file__).parent/'research_motion_features.py']},
    limitations=data['notes']+['These are the appended seven columns only; existing thirteen require their independent parity gate.',
       'Frozen export cells include values learned after earlier rows. This is numerical parity, not causal historical accuracy validation.'])
report_path.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
sys.exit(0 if report['passed'] else 1)
