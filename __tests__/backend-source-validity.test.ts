/// <reference types="jest" />
import {SourceValidity,isOlderSameTripFix} from '../lab/src/sourceValidity';
import {snapshot,straightGeometry} from './physicsFixtures';
const geometry=straightGeometry([{stopId:'served-a',distM:0},{stopId:'served-b',distM:1000}]);
const invalid=snapshot({coordinates:[15,51],shapeDistM:0,lastStopId:'other-a',nextStopId:'other-b'});

it('quarantines a contradictory axis and recovers on a coherent next fix',()=>{
 const gate=new SourceValidity();
 expect(gate.assess(invalid,geometry).status).toBe('invalid');
 expect(gate.size).toBe(1);
 expect(gate.assess(invalid,geometry).status).toBe('invalid');
 expect(gate.rejectedObservations).toBe(1);
 const fixed=snapshot({...invalid,observedAtMs:invalid.observedAtMs+30000,coordinates:geometry.coordinates[0],lastStopId:'served-a',nextStopId:'served-b'});
 expect(gate.assess(fixed,geometry).status).toBe('valid');
 expect(gate.get(fixed.key)).toBeUndefined();
});
it('rechecks geometry replacement without needing a newer timestamp',()=>{
 const gate=new SourceValidity();
 expect(gate.assess(invalid,undefined).status).toBe('unknown');
 expect(gate.assess(invalid,geometry).status).toBe('invalid');
 expect(gate.recoverable(()=>undefined)).toEqual([]);
 const corrected={...geometry,stops:geometry.stops.map((s,i)=>({...s,stopId:i?'other-b':'other-a'}))};
 expect(gate.recoverable(()=>corrected)).toEqual([invalid]);
 expect(gate.size).toBe(0);
});
it('removes departed quarantines on a reseed rather than retaining dead fleet state',()=>{
 const gate=new SourceValidity();gate.assess(invalid,geometry);
 gate.retain(new Set());expect(gate.size).toBe(0);
 expect(gate.recoverable(()=>geometry)).toEqual([]);
});
it('ignores older same-trip evidence before it can quarantine a newer coherent fix',()=>{
 const gate=new SourceValidity();
 const newest=snapshot({...invalid,observedAtMs:invalid.observedAtMs+30000,coordinates:geometry.coordinates[0]});
 expect(gate.assess(newest,geometry).status).toBe('valid');
 expect(isOlderSameTripFix(invalid,newest)).toBe(true);
 if(!isOlderSameTripFix(invalid,newest))gate.assess(invalid,geometry);
 expect(gate.size).toBe(0);
 expect(isOlderSameTripFix({...invalid,tripId:'next-trip'},newest)).toBe(false);
 expect(isOlderSameTripFix(newest,newest)).toBe(false);
});
