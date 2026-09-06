// Offline counterfactual only. esbuild changes a private in-memory copy of
// drive.ts; no runtime source, constants, persisted cells or server is changed.
// Usage: node lab/scripts/counterfactual-local-pace.mjs CAPTURE_DIR > result.json
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capture = process.argv[2];
if (!capture) throw Error('capture directory required');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tram-local-pace-study-'));
const program = "import fs from 'node:fs';\nimport { buildDriveVehicle, setExperimentalLocalPace } from './src/drive';\nimport { evalTrajectory, prepareHermiteTrack } from '../src/lib/physics/evaluator';\nconst dir=process.argv[2]; if(!dir) throw Error('capture directory required');\nconst surfaces=JSON.parse(fs.readFileSync(dir+'/surfaces.json','utf8'));\nconst debug=['debug.jsonl','debug-extra.jsonl'].flatMap(n=>fs.readFileSync(dir+'/'+n,'utf8').split('\\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}})).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);\nconst histories=new Map<string,any[]>(); let skippedInputs=0;\nconst track=(points:any[],v?:number[])=>prepareHermiteTrack(new Float64Array(points.flatMap(p=>[p.t,p.s])),new Float64Array(points.map((p,i)=>v?.[i]??p.v??NaN)));\nfor(const event of debug){const d=event.value,inputs=d.policy?.inputs;if(!inputs||!d.publish?.synced||d.emittedAtMs!==inputs.emittedAtMs||event.receivedAtMs<1788645000000)continue;const h=histories.get(d.key)??[];if(h.some(x=>x.d.emittedAtMs===d.emittedAtMs))continue;\n const table=surfaces.trips[d.tripId];if(!table){skippedInputs++;continue;}\n const args={...inputs,geom:table.geom,surfaces:{paceAt:(s:number)=>table.pace[Math.min(table.pace.length-1,Math.max(0,Math.floor(s/250)))],dwellStats:(id:string)=>table.dwell[id]??{mean:18,sd:8,trusted:false}}};\n setExperimentalLocalPace(false);const baseline=buildDriveVehicle(args);setExperimentalLocalPace(true);const candidate=buildDriveVehicle(args);if(!baseline||!candidate)continue;\n h.push({d,received:event.receivedAtMs,baseline,candidate,actualO:track(d.opinion.points,d.opinion.v),actualS:track(d.smooth.points,d.smooth.v),baseO:track(baseline.vehicle.opinion),baseS:track(baseline.vehicle.smooth),candO:track(candidate.vehicle.opinion),candS:track(candidate.vehicle.smooth),raw:track(d.target)});histories.set(d.key,h);\n}\nconst seen=new Set<string>(),rows:any[]=[];let fleet=new Map<string,any>();\nfor(const line of fs.readFileSync(dir+'/candidate-wire.jsonl','utf8').split('\\n')){let e;try{e=JSON.parse(line)}catch{continue;}let fixes:any[]=[];\n if(e.path==='stream:fullFleet'){fixes=e.value.vehicles;fleet=new Map(fixes.map(f=>[f.key,f]));}\n else if(e.path==='stream:batchesSince'){for(const batch of e.value.batches){fixes.push(...(batch.changed??[]));for(const key of batch.removed??[])fleet.delete(key);}}\n else continue;\n for(const f of fixes){fleet.set(f.key,f);const id=f.key+'|'+f.tripId+'|'+f.observedAtMs;if(seen.has(id))continue;seen.add(id);const x=histories.get(f.key)?.findLast(x=>x.received<=f.observedAtMs&&x.d.tripId===f.tripId&&x.d.anchorMs<f.observedAtMs&&x.d.emittedAtMs<=f.observedAtMs&&x.d.target.at(-1).t>=f.observedAtMs);if(!x)continue;\n const at=f.observedAtMs,ev=(tr:Float64Array)=>evalTrajectory(tr,at)-f.shapeDistM;\n rows.push({key:f.key,tripId:f.tripId,observedAtMs:at,emittedAtMs:x.d.emittedAtMs,truthState:f.statePosition,anchorState:x.d.statePosition,ageS:(at-x.d.anchorMs)/1000,raw:ev(x.raw),actualOpinion:ev(x.actualO),actualSmooth:ev(x.actualS),baseOpinion:ev(x.baseO),baseSmooth:ev(x.baseS),candidateOpinion:ev(x.candO),candidateSmooth:ev(x.candS),opinionReconstruction:ev(x.baseO)-ev(x.actualO),smoothReconstruction:ev(x.baseS)-ev(x.actualS),baselineMeta:x.baseline.meta,candidateMeta:x.candidate.meta});\n }\n}\nconst summary=(rs:any[])=>{const result:any={n:rs.length};for(const k of ['raw','actualOpinion','actualSmooth','baseOpinion','baseSmooth','candidateOpinion','candidateSmooth','opinionReconstruction','smoothReconstruction']){const xs=rs.map(r=>r[k]);result[k]={mae:xs.reduce((s,x)=>s+Math.abs(x),0)/xs.length,bias:xs.reduce((s,x)=>s+x,0)/xs.length};}return result;};\nconst faithful=rows.filter(r=>Math.abs(r.opinionReconstruction)<=2&&Math.abs(r.smoothReconstruction)<=2);\nconsole.log(JSON.stringify({note:'Exact captured raw/modal/leader/previous chain inputs; learned surfaces sampled separately in250m bins, retain only reconstruction<=2m for faithful comparison. One-emission intervention, not chained candidate history or native/client final error. Only in-horizon no-crossing fallback pace changes, all physical limits remain.',skippedInputs,emissions:[...histories.values()].reduce((s,h)=>s+h.length,0),all:summary(rows),faithful:summary(faithful),onTrack:summary(faithful.filter(r=>r.truthState==='on_track')),atStop:summary(faithful.filter(r=>r.truthState==='at_stop')),rows},null,2));\n";
try {
  await esbuild.build({
    stdin: { contents: program, loader: 'ts', resolveDir: lab },
    bundle: true, platform: 'node', outfile: path.join(temporary, 'study.cjs'),
    tsconfig: path.join(lab, 'tsconfig.runtime.json'),
    plugins: [{name:'offline-intervention',setup(build) {
      build.onResolve({filter:/^\.\/db$/}, () => ({path:'db-stub',namespace:'stub'}));
      build.onLoad({filter:/.*/,namespace:'stub'}, () => ({contents:'export const round2=n=>Math.round(n*100)/100; export const pct=()=>{throw Error("unused DB helper")}',loader:'js'}));
      build.onLoad({filter:/\/lab\/src\/drive\.ts$/}, args => {
        const source=fs.readFileSync(args.path,'utf8');
        const marker="    if (mode !== 'ladder') return;";
        if (source.split(marker).length !== 2) throw Error('drive intervention target changed; review study');
        const replacement=marker+"\n    const availableMs=Math.min(30000,raw[raw.length-1].t-tDepMs);\n    const tailPace=EXPERIMENTAL_LOCAL_PACE && availableMs>=5000 ? Math.max(0,(evalTrack(raw,tDepMs+availableMs)-evalTrack(raw,tDepMs))/(availableMs/1000)) : mlTailPace(raw);";
        return {contents:'let EXPERIMENTAL_LOCAL_PACE = false; export function setExperimentalLocalPace(value:boolean){EXPERIMENTAL_LOCAL_PACE=value;}\n'+source.replace(marker,replacement),loader:'ts'};
      });
    }}],
  });
  const result=spawnSync(process.execPath,[path.join(temporary,'study.cjs'),path.resolve(capture)],{stdio:'inherit'});
  if(result.error) throw result.error;
  process.exitCode=result.status??1;
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
