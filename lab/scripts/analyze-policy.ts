// Attribution of downstream policy error using captured, previously available
// diagnostics and delayed AVL truth. Sampling is deliberately case-enriched.
// Usage: tsx lab/scripts/analyze-policy.ts captureDir wireFilename geometryPath
import fs from 'node:fs';
import readline from 'node:readline';
import {evalTrajectory, prepareHermiteTrack} from '../../src/lib/physics/evaluator';
import {buildDriveProfile, curveEnvAt} from '../src/drive';
async function main():Promise<void>{
const [dir,wire='wire.jsonl',geometryPath]=process.argv.slice(2);
if(!dir||!geometryPath)throw Error('capture directory, wire filename and geometry required');
const pack=JSON.parse(fs.readFileSync(geometryPath,'utf8'));
const shapes=new Map<string,any>(pack.shapes.map((g:any)=>[g.shapeId,g]));
const profiles=new Map<string,ReturnType<typeof buildDriveProfile>>();
const debug=fs.readdirSync(dir).filter(n=>/^debug(?:-extra)?\.jsonl$/.test(n)).flatMap(n=>fs.readFileSync(`${dir}/${n}`,'utf8').split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}})).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
const histories=new Map<string,any[]>(),fixes=new Map<string,any>();let cursor=0;
const groups:Record<string,any[]>={},cases:any[]=[],constraints:any[]=[];
const coverage={eligible:0,missing:0,invalidJump:0,priorRevision:0,missingGeometry:0};
const track=(p:any[],vel?:number[])=>prepareHermiteTrack(new Float64Array(p.flatMap(p=>[p.t,p.s])),new Float64Array(p.map((p,i)=>vel?.[i]??p.v??NaN)));
const velocity=(p:Float64Array,t:number)=>(evalTrajectory(p,t+100)-evalTrajectory(p,t-100))*5;
const nearest=(g:any,s:number)=>g?.stops.reduce((m:number,st:any)=>Math.min(m,Math.abs(st.distM-s)),Infinity)??null;
function add(group:string,value:any){(groups[group]??=[]).push(value);}
for await(const line of readline.createInterface({input:fs.createReadStream(`${dir}/${wire}`),crlfDelay:Infinity})){
 let e;try{e=JSON.parse(line);}catch{continue;}if(e.path!=='stream:fullFleet'||!e.value)continue;
 while(cursor<debug.length&&debug[cursor].receivedAtMs<e.receivedAtMs){const event=debug[cursor++],d=event.value;if(!d.found)continue;const h=histories.get(d.key)??[];if(!h.some(v=>v.d.emittedAtMs===d.emittedAtMs))h.push({d,receivedAtMs:event.receivedAtMs,raw:track(d.target),opinion:track(d.opinion.points,d.opinion.v),smooth:track(d.smooth.points,d.smooth.v)});while(h.length>96)h.shift();histories.set(d.key,h);}
 for(const f of e.value.vehicles){const old=fixes.get(f.key);fixes.set(f.key,f);if(old?.observedAtMs===f.observedAtMs)continue;
  const dt=old?.tripId===f.tripId?(f.observedAtMs-old.observedAtMs)/1000:0,ds=old?f.shapeDistM-old.shapeDistM:0;
  if(dt>0&&Math.abs(ds)/dt>22){coverage.invalidJump++;continue;}
  const g=shapes.get(pack.trips[f.tripId]);
  // A generous curve-only minimum: no stops or acceleration from rest. If
  // even this takes longer than the observation interval, the cap conflicts
  // with this AVL pair (or the AVL/shape projection is wrong).
  if(g&&dt>=10&&dt<=120&&ds>=20&&ds<=2000){let profile=profiles.get(g.shapeId);if(!profile){profile=buildDriveProfile(g);profiles.set(g.shapeId,profile);}let minimumS=0;for(let s=old.shapeDistM;s<f.shapeDistM;s+=5){const width=Math.min(5,f.shapeDistM-s);minimumS+=width/Math.max(.1,curveEnvAt(profile,g,s+width/2));}constraints.push({key:f.key,tripId:f.tripId,observedAtMs:f.observedAtMs,dt,ds,minimumS,ratio:minimumS/dt});}
  const h=histories.get(f.key);const x=h?.findLast(x=>x.receivedAtMs<=f.observedAtMs&&x.d.tripId===f.tripId&&x.d.anchorMs<f.observedAtMs&&x.d.emittedAtMs<=f.observedAtMs&&x.d.target.at(-1).t>=f.observedAtMs);
  if(!x){coverage.missing++;continue;}coverage.eligible++;if(x!==h?.at(-1))coverage.priorRevision++;if(!g)coverage.missingGeometry++;
  const t=f.observedAtMs,d=x.d,raw=evalTrajectory(x.raw,t),opinion=evalTrajectory(x.opinion,t),smooth=evalTrajectory(x.smooth,t);
  const anchor=d.fixes.find((v:any)=>v.obsAtMs===d.anchorMs&&v.tripId===d.tripId);
  const initial=d.opinion.points[0];let flatEnd=initial.t;for(const p of d.opinion.points.slice(1)){if(Math.abs(p.s-initial.s)>.05)break;flatEnd=p.t;}
  const row={key:f.key,tripId:f.tripId,observedAtMs:t,emittedAtMs:d.emittedAtMs,anchorMs:d.anchorMs,anchorState:anchor?.statePos??'unknown',truthState:f.statePosition,ageS:(t-d.anchorMs)/1000,horizonS:(t-d.emittedAtMs)/1000,raw:raw-f.shapeDistM,opinion:opinion-f.shapeDistM,smooth:smooth-f.shapeDistM,opinionCost:Math.abs(opinion-f.shapeDistM)-Math.abs(raw-f.shapeDistM),smoothCost:Math.abs(smooth-f.shapeDistM)-Math.abs(opinion-f.shapeDistM),opinionSpeed:velocity(x.opinion,t),smoothSpeed:velocity(x.smooth,t),nearStopM:nearest(g,opinion),truthNearStopM:nearest(g,f.shapeDistM),initialHoldS:(flatEnd-initial.t)/1000,discontinuity:d.discontinuity};
  add('all',row);add(`anchor:${row.anchorState}`,row);add(`truth:${row.truthState}`,row);add(`horizon:${row.horizonS<15?'0-15':row.horizonS<30?'15-30':row.horizonS<60?'30-60':'60+'}`,row);
  if(row.opinionSpeed<.2)add(t<=flatEnd?'initial-hold':row.nearStopM!==null&&row.nearStopM<30?'later-stop-hold':'other-flat',row);else add('moving-opinion',row);
  cases.push(row);
 }
}
function stat(values:number[]){const a=values.map(Math.abs).sort((a,b)=>a-b);return{n:values.length,mae:values.reduce((s,v)=>s+Math.abs(v),0)/values.length,bias:values.reduce((s,v)=>s+v,0)/values.length,p90Abs:a[Math.floor(a.length*.9)]};}
console.log(JSON.stringify({note:'Case-enriched diagnostic sample. Curves must have been received before observation time. Curve-only constraints omit stops and start acceleration; AVL/shape is still a proxy.',coverage,groups:Object.fromEntries(Object.entries(groups).map(([k,rows])=>[k,Object.fromEntries(['raw','opinion','smooth','opinionCost','smoothCost'].map(field=>[field,stat(rows.map(r=>r[field]))]))])),curveConstraints:{n:constraints.length,over10Percent:constraints.filter(x=>x.ratio>1.1).length,over25Percent:constraints.filter(x=>x.ratio>1.25).length,worst:constraints.sort((a,b)=>b.ratio-a.ratio).slice(0,20)},worstPolicy:cases.sort((a,b)=>b.opinionCost-a.opinionCost).slice(0,30)},null,2));
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
