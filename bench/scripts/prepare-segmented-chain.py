"""Prepare only consecutive actual WS publications covered by every counterfactual.
No unmatched publication is silently retained. Each segment is a separate identity;
its first 60s are display warmup, never accuracy/hold/kinematic score input.
"""
import json,sys,os,collections
wire,arms_json,out=sys.argv[1:]
os.makedirs(out,exist_ok=True)
arms={name:json.load(open(path))['changes'] for name,path in json.loads(arms_json).items()}
lookups={name:{(v['key'],v['tripId'],v['emittedAtMs']):v['vehicle'] for v in values}for name,values in arms.items()}
common=set.intersection(*(set(x) for x in lookups.values()))
keys={x[0] for x in common}
rows=[]
for line in open(wire):
 try: rows.append(json.loads(line))
 except json.JSONDecodeError: pass
rows.sort(key=lambda r:r['receivedAtMs'])
active={};seen={};segments=[];raw={};curve_events=[];fix_events=[]
def finish(key,at):
 s=active.pop(key,None)
 if s:
  s['endAtMs']=min(at,s['events'][-1]['vehicle']['smooth'][-1]['t'])
  if s['endAtMs']-s['startAtMs']>=90000 and len(s['events'])>=3:segments.append(s)
for row in rows:
 at=row['receivedAtMs'];v=row.get('value',{});p=row['path']
 if p in ('stream:fullFleet','stream:batchesSince'):
  before=raw.copy()
  if p=='stream:fullFleet':raw={s['key']:s for s in v['vehicles']}
  else:
   for b in v['batches']:
    raw.update((s['key'],s)for s in b['changed'])
    for k in b.get('removed',[]):raw.pop(k,None)
  for k in list(active):
   if k not in raw or raw[k]['tripId']!=active[k]['tripId']:finish(k,at)
  fix_events.append((at,raw.copy()))
  continue
 if p=='trajectories:fullSet':items=v['vehicles'];removed=set(seen)-{c['key']for c in items}
 elif p=='trajectories:batchesSince':
  items=[c for b in v['batches']for c in b['changed']];removed={k for b in v['batches']for k in b.get('removed',[])}
 else:continue
 for k in removed:finish(k,at);seen.pop(k,None)
 for c in items:
  k=c['key'];identity=(k,c['tripId'],c['emittedAtMs'])
  if k not in keys or seen.get(k)==identity:continue
  seen[k]=identity
  if identity not in common:finish(k,at);continue
  if k in active and active[k]['tripId']!=c['tripId']:finish(k,at)
  if k not in active:active[k]={'originalKey':k,'tripId':c['tripId'],'startAtMs':at,'events':[]}
  active[k]['events'].append({'atMs':at,'identity':identity,'vehicle':c})
for k in list(active):finish(k,rows[-1]['receivedAtMs'])
for i,s in enumerate(segments):s['key']=f"{s['originalKey']}~segment{i}";s['measureAtMs']=s['startAtMs']+60000
windows={s['key']:{k:s[k]for k in ('startAtMs','measureAtMs','endAtMs','originalKey','tripId')}for s in segments}
json.dump(windows,open(out+'/segments.json','w'),indent=2)
json.dump({'|'.join(map(str,e['identity'])):s['key']for s in segments for e in s['events'] if e['atMs']<s['endAtMs']},open(out+'/emission-segments.json','w'),indent=2)
# Materialize common identity timeline at actual raw-message AND lifecycle times.
times=sorted(set([t for t,_ in fix_events]+[s['startAtMs']for s in segments]+[s['endAtMs']for s in segments]))
identity_rows=[];idx=0;current={}
for t in times:
 while idx<len(fix_events)and fix_events[idx][0]<=t:current=fix_events[idx][1];idx+=1
 vehicles=[]
 for s in segments:
  f=current.get(s['originalKey'])
  if s['startAtMs']<=t<s['endAtMs'] and f and f['tripId']==s['tripId']:vehicles.append({**f,'key':s['key']})
 identity_rows.append({'receivedAtMs':t,'path':'stream:fullFleet','value':{'vehicles':vehicles,'seq':len(identity_rows)}})
for name,lookup in lookups.items():
 events=[]
 for s in segments:
  for e in s['events']:
   if e['atMs']<s['endAtMs']:events.append((e['atMs'],s['key'],lookup[tuple(e['identity'])]))
  events.append((s['endAtMs'],s['key'],None))
 events.sort(key=lambda e:e[0]);curves={};output=identity_rows.copy()
 for seq,(t,key,c)in enumerate(events):
  if c is None:curves.pop(key,None)
  else:curves[key]={**c,'key':key}
  output.append({'receivedAtMs':t,'path':'trajectories:fullSet','value':{'seq':seq,'vehicles':list(curves.values()),'meta':{'serverNowMs':t,'atMs':t,'publishedAtMs':t,'lastSeq':seq,'generator':'research-contiguous-'+name,'horizonS':120}}})
 output += [r for r in rows if r['path']=='clock:now']
 output.sort(key=lambda r:r['receivedAtMs'])
 with open(out+'/'+name+'-wire.jsonl','w')as f:
  for r in output:f.write(json.dumps(r,separators=(',',':'))+'\n')
report={'note':__doc__,'matchedEmissions':len(common),'segments':len(segments),'includedEmissions':sum(len(s['events'])for s in segments),'measuredVehicleSeconds':sum((s['endAtMs']-s['measureAtMs'])/1000 for s in segments),'uniqueKeys':len({s['originalKey']for s in segments}),'firstAtMs':min(s['startAtMs']for s in segments),'lastAtMs':max(s['endAtMs']for s in segments)}
json.dump(report,open(out+'/coverage.json','w'),indent=2);print(json.dumps(report,indent=2))
