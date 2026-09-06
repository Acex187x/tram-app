/** Bounded15min public pairedWS capture with exact geometry response arrivals.
 * No database, credentials, native resource or app state is accessed. */
const fs=require('node:fs');
const {ConvexClient}=require('convex/browser');
const dir=process.argv[2];if(!dir)throw Error('Usage: node capture-live-wire.cjs output-directory');if(fs.existsSync(dir))throw Error('Use a fresh directory: capture never overwrites evidence');fs.mkdirSync(dir,{recursive:true});
const clients={production:new ConvexClient('https://tram-api.acex.sh',{webSocketConstructor:WebSocket}),candidate:new ConvexClient('http://10.10.10.1:13210',{webSocketConstructor:WebSocket})};
const outputs=Object.fromEntries(Object.keys(clients).map(k=>[k,fs.createWriteStream(`${dir}/${k}-wire.jsonl`)]));
const stops=[],timers=[];let stopped=false,count=0;
function record(sources,path,value,extra={}){const row=JSON.stringify({receivedAtMs:Date.now(),path,value,...extra})+'\n';for(const source of sources)outputs[source].write(row);count++;if(path==='stream:fullFleet')queueTrips(value.vehicles);else if(path==='stream:batchesSince')queueTrips(value.batches.flatMap(b=>b.changed));}
function later(fn,ms){const t=setTimeout(()=>{if(!stopped)fn();},ms);timers.push(t);return t;}
function follow(client,sources,seedPath,batchPath){let seq=-1,stop,gen=0,seedPending=false;function cancel(){const old=stop;stop=undefined;old?.();}
 async function seed(){if(stopped||seedPending)return;seedPending=true;const g=++gen;cancel();try {const s=await client.query(seedPath,{});if(stopped||g!==gen)return;record(sources,seedPath,s);seq=s.seq;subscribe();}catch(e){record(sources,'capture:error',{query:seedPath,error:String(e)});later(seed,5000);}finally{seedPending=false;}}
 function subscribe(){if(stopped)return;cancel();const g=++gen,cursor=seq;stop=client.onUpdate(batchPath,{sinceSeq:cursor},v=>{if(stopped||g!==gen)return;const fresh=v.batches.filter(b=>b.seq>seq);if(v.latestSeq<seq||(fresh.length&&fresh[0].seq>seq+1&&v.oldestSeq>seq+1)){later(seed,0);return;}if(!fresh.length)return;record(sources,batchPath,{...v,batches:fresh});seq=fresh.at(-1).seq;if(seq-cursor>=8)later(subscribe,0);},e=>{if(g!==gen)return;record(sources,'capture:error',{query:batchPath,error:String(e)});later(seed,2000);});}
 stops.push(()=>{gen++;cancel();});void seed();}
follow(clients.production,['production','candidate'],'stream:fullFleet','stream:batchesSince');
for(const [source,client]of Object.entries(clients)){
 follow(client,[source],'trajectories:fullSet','trajectories:batchesSince');
 stops.push(client.onUpdate('trajectories:meta',{},v=>record([source],'trajectories:meta',v),e=>record([source],'capture:error',{query:'trajectories:meta',error:String(e)})));
 async function clock(){const sentAtMs=Date.now();try{const value=await client.query('clock:now',{nonce:`paired-${source}-${sentAtMs}-${Math.random()}`});if(!stopped)record([source],'clock:now',value,{sentAtMs});}catch(e){if(!stopped)record([source],'capture:error',{query:'clock:now',error:String(e)});}if(!stopped)later(clock,60000);}void clock();
}
let pack={shapes:[],trips:{}};
const tripQueue=[],tripSeen=new Set();let tripActive=0, nextTripStartMs=0, tripWakePending=false;
function queueTrips(fixes){for(const f of fixes){if(!f.tripId||tripSeen.has(f.tripId))continue;tripSeen.add(f.tripId);tripQueue.push({tripId:f.tripId,attempt:0});}pumpTrips();}
function pumpTrips(){
 if(stopped||tripActive>=2||!tripQueue.length)return;
 const waitMs=nextTripStartMs-Date.now();
 if(waitMs>0){if(!tripWakePending){tripWakePending=true;later(()=>{tripWakePending=false;pumpTrips();},waitMs);}return;}
 const task=tripQueue.shift();tripActive++;nextTripStartMs=Date.now()+1000;
 void loadTrip(task).finally(()=>{tripActive--;pumpTrips();});
 pumpTrips();
}
async function loadTrip(task){try{const sentAtMs=Date.now();const response=await fetch('https://tram-site.acex.sh/geometry/'+encodeURIComponent(task.tripId),{headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});if(!response.ok){const e=Error(response.status);if(response.status===429){const h=response.headers.get('retry-after');const seconds=Number(h);e.retryAfterMs=h&&Number.isFinite(seconds)?seconds*1000:h?Math.max(0,Date.parse(h)-Date.now()):30000;e.retryAfterMs=Math.max(30000,Number.isFinite(e.retryAfterMs)?e.retryAfterMs:30000);nextTripStartMs=Math.max(nextTripStartMs,Date.now()+e.retryAfterMs);}throw e;}const geometry=await response.json();if(!stopped)record(['production','candidate'],'geometry:trip',{tripId:task.tripId,geometry},{sentAtMs});}catch(e){if(!stopped){record(['production','candidate'],'capture:error',{query:'geometry/'+task.tripId,error:String(e),retryAfterMs:e.retryAfterMs??null});if(task.attempt<2)later(()=>{tripQueue.push({...task,attempt:task.attempt+1});pumpTrips();},Math.max(30000,e.retryAfterMs??0));}}}
async function geometry(){try{const sentAtMs=Date.now();const response=await fetch('https://tram-site.acex.sh/geometry-pack',{headers:{Accept:'application/json','Accept-Encoding':'gzip'},signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(response.status);const next=await response.json();if(stopped)return;record(['production','candidate'],'geometry:pack',next,{sentAtMs});pack=next;fs.writeFileSync(`${dir}/geometry.json.tmp`,JSON.stringify(pack));fs.renameSync(`${dir}/geometry.json.tmp`,`${dir}/geometry.json`);}catch(e){if(!stopped)record(['production','candidate'],'capture:error',{query:'geometry-pack',error:String(e)});}if(!stopped)later(geometry,60000);}void geometry();
async function close(){if(stopped)return;stopped=true;timers.forEach(clearTimeout);stops.forEach(fn=>fn());await Promise.all(Object.values(clients).map(c=>c.close()));await Promise.all(Object.values(outputs).map(o=>new Promise(r=>o.end(r))));console.log('closed',count,'events');}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());later(()=>void close(),900000);
fs.writeFileSync(`${dir}/capture-meta.json`,JSON.stringify({startedAtMs:Date.now(),pid:process.pid,boundedDurationS:900,production:'https://tram-api.acex.sh',candidate:'http://10.10.10.1:13210',commonFixes:'Identical production fix messages copied to both files with identical receivedAtMs',geometry:'Exact app-origin geometry pack and pertrip geometry responses recorded at receipt; no retroactive union. Pertrip concurrency2,starts>=1000msapart(below nativebudget16per8s;sharedIPheadroom),timeout20s,max3attempts. Initial emptycache,packseedsprovisional,authoritative responsesreplace.'}));console.log(dir,'pid',process.pid);
