jest.mock('../lab/src/db',()=>({round2:(x:number)=>Math.round(x*100)/100}));
import {assessMotionPhase,legacyDwellSuccessor} from '../lab/src/motionPolicy';
import {buildDriveVehicle,type DriveArgs} from '../lab/src/drive';
import {evalContinuousTrack} from '../lab/src/trajectory';
import {pointAt} from '../src/lib/geo/polyline';
import {straightGeometry,snapshot} from './physicsFixtures';
const geom=straightGeometry([{stopId:'previous',distM:0},{stopId:'current',distM:300},{stopId:'next',distM:800},{stopId:'end',distM:1100,isTerminal:true}]);
const fix=(s:number,at:number)=>snapshot({observedAtMs:at,coordinates:pointAt(geom.coordinates,geom.cumDistM,s),shapeDistM:s,statePosition:'at_stop',lastStopId:'current',lastStopSequence:2,nextStopId:'next',nextStopSequence:3});
it('treats announcement with causal motion as approach, never automatically zero speed',()=>{
 const f=fix(220,100000),p=fix(180,90000),phase=assessMotionPhase(f,p,geom,108000,()=>8);
 expect(phase.kind).toBe('approach');expect(phase.approach?.speedMs).toBeCloseTo(4,3);expect(phase.approach?.paceEvidence).toBe('observed-span');
 expect(assessMotionPhase(f,undefined,geom,108000,()=>30).approach?.speedMs).toBe(13.9);
 expect(assessMotionPhase(f,{...p,tripId:'other'},geom,108000,()=>8).approach?.paceEvidence).toBe('learned-fallback');
});
it('bounds admission and leaves missing, expired or near-platform evidence uncertain',()=>{
 expect(assessMotionPhase(fix(290,100000),undefined,geom,108000,()=>8).kind).toBe('probable-dwell');
 expect(assessMotionPhase(fix(100,100000),undefined,geom,108000,()=>8).approach).toBeNull();
 expect(assessMotionPhase(fix(220,100000),undefined,geom,220000,()=>8).approach).toBeNull();
 expect(assessMotionPhase({...fix(220,100000),nextStopId:null},undefined,geom,108000,()=>8).approach).toBeNull();
 expect(assessMotionPhase({...fix(220,100000),statePosition:'on_track'},undefined,geom,108000,()=>8).kind).toBe('moving');
});
it('maps legacy dwell only through an unambiguous ordered actual successor',()=>{
 expect(legacyDwellSuccessor(geom,'current')).toBe('next');expect(legacyDwellSuccessor(geom,'end')).toBeNull();
 expect(legacyDwellSuccessor({...geom,stops:[...geom.stops,{...geom.stops[1],sequence:8}]},'current')).toBeNull();
 expect(legacyDwellSuccessor({...geom,stops:[...geom.stops,{...geom.stops[2],sequence:8}]},'current')).toBeNull();
});
const base:DriveArgs={key:'9201',tripId:geom.tripId,line:'9',anchorMs:100000,emittedAtMs:108000,raw:[{t:108000,s:500},{t:238000,s:1500}],modal:{stopS:220,releaseAtMs:130000},geom,surfaces:{paceAt:()=>8,dwellStats:()=>({mean:18,sd:8,trusted:false})},prev:null,fixGapS:10,motionPolicy:'continuous-v1'};
it('integrates approach from observation time and serves the real platform despite a late ML nowcast',()=>{
 const f=fix(220,100000),phase=assessMotionPhase(f,fix(180,90000),geom,108000,()=>8);
 const built=buildDriveVehicle({...base,motionPhase:phase})!;
 expect(built.vehicle.motionPolicy).toBe('continuous-v1');expect(built.vehicle.opinion[0].s).toBeGreaterThan(220);expect(built.vehicle.opinion[0].s).toBeLessThan(310);
 expect(built.vehicle.opinion.slice(1).some((p,i)=>Math.abs(p.s-300)<5&&p.s===built.vehicle.opinion[i].s)).toBe(true);
 expect(built.meta.standingStart).toBe(false);expect(built.meta.opinion.curveViolations).toBe(0);
});
it('continues the same-axis rendered boundary across new fixes and age refreshes, while declaring axis changes',()=>{
 const first=buildDriveVehicle({...base,modal:null,raw:[{t:108000,s:500},{t:238000,s:1500}]})!;
 const prev={tripId:geom.tripId,opinion:first.opinion,smooth:first.smooth};
 for(const extra of [{anchorMs:115000,prevFixS:500,anchorFixS:50},{anchorMs:100000}]){
 const next=buildDriveVehicle({...base,...extra,emittedAtMs:118000,modal:null,raw:[{t:118000,s:50},{t:248000,s:1050}],prev})!;
 expect(next.vehicle.discontinuity).toBe(false);expect(Math.abs(next.vehicle.smooth[0].s-evalContinuousTrack(first.vehicle.smooth,118000))).toBeLessThan(.011);
 }
 const changed=buildDriveVehicle({...base,prev,axisChanged:true})!;expect(changed.vehicle.discontinuity).toBe(true);expect(changed.meta.discKind).toBe('axis');
});
