/** Offline sensitivity fixture only: historical slow cells were not captured.
 * Reuses real feature builders, while recording every causal/coverage limit. */
import {readFileSync,writeFileSync} from 'node:fs';
import {LearnedModel} from '../../lab/src/learned';
import {MotionFeatureHistory} from '../../lab/src/motionFeatures';
import {buildMlFeatures} from '../../lab/src/ml';
import type {Store} from '../../lab/src/db';
import type {RouteGeometry,TramSnapshot} from '@/lib/types';

if(process.env.ML_FEATURE_VERSION!=='4')throw new Error('Set ML_FEATURE_VERSION=4 explicitly');
const [inputPath,memberPath,debugPath,outPath]=process.argv.slice(2);
const input=JSON.parse(readFileSync(inputPath,'utf8'));
const members=JSON.parse(readFileSync(memberPath,'utf8'));
const store=(cells:object[])=>({loadCells:()=>cells.map(row=>({s:0,n:0,...row})),getMeta:()=>null}) as unknown as Store;
const slow=new LearnedModel(store(input.cellRows.filter((r:any)=>!r.tbl.startsWith('corridor'))));
// Only this separate instance learns forward; frozen later slow cells never
// receive an extra historical fold. Its slow updates cannot affect output.
const corridor=new LearnedModel(store([]));
const learned={paceAt:slow.paceAt.bind(slow),releaseAt:slow.releaseAt.bind(slow),
  corridorPaceAt:corridor.corridorPaceAt.bind(corridor)} as LearnedModel;
const history=new MotionFeatureHistory();
const pace=slow.paceAt.bind(slow);
const fixes=input.fixes.map((r:any,index:number)=>({r,index,snap:{...r,observedAtMs:r.obsAtMs,
  coordinates:[r.lng,r.lat],statePosition:r.statePos,delaySeconds:r.delayS,
  nextStopSequence:r.nextSeq,lastStopId:null,nextStopId:r.nextStopId??null} as TramSnapshot}))
  .sort((a:any,b:any)=>a.r.seenAtMs-b.r.seenAtMs||a.index-b.index);
const anchors=new Map<string,typeof fixes>();
for(const f of fixes){const k=`${f.r.key}|${f.r.tripId}|${f.r.obsAtMs}`;const a=anchors.get(k)??[];a.push(f);anchors.set(k,a);}
const emissions=new Map<string,any>();
for(const line of readFileSync(debugPath,'utf8').split('\n')){
 if(!line.trim())continue;
 const item=JSON.parse(line);const d=item.value;
 const id=`${d.key}|${d.tripId}|${d.emittedAtMs}`;
 if(id in members&&!emissions.has(id))emissions.set(id,{id,d,receivedAtMs:item.receivedAtMs,issueMs:d.target?.[0]?.t});
}
const ordered=[...emissions.values()].sort((a,b)=>a.issueMs-b.issueMs||a.id.localeCompare(b.id));
const last=new Map<string,TramSnapshot>();
let cursor=0,staleIgnored=0,tripResets=0,corridorPairs=0;
const outputs:object[]=[];const excluded:object[]=[];
for(const e of ordered){
 const {d,id,issueMs}=e;
 if(!Number.isFinite(issueMs)){excluded.push({id,reason:'missing-query-time'});continue;}
 while(cursor<fixes.length&&fixes[cursor].r.seenAtMs<=issueMs){
  const f=fixes[cursor++];const snap=f.snap;const prev=last.get(snap.key);
  if(prev&&prev.tripId===snap.tripId&&snap.observedAtMs<=prev.observedAtMs){staleIgnored++;continue;}
  if(prev&&prev.tripId!==snap.tripId){history.forget(snap.key);tripResets++;}
  const full=input.geometries[snap.tripId] as RouteGeometry|undefined;
  const shapeId=input.shapeIds[snap.tripId];
  if(prev&&prev.tripId===snap.tripId&&shapeId){corridor.update(prev,snap,{shapeId} as RouteGeometry);corridorPairs++;}
  history.observe(snap,full,pace,f.r.seenAtMs);
  last.set(snap.key,snap);
 }
 const geom=input.geometries[d.tripId] as RouteGeometry|undefined;
 if(!geom){excluded.push({id,reason:'missing-full-geometry'});continue;}
 const candidates=anchors.get(`${d.key}|${d.tripId}|${d.anchorMs}`)??[];
 const available=candidates.filter((f:any)=>f.r.seenAtMs<=issueMs);
 if(!available.length){excluded.push({id,reason:candidates.length?'anchor-not-yet-available':'anchor-not-archived',issueMs,firstReceiptMs:candidates[0]?.r.seenAtMs??null});continue;}
 const anchor=available.reduce((a:any,b:any)=>Math.abs(a.snap.shapeDistM-d.anchorFix.s)<=Math.abs(b.snap.shapeDistM-d.anchorFix.s)?a:b);
 const axisErrorM=anchor.snap.shapeDistM-d.anchorFix.s;
 if(Math.abs(axisErrorM)>0.1){excluded.push({id,reason:'anchor-fused-axis-mismatch',axisErrorM});continue;}
 const rows=Array.from({length:13},(_,k)=>buildMlFeatures(anchor.snap,geom,learned,issueMs+k*10000,history));
 if(rows.some(r=>r.length!==20||r.some(v=>!Number.isFinite(v))))throw new Error(`Invalid row ${id}`);
 outputs.push({id,segment:members[id],key:d.key,tripId:d.tripId,emittedAtMs:d.emittedAtMs,issueMs,
  debugReceivedAtMs:e.receivedAtMs,anchor:{...anchor.r,axisErrorM},rows});
}
const result={kind:'historical sensitivity reconstruction; NOT captured serving features',featureVersion:4,
 inputs:{inputPath,memberPath,debugPath,cellsCapturedAtMs:input.capturedAtMs},
 limitations:['Slow cells are frozen later export; historical learned state is not reconstructed.',
 'seenAtMs is archived producer batch receipt, not exact Lab arrival.',
 'Fused axis and available full geometries are replayed; live removals/quarantine events were not archived.',
 'Corridor begins empty at archive start; only receipt-available pairs fold forward.',
 'Seven motion fields use available history but frozen later slow pace in tripPaceRatio.'],
 counts:{requested:Object.keys(members).length,found:emissions.size,rows:outputs.length,excluded:excluded.length,
  consumedFixes:cursor,staleIgnored,tripResets,corridorPairs},outputs,excluded};
writeFileSync(outPath,JSON.stringify(result));
console.log(JSON.stringify(result.counts));
