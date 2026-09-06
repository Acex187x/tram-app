/** Captured-fleet JS source budget, not a native/GPU benchmark.
 * Same wire replay and current feature builder; only submission cadence differs.
 * tsx --tsconfig lab/tsconfig.runtime.json bench/src/map-delivery-cost.ts wire geometry
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { TramFleet } from '@/lib/physics/fleet';
import { TrajectoryStore } from '@/lib/physics/trajectoryStore';
import { servedToRouteGeometry } from '@/lib/golemio/gtfs';
import { buildFrame, expandBbox, BADGE_CULL_MARGIN_M } from '@/lib/render/featureBuilder';
import { getModelSpec, regNumberToModelId, isLikelyCoupledPair } from '@/lib/fleet/registry';
import type { RouteGeometry, TramSnapshot, TramPublicState } from '@/lib/types';
// Asset IDs do not participate in pure feature construction; Node has no Metro.
for (const ext of ['.png', '.glb']) require.extensions[ext] = (module) => { module.exports = 0; };
const [wire, geometry] = process.argv.slice(2);
const rows = readFileSync(wire, 'utf8').split('\n').flatMap((line) => { try { const r = JSON.parse(line); return r.value ? [r] : []; } catch { return []; } }).sort((a,b)=>a.receivedAtMs-b.receivedAtMs);
const pack = JSON.parse(readFileSync(geometry, 'utf8'));
const shapes = new Map<string, RouteGeometry>(pack.shapes.map((s: any) => [s.shapeId, servedToRouteGeometry(s, rows[0].receivedAtMs)]));
const geometries = new Map<string, RouteGeometry>();
for (const [trip, shape] of Object.entries(pack.trips)) { const g=shapes.get(String(shape)); if(g) geometries.set(trip,{...g,tripId:trip}); }
const store = new TrajectoryStore();
const fleet = new TramFleet({trajectories:store,resolveModel:s=>getModelSpec(regNumberToModelId(s.registrationNumber))});
const fixes = new Map<string,TramSnapshot>();
let index=0, cursor=-1;
const start=rows[0].receivedAtMs, end=Math.min(start+60000,rows.at(-1).receivedAtMs);
const frames: {at:number; states:TramPublicState[]; geometry:Map<string, RouteGeometry|undefined>}[]=[];
for(let at=start;at<=end;at+=100) {
 while(index<rows.length&&rows[index].receivedAtMs<=at) {
  const r=rows[index++],v=r.value;
  if(r.path==='stream:fullFleet') {fixes.clear();for(const s of v.vehicles)fixes.set(s.key,s);fleet.ingest([...fixes.values()],t=>geometries.get(t));}
  else if(r.path==='stream:batchesSince') {for(const b of v.batches){for(const s of b.changed)fixes.set(s.key,s);for(const k of b.removed??[])fixes.delete(k);}fleet.ingest([...fixes.values()],t=>geometries.get(t));}
  else if(r.path==='trajectories:fullSet'){store.seedConvex(v.vehicles,v.meta,r.receivedAtMs);cursor=v.seq;}
  else if(r.path==='trajectories:batchesSince'){for(const b of v.batches)if(b.seq>cursor){store.foldConvex(b,v.serverNowMs,r.receivedAtMs);cursor=b.seq;}}
  else if(r.path==='trajectories:meta')store.noteConvexMeta(v,r.receivedAtMs);
  else if(r.path==='clock:now'&&typeof r.sentAtMs==='number')store.noteConvexClock(v.serverNowMs,r.sentAtMs,r.receivedAtMs);
 }
 const states=fleet.getStates(at,'smooth',true);
 frames.push({at,states,geometry:new Map(states.map(s=>[s.key,fleet.getGeometry(s.key)]))});
 // Virtual native acceptance for fixture generation, never a phone/GPU claim.
 for(const s of states)if(s.presentationOpacity===0&&s.presentationHiddenFrameId!=null)fleet.acknowledgePresentationHidden(s.key,s.presentationHiddenFrameId);
}
const results=[];
for(const zoom of [11,13.5]) for(let trial=1;trial<=3;trial++) for(const cadence of ['former','10Hz','adaptive']) {
 const viewport={zoom,bbox:[14.25,49.95,14.65,50.15] as [number,number,number,number]};
 const bounds=expandBbox(viewport.bbox,BADGE_CULL_MARGIN_M),memory=new Map();
 const interval=cadence==='10Hz'?100:cadence==='adaptive'?(zoom<12.5?400:200):zoom<12.5?5000:1000;
 const last=new Map<string,string>();let due=0,pushes=0,chars=0,bytes=0,unchanged=0,builds=0;
 const costs=[]; const begin=performance.now();
 for(const frame of frames){if(frame.at<due)continue;due=frame.at+interval;const before=performance.now();
  const states=frame.states.filter(s=>s.position[0]>=bounds[0]&&s.position[0]<=bounds[2]&&s.position[1]>=bounds[1]&&s.position[1]<=bounds[3]);
  const f=buildFrame(states,viewport,{nowMs:frame.at,selectedKey:null,favoriteKeys:new Set(),coupledPairFn:k=>{const s=fixes.get(k);return s?isLikelyCoupledPair(regNumberToModelId(s.registrationNumber),s.line):false;},getGeometry:k=>frame.geometry.get(k),badgeMemory:memory});builds++;
  for(const [key,fc] of [['points',f.points],['badges',f.badges]] as const){const payload=JSON.stringify(fc);if(last.get(key)===payload){unchanged++;continue;}last.set(key,payload);pushes++;chars+=payload.length;bytes+=Buffer.byteLength(payload);}
  costs.push(performance.now()-before);
 }
 costs.sort((a,b)=>a-b);
 results.push({zoom,trial,cadence,intervalMs:interval,builds,pushes,unchanged,payloadChars:chars,payloadBytes:bytes,KiBPerSecond:bytes/1024/((end-start)/1000),totalJsMs:performance.now()-begin,p95FrameMs:costs[Math.floor(costs.length*.95)]});
}
console.log(JSON.stringify({kind:'Captured 60s fleet, same current builder, cadence-only JS comparison; no native API/GPU measurement',wire,geometry,start,end,maximumFleet:Math.max(...frames.map(f=>f.states.length)),results},null,2));
