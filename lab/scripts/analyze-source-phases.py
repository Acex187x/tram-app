#!/usr/bin/env python3
"""Descriptive source evidence; AT_STOP is not treated as a measured stop."""
import json,sys,math
from collections import Counter
wire,geometry=sys.argv[1:3]
pack=json.load(open(geometry));shapes={g['shapeId']:g for g in pack['shapes']}
previous={};counts=Counter();offsets=[];pairs=[];fixes_out=[]
def metres(a,b):
 x=math.radians(b[0]-a[0])*math.cos(math.radians((a[1]+b[1])/2));y=math.radians(b[1]-a[1]);return 6371000*math.hypot(x,y)
for line in open(wire):
 try:e=json.loads(line)
 except ValueError:continue
 if e.get('path')=='stream:fullFleet':fixes=e['value']['vehicles']
 elif e.get('path')=='stream:batchesSince':fixes=[f for b in e['value']['batches'] for f in b.get('changed',[])]
 else:continue
 for f in fixes:
  prev=previous.get(f['key'])
  if prev and prev['tripId']==f['tripId'] and prev['observedAtMs']>=f['observedAtMs']:continue
  previous[f['key']]=f
  g=shapes.get(pack['trips'].get(f['tripId']));stops=g['stops'] if g else []
  matches=[s for s in stops if s['stopId']==f.get('lastStopId') and s['sequence']==f.get('lastStopSequence')]
  if f.get('statePosition')=='at_stop':
   counts['atStopFixes']+=1
   if len(matches)==1:
    d=matches[0]['distM']-f['shapeDistM'];offsets.append(d)
    band='before45to150' if 45<d<=150 else 'before15to45' if 15<d<=45 else 'within15' if abs(d)<=15 else 'beyond15' if d< -15 else 'beforeOver150'
    counts[band]+=1;fixes_out.append({'key':f['key'],'tripId':f['tripId'],'obsAtMs':f['observedAtMs'],'state':f['statePosition'],'offsetM':d,'lastStopId':f.get('lastStopId')})
  if not prev or prev['tripId']!=f['tripId']:continue
  dt=(f['observedAtMs']-prev['observedAtMs'])/1000
  if not 5<=dt<=120:continue
  ds=f['shapeDistM']-prev['shapeDistM'];gps=metres(prev['coordinates'],f['coordinates']);same=prev.get('lastStopId')==f.get('lastStopId') and prev.get('nextStopId')==f.get('nextStopId')
  if prev.get('statePosition')=='at_stop' and f.get('statePosition')=='at_stop' and same:
   counts['sameStopAtStopPairs']+=1
   if ds>=15 and gps>=15:counts['sameStopMovingAtStopPairs']+=1
   if abs(ds)<=8 and gps<=12:counts['sameStopStationaryAtStopPairs']+=1
   pairs.append({'key':f['key'],'tripId':f['tripId'],'prev':prev,'next':f,'dtS':dt,'dsM':ds,'gpsM':gps,'platformOffsetM':matches[0]['distM']-f['shapeDistM'] if len(matches)==1 else None})
print(json.dumps({'method':'Unique fixes; exact last stop ID+sequence geometry lookup. Moving evidence needs >=15m both shape and GPS displacement over5..120s, same at_stop identity. Stationary evidence <=8m shape and<=12m GPS. These are interval observations, not instantaneous speed or proof doors opened.','counts':dict(counts),'offsetM':{'median':sorted(offsets)[len(offsets)//2] if offsets else None},'pairs':pairs,'atStopFixes':fixes_out},indent=2))
