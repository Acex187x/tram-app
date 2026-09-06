jest.mock('../lab/src/db', () => ({round2:(n:number)=>Math.round(n*100)/100}));
import type {RouteGeometry} from '../src/lib/types';
import {consumedPlatform} from '../lab/src/servedPlatform';
import {buildDriveVehicle, type DriveArgs} from '../lab/src/drive';
import {evalTrack, clientSmoothProjectionM} from '../lab/src/trajectory';
import {straightGeometry} from './physicsFixtures';
import fixture from '../docs/research/tracking-2026-09-05/served-platform-exact-fixture.json';

const geom = straightGeometry([
 {stopId:'before',sequence:1,distM:0},
 {stopId:'current',sequence:2,distM:200},
 {stopId:'next',sequence:3,distM:800},
 {stopId:'end',sequence:4,distM:1000,isTerminal:true},
]);
const evidence = {stopId:'current',sequence:2,nextStopId:'next',nextSequence:3};
const modal = {stopS:140,releaseAtMs:120000};
it('consumes only the unambiguous current platform and requires its ordered successor',()=>{
 expect(consumedPlatform(evidence,modal,geom)).toBe(geom.stops[1]);
 for(const e of [null,{...evidence,sequence:null},{...evidence,nextSequence:2},{...evidence,nextStopId:'missing'},{...evidence,sequence:9}])
  expect(consumedPlatform(e,modal,geom)).toBeNull();
 expect(consumedPlatform(evidence,null,geom)).toBeNull();
 for(const stopS of [49,200,201,NaN]) expect(consumedPlatform(evidence,{...modal,stopS},geom)).toBeNull();
 expect(consumedPlatform(evidence,{...modal,stopS:50},geom)).toBe(geom.stops[1]);
});
it('retains terminal, intervening-platform and ambiguous loop stops',()=>{
 expect(consumedPlatform(evidence,modal,{...geom,stops:geom.stops.map(s=>s.stopId==='current'?{...s,isTerminal:true}:s)})).toBeNull();
 expect(consumedPlatform(evidence,modal,{...geom,stops:[...geom.stops,{...geom.stops[1],sequence:7,distM:900}]})).toBeNull();
 expect(consumedPlatform(evidence,modal,{...geom,stops:[geom.stops[0],{...geom.stops[0],stopId:'intermediate',distM:180},...geom.stops.slice(1)]})).toBeNull();
});
const surface = fixture.surface;
const exact: DriveArgs = {
 ...(fixture.inputs as unknown as DriveArgs),
 geom:surface.geom as unknown as RouteGeometry,
 surfaces:{paceAt:s=>surface.pace[Math.min(surface.pace.length-1,Math.max(0,Math.floor(s/250)))],dwellStats:id=>(surface.dwell as Record<string,{mean:number;sd:number;trusted:boolean}>)[id]??{mean:18,sd:8,trusted:false}},
 servedPlatform:{stopId:fixture.case.lastStopId,sequence:fixture.case.lastStopSequence,nextStopId:fixture.case.nextStopId,nextSequence:fixture.case.rawFix.nextStopSequence},
};
const holdsAt = (points:{t:number;s:number}[], s:number) => points.slice(1).filter((p,i)=>Math.abs(p.s-s)<3&&Math.abs(p.s-points[i].s)<.05&&p.t-points[i].t>=2000);
it('removes the exact captured second dwell while retaining the initial modal dwell and physical gates',()=>{
 const old=buildDriveVehicle({...exact,servedPlatform:null})!;
 const next=buildDriveVehicle(exact)!;
 expect(holdsAt(old.vehicle.opinion,fixture.case.platformDistM).length).toBeGreaterThan(0);
 expect(holdsAt(next.vehicle.opinion,fixture.case.platformDistM)).toHaveLength(0);
 expect(next.meta.consumedPlatform?.stopId).toBe(fixture.case.lastStopId);
 const release=exact.modal!.releaseAtMs;
 expect(evalTrack(next.vehicle.opinion,release-1000)).toBeCloseTo(exact.modal!.stopS,1);
 expect(evalTrack(next.vehicle.opinion,release+10000)).toBeGreaterThan(exact.modal!.stopS+10);
 for(const k of ['opinion','smooth'] as const){
  expect(next.meta[k].curveViolations).toBe(0);
  expect(next.meta[k].collisionViolations).toBe(0);
  expect(next.meta[k].midSegmentStops).toBe(0);
 }
});
it('an unsupported moving fix still before the platform conservatively rebuilds the regular plan without sticky consumption and preserves the chain seam',()=>{
 const first=buildDriveVehicle(exact)!;
 const at=exact.emittedAtMs+2000;
 const moving:DriveArgs={...exact,anchorMs:at,emittedAtMs:at,modal:null,servedPlatform:null,
  raw:exact.raw.map(p=>({...p,t:p.t+2000})),
  prev:{tripId:exact.tripId,opinion:first.opinion,smooth:first.smooth},
  anchorFixS:exact.modal!.stopS+1,clientFixS:exact.modal!.stopS+1,prevFixS:exact.modal!.stopS,fixGapS:2};
 const next=buildDriveVehicle(moving)!;
 expect(next.meta.consumedPlatform).toBeNull();
 expect(holdsAt(next.vehicle.opinion,fixture.case.platformDistM).length).toBeGreaterThan(0);
 expect(Math.abs(next.vehicle.smooth[0].s-evalTrack(first.vehicle.smooth,at))).toBeLessThan(2);
 expect(next.vehicle.discontinuity).toBe(false);
 const newTrip=buildDriveVehicle({...moving,tripId:'new-trip',prev:moving.prev})!;
 expect(newTrip.meta.consumedPlatform).toBeNull();
 expect(newTrip.vehicle.discontinuity).toBe(true);
});
it('the recorded next moving fix is beyond the served platform and cannot reintroduce its dwell across emissions',()=>{
 const first=buildDriveVehicle(exact)!;
 const fix=fixture.transition.current;
 expect(fix.shapeDistM).toBeGreaterThanOrEqual(fixture.case.platformDistM);
 const moving:DriveArgs={...exact,...fixture.movingInputs as unknown as DriveArgs,
  geom:exact.geom,surfaces:exact.surfaces,servedPlatform:null,
  prev:{tripId:exact.tripId,opinion:first.opinion,smooth:first.smooth}};
 const next=buildDriveVehicle(moving)!;
 expect(next.meta.consumedPlatform).toBeNull();
 expect(next.vehicle.opinion[0].s).toBeGreaterThanOrEqual(fix.shapeDistM);
 expect(holdsAt(next.vehicle.opinion,fixture.case.platformDistM)).toHaveLength(0);
 expect(Math.abs(next.vehicle.smooth[0].s-clientSmoothProjectionM(first.vehicle.smooth,moving.clientFixS!,moving.anchorMs,moving.emittedAtMs))).toBeLessThan(2);
 for(const k of ['opinion','smooth'] as const){
  expect(next.meta[k].curveViolations).toBe(0);
  expect(next.meta[k].midSegmentStops).toBe(0);
 }
});
