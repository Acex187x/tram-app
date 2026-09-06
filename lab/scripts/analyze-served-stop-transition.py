#!/usr/bin/env python3
"""Read-only exact-ID analysis of consecutive captured AVL observations."""
import json,sys
from collections import Counter
wire,geometry=sys.argv[1:3];cutoff=int(sys.argv[3]) if len(sys.argv)>3 else 0
pack=json.load(open(geometry));shapes={g['shapeId']:g for g in pack['shapes']}
previous={};counts=Counter();cases=[];all_transitions=[]
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
  if e['receivedAtMs']<cutoff or not prev or prev['tripId']!=f['tripId']:continue
  if prev.get('statePosition')!='at_stop' or f.get('statePosition')!='on_track':continue
  counts['allAtStopToOnTrack']+=1
  dt=(f['observedAtMs']-prev['observedAtMs'])/1000
  if not 0<dt<=120:counts['outside120s']+=1;continue
  counts['within120s']+=1
  fields=['lastStopId','nextStopId','lastStopSequence','nextStopSequence']
  if not all(f.get(k) is not None and prev.get(k)==f.get(k) for k in fields):counts['identityChanged']+=1;continue
  counts['sameStopIdsAndSequences']+=1
  g=shapes.get(pack['trips'].get(f['tripId']));stops=g['stops'] if g else []
  matches=[s for s in stops if s['stopId']==f['lastStopId'] and s['sequence']==f['lastStopSequence']]
  if len(matches)!=1:counts['missingOrAmbiguousPlatform']+=1;continue
  st=matches[0];gap0=st['distM']-prev['shapeDistM'];gap1=st['distM']-f['shapeDistM'];ds=f['shapeDistM']-prev['shapeDistM']
  row={'key':f['key'],'tripId':f['tripId'],'receivedAtMs':e['receivedAtMs'],'previous':prev,'current':f,'platform':st,'dtS':dt,'dsM':ds,'previousBeforePlatformM':gap0,'currentBeforePlatformM':gap1}
  all_transitions.append(row)
  if gap1<=0:counts['atOrBeyondPlatform']+=1;continue
  counts['stillBeforePlatform']+=1
  if not 0<gap0<=150 or gap1>150:counts['outside150mAdmittedAnchor']+=1;continue
  if st.get('isTerminal') or st is stops[-1]:counts['terminal']+=1;continue
  if len([s for s in stops if s['stopId']==st['stopId']])!=1:counts['repeatedLastStopId']+=1;continue
  nxt=[s for s in stops if s['stopId']==f['nextStopId'] and s['sequence']==f['nextStopSequence'] and s['sequence']>st['sequence'] and s['distM']>st['distM']]
  if len(nxt)!=1:counts['invalidNextStop']+=1;continue
  if any(s['distM']>prev['shapeDistM'] and s['distM']<st['distM'] and s['stopId']!=st['stopId'] for s in stops):counts['interveningPlatform']+=1;continue
  counts['continuationCandidates']+=1
  counts['positiveDistanceCandidates' if ds>0 else 'flatOrBackwardCandidates']+=1
  cases.append(row)
print(json.dumps({'method':'Consecutive distinct observations in actual shared AVL receipt order. AT_STOP→ON_TRACK on same trip, within120s, exact unchanged last/next IDs and sequences. Candidate additionally satisfies original served-platform identity/distance/terminal/loop/intervening-platform gates. Counts describe source transitions, not predicted hold realization.','cutoffMs':cutoff,'counts':dict(counts),'cases':cases,'allSameIdentityMappedTransitions':all_transitions},indent=2))
