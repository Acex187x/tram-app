import {geometryContentKey,GeometryStore} from '../lab/src/geometry';
import {straightGeometry} from './physicsFixtures';
import type {Store} from '../lab/src/db';

test('reused provider ID never combines different coordinate/platform axes',()=>{
 const a=straightGeometry(),b={...a,tripId:'opposite',coordinates:[...a.coordinates].reverse()};
 expect(geometryContentKey(a)).not.toBe(geometryContentKey(b));
 expect(geometryContentKey(a)).not.toBe(geometryContentKey({...a,stops:[{stopId:'new',sequence:1,distM:20,coordinates:a.coordinates[0],isTerminal:false,arrivalMs:0,departureMs:0,name:'new',dwellSeconds:0}]}));
 const now=Date.now(),data={a,b};
 const store=new GeometryStore({loadGeometry:(id:keyof typeof data)=>({tripId:id,fetchedAtMs:now,json:JSON.stringify({...data[id],serviceMidnightMs:now})})} as unknown as Store);
 store.ensure(['a','b']);const pack=store.pack(['a','b']);
 expect(pack.shapes).toHaveLength(2);expect(pack.trips.a).not.toBe(pack.trips.b);
 expect(pack.shapes.every(g=>g.shapeId===a.shapeId)).toBe(true);
 for(const key of Object.values(pack.trips))expect(pack.shapes.filter(g=>g.geometryKey===key)).toHaveLength(1);
});

test('sibling timetable epochs do not change spatial content identity',()=>{
 const a=straightGeometry([{distM:500,arrivalMs:1000,departureMs:2000}]);
 const b={...a,tripId:'sibling',headsign:'different',stops:a.stops.map(s=>({...s,arrivalMs:s.arrivalMs+90000,departureMs:s.departureMs+90000}))};
 expect(geometryContentKey(a)).toBe(geometryContentKey(b));
 expect(geometryContentKey({...a,shapeId:'other-provider-id'})).not.toBe(geometryContentKey(a));
});
