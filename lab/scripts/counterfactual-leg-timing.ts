// Controlled one-emission counterfactual. Both candidates inherit the exact
// same published seam and use captured ML targets/learned surfaces. It does
// not reconstruct unexposed queue leadership and cannot alone authorize a
// production policy change; compare reconstruction error alongside accuracy.
import fs from 'node:fs';
import readline from 'node:readline';
import {buildDriveVehicle,type DriveArgs} from '../src/drive';
import {evalTrack} from '../src/trajectory';
import {RealismCounters} from '../src/realism';
async function main(): Promise<void> {
const dir=process.argv[2];if(!dir)throw Error('capture directory required');
const policy=process.argv[3]??'leg-timing';
if(!['baseline','leg-timing','modal-clock','dwell-key'].includes(policy))throw Error('unknown counterfactual');
const surface=JSON.parse(fs.readFileSync(`${dir}/surfaces.json`,'utf8'));
const ds=fs.readFileSync(`${dir}/debug.jsonl`,'utf8').trim().split('\n').flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}}).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
const previous=new Map(),latest=new Map(),lastFix=new Map();let i=0;
const values:Record<string,number[]>={actual:[],baseline:[],candidate:[],reconstruction:[],change:[]};let built=0,failed=0;const realism=new RealismCounters();
function build(d:any){const table=surface.trips[d.tripId];if(!table)return;const p=previous.get(d.key);previous.set(d.key,d);
 const raw=d.target.map((p:any)=>({...p}));if(raw.length<2)return;const last=raw.at(-1),before=raw.at(-2);raw.push({t:last.t+10000,s:Math.min(table.geom.totalM,last.s+Math.max(0,last.s-before.s))});
 const pts=d.opinion.points;let modal=null;let h=0;while(h+1<pts.length&&Math.abs(pts[h+1].s-pts[0].s)<.02)h++;if(h>0&&d.statePosition==='at_stop')modal={stopS:pts[0].s,releaseAtMs:pts[h].t};
 const same=p?.tripId===d.tripId;
 const args:DriveArgs={key:d.key,tripId:d.tripId,line:d.line,anchorMs:d.anchorMs,emittedAtMs:d.emittedAtMs,raw,geom:table.geom,surfaces:{paceAt:s=>table.pace[Math.min(table.pace.length-1,Math.max(0,Math.floor(s/250)))],dwellStats:id=>table.dwell[id]??{mean:18,sd:8,trusted:false}},modal,fixGapS:d.latestFix?.fixGapS??30,anchorFixS:d.anchorFix?.s,clientFixS:d.anchorFix?.s,prevFixS:same&&p.anchorMs!==d.anchorMs?p.anchorFix?.s:undefined,ageFloorS:same&&p.anchorMs===d.anchorMs?evalTrack(p.opinion.points,d.emittedAtMs):0,stuckAtM:d.latestFix?.stuckAtM,prev:same?{tripId:d.tripId,opinion:p.opinion,smooth:p.smooth}:null};
 const nextStopKey=new Map(table.geom.stops.slice(0,-1).map((st:any,index:number)=>[st.stopId,table.geom.stops[index+1].stopId]));
 const candidate=policy==='baseline'?args:policy==='modal-clock'?{...args,modal:args.modal?{...args.modal,releaseAtMs:args.modal.releaseAtMs-5000}:null}:policy==='dwell-key'?{...args,surfaces:{...args.surfaces,dwellStats:(id:string)=>table.dwell[nextStopKey.get(id) as string]??{mean:18,sd:8,trusted:false}}}:{...args,kinematicLegTiming:true};
 const a=buildDriveVehicle(args),b=buildDriveVehicle(candidate);if(!a||!b){failed++;return;}built++;for(const tr of [a.vehicle.opinion,a.vehicle.smooth,b.vehicle.opinion,b.vehicle.smooth]){realism.check(d.key,'opinion',tr,d.emittedAtMs);}latest.set(d.key,{d,a,b,modal:args.modal!==null});}
for await(const line of readline.createInterface({input:fs.createReadStream(`${dir}/wire.jsonl`),crlfDelay:Infinity})){
 let e;try{e=JSON.parse(line);}catch{continue;}if(e.path!=='stream:fullFleet'||!e.value)continue;
 while(i<ds.length&&ds[i].receivedAtMs<e.receivedAtMs)build(ds[i++].value);
 for(const f of e.value.vehicles){const p=lastFix.get(f.key);lastFix.set(f.key,f);if(p?.observedAtMs===f.observedAtMs)continue;const x=latest.get(f.key);if(!x||x.d.tripId!==f.tripId||f.observedAtMs<x.d.emittedAtMs+4000||f.observedAtMs>x.d.target.at(-1).t||x.d.anchorMs>=f.observedAtMs)continue;
 const actual=evalTrack(x.d.opinion.points,f.observedAtMs),a=evalTrack(x.a.vehicle.opinion,f.observedAtMs),b=evalTrack(x.b.vehicle.opinion,f.observedAtMs);values.actual.push(actual-f.shapeDistM);values.baseline.push(a-f.shapeDistM);values.candidate.push(b-f.shapeDistM);values.reconstruction.push(a-actual);values.change.push(b-a);if(x.modal){(values.modalBaseline??=[]).push(a-f.shapeDistM);(values.modalCandidate??=[]).push(b-f.shapeDistM);}
 }
}
const stats=(a:number[])=>{const s=a.map(Math.abs).sort((a,b)=>a-b);return{n:a.length,mae:a.reduce((s,n)=>s+Math.abs(n),0)/a.length,bias:a.reduce((s,n)=>s+n,0)/a.length,p90Abs:s[Math.floor(.9*s.length)]};};
console.log(JSON.stringify({policy,built,failed,realism:realism.gauges(),note:'Case-enriched sample; identical inherited seams; queue leadership not captured. Experimental flag remains off.',stats:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,stats(v)]))},null,2));

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
