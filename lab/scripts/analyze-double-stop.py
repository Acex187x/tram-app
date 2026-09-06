#!/usr/bin/env python3
"""Describe duplicate platform holds in captured wire data; no motion-policy changes.
Usage: python3 lab/scripts/analyze-double-stop.py WIRE GEOMETRY [START_MS]
Matches exact key/trip/anchor timestamp, not nearest vehicle or later observation.
"""
import json, sys
from collections import Counter
wire, geometry = sys.argv[1:3]
cutoff = int(sys.argv[3]) if len(sys.argv)>3 else 0
pack=json.load(open(geometry)); shapes={g['shapeId']:g for g in pack['shapes']}
fixes={}; emissions={}; start=None; end=None
for line in open(wire):
    try:e=json.loads(line)
    except ValueError:continue
    t=e['receivedAtMs']; start=t if start is None else min(start,t);end=t if end is None else max(end,t)
    path=e.get('path'); value=e.get('value') or {}
    if path=='stream:fullFleet': vs=value.get('vehicles',[])
    elif path=='stream:batchesSince':vs=[f for b in value.get('batches',[]) for f in b.get('changed',[])]
    else:vs=[]
    for f in vs:
        key=(f['key'],f['tripId'],f['observedAtMs'])
        if key not in fixes:fixes[key]=(f,t)
    if path=='trajectories:fullSet':vs=value.get('vehicles',[])
    elif path=='trajectories:batchesSince':vs=[v for b in value.get('batches',[]) for v in b.get('changed',[])]
    else:vs=[]
    for v in vs:
        key=(v['key'],v['tripId'],v['emittedAtMs'])
        if t>=cutoff and key not in emissions:emissions[key]=(v,t)

def flats(points):
    result=[]
    for a,b in zip(points,points[1:]):
        if b['t']<=a['t'] or abs(b['s']-a['s'])>.05:continue
        if result and result[-1]['toMs']==a['t'] and abs(result[-1]['s']-a['s'])<=.05:
            result[-1]['toMs']=b['t']
        else:result.append({'fromMs':a['t'],'toMs':b['t'],'s':a['s']})
    return [dict(h,seconds=(h['toMs']-h['fromMs'])/1000) for h in result if h['toMs']-h['fromMs']>=2000]

coverage=Counter();offsets=Counter();examples=[];anchor_sets={}; fix_rows=[]
def remember(name,k):anchor_sets.setdefault(name,set()).add(k)
for key,(f,t) in fixes.items():
    if t<cutoff or f.get('statePosition')!='at_stop':continue
    g=shapes.get(pack['trips'].get(f['tripId']));matches=[s for s in g.get('stops',[]) if s['stopId']==f.get('lastStopId')] if g else []
    if len(matches)!=1:continue
    offset=matches[0]['distM']-f['shapeDistM'];band='behind-150+' if offset>150 else 'behind-50-150' if offset>50 else 'behind-5-50' if offset>5 else 'within5' if offset>=-5 else 'ahead5+'
    offsets[band]+=1;fix_rows.append({'key':f['key'],'tripId':f['tripId'],'observedAtMs':f['observedAtMs'],'lastStopId':f['lastStopId'],'offsetM':offset})
for _,(v,t) in emissions.items():
    coverage['allUniqueEmissions']+=1;k=(v['key'],v['tripId'],v['anchorMs']);pair=fixes.get(k)
    if not pair:coverage['missingExactAnchor']+=1;continue
    f,received=pair
    if f.get('statePosition')!='at_stop':continue
    coverage['atStopAnchorEmissions']+=1;remember('atStopAnchor',k)
    if received>t:coverage['anchorFeedReceivedAfterCurve']+=1
    g=shapes.get(pack['trips'].get(f['tripId']))
    if not g:coverage['missingGeometry']+=1;continue
    stops=g['stops'];matches=[s for s in stops if s['stopId']==f.get('lastStopId')]
    if len(matches)!=1:coverage['missingOrAmbiguousLastStopId']+=1;continue
    platform=matches[0];ps=platform['distM'];anchor=v.get('anchorS',f['shapeDistM']);offset=ps-anchor
    coverage['exactLastStopIdEmissions']+=1;remember('exactLastStopId',k)
    if not 5<offset<=150:continue
    coverage['anchor5to150mBeforeLastPlatform']+=1;remember('anchor5to150mBeforeLastPlatform',k)
    row={'key':v['key'],'tripId':v['tripId'],'emittedAtMs':v['emittedAtMs'],'anchorMs':v['anchorMs'],'receivedAtMs':t,'anchorFeedReceivedAtMs':received,'lastStopId':f['lastStopId'],'nextStopId':f.get('nextStopId'),'lastStopSequence':f.get('lastStopSequence'),'platformSequence':platform.get('sequence'),'platformName':platform.get('name'),'rawShapeDistM':f['shapeDistM'],'anchorS':anchor,'platformDistM':ps,'offsetM':offset,'rawFix':f,'platform':platform,'profiles':{},'discontinuity':v.get('discontinuity')}
    for mode in ['opinion','smooth']:
        holds=flats(v[mode]); pairs=[]
        for second in holds:
            if abs(second['s']-ps)>3:continue
            for first in holds:
                if first['toMs']>second['fromMs'] or second['s']-first['s']<=5:continue
                if not anchor-2<=first['s']<=ps-5:continue
                between=[s['stopId'] for s in stops if s['stopId']!=platform['stopId'] and first['s']+3<s['distM']<second['s']-3]
                pairs.append({'first':first,'second':second,'differentPlatformsBetween':between})
        if pairs:
            row['profiles'][mode]=pairs;coverage[mode+'DoubleHoldEmissions']+=1;remember(mode+'DoubleHold',k)
            if any(not p['differentPlatformsBetween'] for p in pairs):coverage[mode+'NoOtherPlatformEmissions']+=1;remember(mode+'NoOtherPlatform',k)
    if row['profiles']:examples.append(row)
print(json.dumps({'method':'Descriptive emitted-profile prevalence, not observed physical stops or realized hold time. Exact key/trip/anchor timestamp; lastStopId must identify exactly one platform. Candidate range anchor 5..150m before that platform. Flat spans >=2s and <=0.05m, second span within3m of same platform, separate levels by>5m. Geometry capture may be later; physical stop axis only, no schedule timing used. Future within emitted curves is inspected; no predictive-accuracy claim. Revisions deduplicated; anchor counts avoid repeated revision inflation.','window':{'firstReceivedAtMs':start,'lastReceivedAtMs':end,'cutoffMs':cutoff},'coverage':dict(coverage),'uniqueAnchors':{k:len(s) for k,s in anchor_sets.items()},'uniqueAnchorKeys':{name:[list(k) for k in sorted(keys)] for name,keys in anchor_sets.items()},'uniqueAtStopFixOffsetBands':dict(offsets),'examples':examples,'matchedAtStopFixes':fix_rows},indent=2))
