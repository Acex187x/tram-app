// Analyze a bounded capture of the *published* Convex curves and raw AVL.
// Usage: node lab/scripts/analyze-wire.mjs wire.jsonl geometry.json
// This measures wire curves, not the client's presentation guard; pair it
// with bench replay before attributing a symptom to the phone.
import fs from 'node:fs';
import readline from 'node:readline';
const [wirePath,geometryPath]=process.argv.slice(2);
if(!wirePath||!geometryPath)throw Error('wire.jsonl and geometry.json required');
const pack=JSON.parse(fs.readFileSync(geometryPath,'utf8'));
const shapes=new Map(pack.shapes.map(g=>[g.shapeId,g]));
const curves=new Map(),fixes=new Map(),episodes=new Map(),history=new Map();
const counters={samples:0,missingGeometry:0,scoreInvalidJump:0,scoreNoEligible:0,scorePriorRevision:0,stopped:0,stoppedAtPlatform:0,smoothStoppedOpinionMoving:0,stoppedFreshFixAhead:0,expired:0,revisions:0,discontinuities:0,unflaggedBackSeams:0,unflaggedForwardSeams:0,velocitySeamsOver2:0};
const arrays={seamM:[],unflaggedSeamM:[],velocitySeam:[],holdSeconds:[],opinionErrorAtArrival:[],smoothErrorAtArrival:[],opinionErrorAtObservation:[],smoothErrorAtObservation:[],fixAgeS:[],curveAgeS:[],clockSampleOffsetMs:[]};
const cases=[];let firstMs=Infinity,lastMs=0,errors=0;
function ev(p,t){if(t<=p[0].t)return p[0].s;let lo=0,hi=p.length-1;if(t>=p[hi].t)return p[hi].s;while(hi-lo>1){const m=(lo+hi)>>1;if(p[m].t<=t)lo=m;else hi=m;}return p[lo].s+(p[hi].s-p[lo].s)*(t-p[lo].t)/(p[hi].t-p[lo].t);}
const vel=(p,t)=>(ev(p,t+500)-ev(p,t-500));
const nearStop=(g,s)=>g?g.stops.reduce((m,st)=>Math.min(m,Math.abs(st.distM-s)),Infinity):null;
function close(key){const e=episodes.get(key);if(e&&e.end-e.start>=3000){arrays.holdSeconds.push((e.end-e.start)/1000);if(e.contradicted||e.smoothHeld){cases.push({...e,durationS:(e.end-e.start)/1000});}}episodes.delete(key);}
for await(const line of readline.createInterface({input:fs.createReadStream(wirePath),crlfDelay:Infinity})){
 let event;try{event=JSON.parse(line);}catch{continue;}const now=event.receivedAtMs;firstMs=Math.min(firstMs,now);lastMs=Math.max(lastMs,now);if(event.error){errors++;continue;}
 if(event.path==='stream:fullFleet'){
  for(const fix of event.value.vehicles){
   const old=fixes.get(fix.key),v=curves.get(fix.key);
   if(old&&old.tripId===fix.tripId&&fix.observedAtMs>old.observedAtMs){
    const gap=(fix.observedAtMs-old.observedAtMs)/1000;
    if(Math.abs(fix.shapeDistM-old.shapeDistM)/gap>22){counters.scoreInvalidJump++;}
    else {
     if(v&&v.tripId===fix.tripId&&v.anchorMs<fix.observedAtMs)for(const name of ['opinion','smooth'])arrays[`${name}ErrorAtArrival`].push(ev(v[name],now)-fix.shapeDistM);
     const eligible=history.get(fix.key)?.findLast(e=>e.atMs<=fix.observedAtMs&&e.v.tripId===fix.tripId&&e.v.anchorMs<fix.observedAtMs&&e.v.smooth[0].t<=fix.observedAtMs&&e.v.smooth.at(-1).t>=fix.observedAtMs);
     if(!eligible)counters.scoreNoEligible++;
     else {if(eligible.v.emittedAtMs!==v?.emittedAtMs)counters.scorePriorRevision++;for(const name of ['opinion','smooth'])arrays[`${name}ErrorAtObservation`].push(ev(eligible.v[name],fix.observedAtMs)-fix.shapeDistM);}
    }
   }
   fixes.set(fix.key,fix);
  }
 }else if(event.path==='trajectories:fullSet'){
  if(event.value.meta)arrays.clockSampleOffsetMs.push(event.value.meta.serverNowMs-now);
  for(const v of event.value.vehicles){const old=curves.get(v.key);if(old&&old.tripId===v.tripId&&old.emittedAtMs!==v.emittedAtMs){counters.revisions++;if(v.discontinuity)counters.discontinuities++;const seam=ev(v.smooth,v.emittedAtMs)-ev(old.smooth,v.emittedAtMs),dv=vel(v.smooth,now)-vel(old.smooth,now);arrays.seamM.push(seam);arrays.velocitySeam.push(Math.abs(dv));if(!v.discontinuity){arrays.unflaggedSeamM.push(seam);if(seam < -2)counters.unflaggedBackSeams++;if(seam > 2)counters.unflaggedForwardSeams++;if(Math.abs(dv)>2)counters.velocitySeamsOver2++;}}
   if(!old||old.emittedAtMs!==v.emittedAtMs){let h=history.get(v.key);if(!h)history.set(v.key,h=[]);h.push({v,atMs:now});while(h.length>32)h.shift();}
   curves.set(v.key,v);const f=fixes.get(v.key);if(!f||f.tripId!==v.tripId)continue;counters.samples++;arrays.fixAgeS.push((now-f.observedAtMs)/1000);arrays.curveAgeS.push((now-v.emittedAtMs)/1000);const s=ev(v.smooth,now),speed=vel(v.smooth,now),ov=vel(v.opinion,now),g=shapes.get(pack.trips[v.tripId]),stopDistanceM=nearStop(g,s);if(!g)counters.missingGeometry++;const expired=now>v.smooth.at(-1).t;if(expired)counters.expired++;
   if(speed<.2){counters.stopped++;if(stopDistanceM!==null&&stopDistanceM<=30)counters.stoppedAtPlatform++;const smoothHeld=ov>.5,contradicted=f.shapeDistM-s>60&&now-f.observedAtMs<30000;if(smoothHeld)counters.smoothStoppedOpinionMoving++;if(contradicted)counters.stoppedFreshFixAhead++;
    let e=episodes.get(v.key);if(!e||e.tripId!==v.tripId||now-e.end>6000||Math.abs(s-e.s)>3){close(v.key);episodes.set(v.key,e={key:v.key,tripId:v.tripId,start:now,end:now,s,stopDistanceM,fixState:f.statePosition,contradicted:false,smoothHeld:false,expired:false});}e.end=now;e.contradicted||=contradicted;e.smoothHeld||=smoothHeld;e.expired||=expired;
   }else close(v.key);
  }
 }
}
for(const key of episodes.keys())close(key);
function distribution(a){const sorted=a.toSorted((a,b)=>a-b),q=p=>sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]??null;const abs=a.map(Math.abs).toSorted((a,b)=>a-b);return{p50Abs:abs[Math.floor(abs.length*.5)]??null,p90Abs:abs[Math.floor(abs.length*.9)]??null,p99Abs:abs[Math.floor(abs.length*.99)]??null,n:a.length,mean:a.length?a.reduce((a,b)=>a+b,0)/a.length:null,mae:a.length?a.reduce((a,b)=>a+Math.abs(b),0)/a.length:null,p50:q(.5),p90:q(.9),p99:q(.99),min:sorted[0]??null,max:sorted.at(-1)??null};}
console.log(JSON.stringify({firstMs,lastMs,durationS:(lastMs-firstMs)/1000,errors,counters,distributions:Object.fromEntries(Object.entries(arrays).map(([k,a])=>[k,distribution(a)])),cases:cases.toSorted((a,b)=>b.durationS-a.durationS).slice(0,30)},null,2));
