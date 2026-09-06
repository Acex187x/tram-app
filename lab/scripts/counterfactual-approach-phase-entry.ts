// Offline-only replay entry bundled by counterfactual-served-stop.mjs.
import fs from 'node:fs';
import { buildDriveVehicle, setPhaseRelease } from './src/drive';
import { evalTrajectory, prepareHermiteTrack } from '../src/lib/physics/evaluator';
const dir=process.argv[2]; if(!dir) throw Error('capture directory required');
const surfaces=JSON.parse(fs.readFileSync(dir+(fs.existsSync(dir+'/surfaces.json')?'/surfaces.json':'/surfaces-start.json'),'utf8'));
const debug=['debug.jsonl','debug-extra.jsonl'].filter(n=>fs.existsSync(dir+'/'+n)).flatMap(n=>fs.readFileSync(dir+'/'+n,'utf8').split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}})).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
const anchorFixes=new Map<string,any>();
for(const line of fs.readFileSync(dir+'/candidate-wire.jsonl','utf8').split('\n')){let e;try{e=JSON.parse(line)}catch{continue}const fsx=e.path==='stream:fullFleet'?e.value.vehicles:e.path==='stream:batchesSince'?e.value.batches.flatMap((b:any)=>b.changed??[]):[];for(const f of fsx)anchorFixes.set(f.key+'|'+f.tripId+'|'+f.observedAtMs,f);}
const histories=new Map<string,any[]>(); let skippedInputs=0;
const track=(points:any[],v?:number[])=>prepareHermiteTrack(new Float64Array(points.flatMap(p=>[p.t,p.s])),new Float64Array(points.map((p,i)=>v?.[i]??p.v??NaN)));
for(const event of debug){const d=event.value,inputs=d.policy?.inputs;if(!inputs||!d.publish?.synced||d.emittedAtMs!==inputs.emittedAtMs||event.receivedAtMs<1788645000000)continue;const h=histories.get(d.key)??[];if(h.some(x=>x.d.emittedAtMs===d.emittedAtMs))continue;
 const table=surfaces.trips[d.tripId];if(!table){skippedInputs++;continue;}
 const fix=anchorFixes.get(d.key+'|'+d.tripId+'|'+d.anchorMs); const args={...inputs,servedPlatform:fix?.statePosition==='at_stop' ? {stopId:fix.lastStopId,sequence:fix.lastStopSequence,nextStopId:fix.nextStopId,nextSequence:fix.nextStopSequence}:null,geom:table.geom,surfaces:{paceAt:(s:number)=>table.pace[Math.min(table.pace.length-1,Math.max(0,Math.floor(s/250)))],dwellStats:(id:string)=>table.dwell[id]??{mean:18,sd:8,trusted:false}}};
 setPhaseRelease(null);const baseline=buildDriveVehicle(args);const current=table.geom.stops.filter((s:any)=>s.stopId===fix?.lastStopId&&s.sequence===fix?.lastStopSequence);const gap=current.length===1?current[0].distM-(fix?.shapeDistM??NaN):NaN;const isApproach=fix?.statePosition==='at_stop'&&gap>45&&gap<=150;setPhaseRelease(isApproach&&args.modal&&process.env.APPROACH_RELEASE==='1'?{stopId:current[0].stopId,atMs:args.modal.releaseAtMs+gap/Math.max(1,args.surfaces.paceAt(fix.shapeDistM))*1000}:null);const candidate=buildDriveVehicle(isApproach?{...args,modal:null,servedPlatform:null}:args);if(!baseline||!candidate)continue;
 h.push({d,args,received:event.receivedAtMs,baseline,candidate,actualO:track(d.opinion.points,d.opinion.v),actualS:track(d.smooth.points,d.smooth.v),baseO:track(baseline.vehicle.opinion),baseS:track(baseline.vehicle.smooth),candO:track(candidate.vehicle.opinion),candS:track(candidate.vehicle.smooth),raw:track(d.target)});histories.set(d.key,h);
}
const seen=new Set<string>(),rows:any[]=[];let fleet=new Map<string,any>();
for(const line of fs.readFileSync(dir+'/candidate-wire.jsonl','utf8').split('\n')){let e;try{e=JSON.parse(line)}catch{continue;}let fixes:any[]=[];
 if(e.path==='stream:fullFleet'){fixes=e.value.vehicles;fleet=new Map(fixes.map(f=>[f.key,f]));}
 else if(e.path==='stream:batchesSince'){for(const batch of e.value.batches){fixes.push(...(batch.changed??[]));for(const key of batch.removed??[])fleet.delete(key);}}
 else continue;
 for(const f of fixes){fleet.set(f.key,f);const id=f.key+'|'+f.tripId+'|'+f.observedAtMs;if(seen.has(id))continue;seen.add(id);const x=histories.get(f.key)?.findLast(x=>x.received<=f.observedAtMs&&x.d.tripId===f.tripId&&x.d.anchorMs<f.observedAtMs&&x.d.emittedAtMs<=f.observedAtMs&&x.d.target.at(-1).t>=f.observedAtMs);if(!x)continue;
 const at=f.observedAtMs,ev=(tr:Float64Array)=>evalTrajectory(tr,at)-f.shapeDistM;
 rows.push({servedPlatform:x.args?.servedPlatform,key:f.key,tripId:f.tripId,observedAtMs:at,emittedAtMs:x.d.emittedAtMs,truthState:f.statePosition,anchorState:x.d.statePosition,ageS:(at-x.d.anchorMs)/1000,raw:ev(x.raw),actualOpinion:ev(x.actualO),actualSmooth:ev(x.actualS),baseOpinion:ev(x.baseO),baseSmooth:ev(x.baseS),candidateOpinion:ev(x.candO),candidateSmooth:ev(x.candS),opinionReconstruction:ev(x.baseO)-ev(x.actualO),smoothReconstruction:ev(x.baseS)-ev(x.actualS),baselineMeta:x.baseline.meta,candidateMeta:x.candidate.meta});
 }
}
const summary=(rs:any[])=>{const result:any={n:rs.length};for(const k of ['raw','actualOpinion','actualSmooth','baseOpinion','baseSmooth','candidateOpinion','candidateSmooth','opinionReconstruction','smoothReconstruction']){const xs=rs.map(r=>r[k]);result[k]={mae:xs.reduce((s,x)=>s+Math.abs(x),0)/xs.length,bias:xs.reduce((s,x)=>s+x,0)/xs.length};}return result;};
const faithful=rows.filter(r=>Math.abs(r.opinionReconstruction)<=2&&Math.abs(r.smoothReconstruction)<=2);
console.log(JSON.stringify({note:'Exact captured raw/modal/leader/previous chain inputs; learned surfaces sampled separately in250m bins, retain only reconstruction<=2m for faithful comparison. One-emission intervention, not chained candidate history or native/client final error. Offline approach phase: AT_STOP45..150m beforeexactcurrentplatform is not stationary; clearinitialmodal/consumption and keepnormalplatformplan. Samephysicalbounds. Historicalcandidatebaseline reconstructed independently.',skippedInputs,emissions:[...histories.values()].reduce((s,h)=>s+h.length,0),all:summary(rows),faithful:summary(faithful),onTrack:summary(faithful.filter(r=>r.truthState==='on_track')),atStop:summary(faithful.filter(r=>r.truthState==='at_stop')),rows},null,2));
