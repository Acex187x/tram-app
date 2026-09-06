jest.mock('../lab/src/db',()=>({round2:(x:number)=>Math.round(x*100)/100}));
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {StopServiceMetadata,STOP_SERVICE_MAX_AGE_MS} from '../lab/src/stopService';
import {buildDriveVehicle} from '../lab/src/drive';
import {straightGeometry} from './physicsFixtures';
const geom=straightGeometry([{stopId:'start',sequence:1,distM:0},{stopId:'stop',sequence:2,distM:300},{stopId:'end',sequence:3,distM:1000,isTerminal:true}]);
const now=1788680000000;let temp:string;
beforeEach(()=>{temp=fs.mkdtempSync(path.join(os.tmpdir(),'stop-service-test-'));});afterEach(()=>fs.rmSync(temp,{recursive:true,force:true}));
function service(rows:any[],sourceAtMs=now){const file=path.join(temp,'metadata.json');fs.writeFileSync(file,JSON.stringify({version:1,source:'https://data.pid.cz/PID_GTFS.zip',sourceAtMs,fetchedAtMs:now,trips:{[geom.tripId]:rows}}));return new StopServiceMetadata(file,undefined);}
it('joins exact trip, stop ID and sequence and reports unknown stops',()=>{
 const s=service([['stop',2,true],['end',3,false]]);const g=s.apply(geom,now);
 expect(g.stops.map(x=>x.requestOnly)).toEqual([false,true,false]);expect(s.diagnostics(now)).toMatchObject({fresh:true,matched:2,unmatched:1,request:1});
 expect(s.apply({...geom,tripId:'different'},now).stops.every(x=>x.requestOnly===false)).toBe(true);
});
it('rejects ambiguous, mismatched and stale metadata without sticky request flags',()=>{
 const s=service([['stop',2,true],['stop',2,true],['start',7,true]]);
 expect(s.apply(geom,now).stops.every(x=>x.requestOnly===false)).toBe(true);
 const good=service([['stop',2,true]]);expect(good.apply(geom,now).stops[1].requestOnly).toBe(true);
 expect(good.apply(geom,now+STOP_SERVICE_MAX_AGE_MS+1).stops[1].requestOnly).toBe(false);
 expect(good.diagnostics(now+STOP_SERVICE_MAX_AGE_MS+1).fresh).toBe(false);
});
it('keeps shared producer geometry intact when isolated overlay is disabled',()=>{const s=new StopServiceMetadata(undefined,undefined);expect(s.apply(geom,now)).toBe(geom);});
it('permits learned skip evidence only for explicit request platforms, never terminal',()=>{
 const build=(requestOnly?:boolean)=>buildDriveVehicle({key:'test',tripId:geom.tripId,line:'1',anchorMs:0,emittedAtMs:0,raw:[{t:0,s:50},{t:120000,s:1000}],modal:null,prev:null,fixGapS:20,geom:{...geom,stops:geom.stops.map(s=>({...s,requestOnly}))},surfaces:{paceAt:()=>8,dwellStats:()=>({mean:3,sd:1,trusted:false})}})!;
 const request=build(true);expect(request.meta.requestSkips.map(s=>s.stopId)).toContain('stop');expect(request.meta.requestSkips.map(s=>s.stopId)).not.toContain('end');
 for(const flag of [false,undefined]){const ordinary=build(flag);expect(ordinary.meta.requestSkips).toHaveLength(0);expect(ordinary.meta.ordinarySkipPrevented.map(s=>s.stopId)).toContain('stop');}
});
