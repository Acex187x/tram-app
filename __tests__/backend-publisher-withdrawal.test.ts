/// <reference types="jest" />
jest.mock('../lab/src/config',()=>({ENGINE_PUSH_TOKEN:'test-only',PUBLISH_CONVEX_URL:'http://unused',TRAJ_POINTS:13,TRAJ_STEP_MS:10000}));
import {ConvexPublisher} from '../lab/src/publish';
import {wireVehicle} from './physicsFixtures';
const originalFetch=global.fetch;
afterEach(()=>{global.fetch=originalFetch;});
test('withdraws persisted invalid rows after process restart and retries failed removal',async()=>{
 const calls:any[]=[];
 global.fetch=jest.fn().mockImplementation(async(_url,init)=>{
  calls.push(JSON.parse(init.body).args);
  return calls.length===1?{ok:false,status:503}:{ok:true,json:async()=>({status:'success',value:{seq:1}})};
 });
 const publisher=new ConvexPublisher();publisher.requestRemoval('invalid');
 await publisher.publishCycle(new Map(),1000,'drive-v3');
 await publisher.publishCycle(new Map(),2000,'drive-v3');
 await publisher.publishCycle(new Map(),3000,'drive-v3');
 expect(calls.map(c=>c.removed)).toEqual([['invalid'],['invalid'],[]]);
 expect(publisher.gauges().removalsPushed).toBe(1);
});
test('a recovered coherent curve supersedes pending withdrawal and is published',async()=>{
 const calls:any[]=[];
 global.fetch=jest.fn().mockImplementation(async(_url,init)=>{calls.push(JSON.parse(init.body).args);return{ok:true,json:async()=>({status:'success',value:{seq:1}})}});
 const publisher=new ConvexPublisher();publisher.requestRemoval('recovered');
 const v2=wireVehicle({key:'recovered'});
 await publisher.publishCycle(new Map([['recovered',{v2,source:'ml' as const,anchorFixS:100}]]),1000,'drive-v3');
 expect(calls[0].removed).toEqual([]);
 expect(calls[0].changed[0].key).toBe('recovered');
});
