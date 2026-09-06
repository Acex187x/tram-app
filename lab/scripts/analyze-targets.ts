// Compare raw ML, legacy published curves and velocity-aware published curves
// against the SAME later AVL observations (not receive-time truth). Diagnostic
// capture is intentionally case-enriched: this is not a fleetwide MAE estimate.
import fs from 'node:fs';
import readline from 'node:readline';
import {evalTrajectory,prepareHermiteTrack} from '../../src/lib/physics/evaluator';
async function main(): Promise<void> {
const dir=process.argv[2];if(!dir)throw Error('capture directory required');
const debug=fs.readFileSync(`${dir}/debug.jsonl`,'utf8').trim().split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}}).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
const latest=new Map(),lastFix=new Map();let idx=0;
const groups:Record<string,Record<string,number[]>>={};const eligible:{[key:string]:number}={segments:0,cubic:0};
function pack(points:any[],vel?:number[]){const data=new Float64Array(points.flatMap((p:any)=>[p.t,p.s]));if(vel)prepareHermiteTrack(data,new Float64Array(vel));return data;}
function put(group:string,field:string,n:number){(groups[group]??={})[field]??=[];groups[group][field].push(n);}
for await(const line of readline.createInterface({input:fs.createReadStream(`${dir}/wire.jsonl`),crlfDelay:Infinity})){
 let e;try{e=JSON.parse(line);}catch{continue;}if(e.path!=='stream:fullFleet'||!e.value)continue;
 while(idx<debug.length&&debug[idx].receivedAtMs<e.receivedAtMs){const d=debug[idx++].value;if(d.found){latest.set(d.key,{...d,tracks:{raw:pack(d.target),opinion:pack(d.opinion.points),smooth:pack(d.smooth.points),opinionCubic:pack(d.opinion.points,d.opinion.v),smoothCubic:pack(d.smooth.points,d.smooth.v)}});}}
 for(const fix of e.value.vehicles){const previous=lastFix.get(fix.key);lastFix.set(fix.key,fix);if(previous?.observedAtMs===fix.observedAtMs)continue;const d=latest.get(fix.key);if(!d||d.tripId!==fix.tripId||d.anchorMs>=fix.observedAtMs||fix.observedAtMs<d.emittedAtMs+4000||fix.observedAtMs>d.target.at(-1).t)continue;const group=d.statePosition??'unknown';for(const [name,track] of Object.entries(d.tracks)){const err=evalTrajectory(track as Float64Array,fix.observedAtMs)-fix.shapeDistM;put(group,name,err);put('all',name,err);}put('all','observationAgeS',(e.receivedAtMs-fix.observedAtMs)/1000);}
}
function dist(a:number[]){const s=a.slice().sort((a,b)=>Math.abs(a)-Math.abs(b));return{n:a.length,mae:a.reduce((sum,n)=>sum+Math.abs(n),0)/a.length,bias:a.reduce((sum,n)=>sum+n,0)/a.length,p50Abs:Math.abs(s[Math.floor(s.length*.5)]),p90Abs:Math.abs(s[Math.floor(s.length*.9)])};}
console.log(JSON.stringify({debugEmissions:debug.length,groups:Object.fromEntries(Object.entries(groups).map(([g,fields])=>[g,Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,dist(v)]))]))},null,2));

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
