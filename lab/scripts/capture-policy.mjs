// Bounded read-only policy evidence, complementing the actual WebSocket wire.
// node lab/scripts/capture-policy.mjs OUT_DIR [DURATION_SECONDS]
import fs from 'node:fs';
import path from 'node:path';
const directory=process.argv[2];
if(!directory)throw Error('output directory required');
fs.mkdirSync(directory,{recursive:true});
const duration=Math.max(1,Math.min(7200,Number(process.argv[3]??3700)))*1000;
const base=process.env.LAB_CAPTURE_URL??'http://10.10.10.1:18090';
const startedAtMs=Date.now(),endAtMs=startedAtMs+duration;
const debug=fs.createWriteStream(path.join(directory,'debug.jsonl'),{flags:'a'});
const health=fs.createWriteStream(path.join(directory,'health.jsonl'),{flags:'a'});
const preferred=['9096','9128','9098','9324','8262','9343','9271','8368','8286','8295','8292','8774','9139','8783','8437','9080','9241','8459','9402','9440','9411','8278','9365','8752','9155','9204','8467','9252','9342','9110','9511','8417','8336','9432','8276'];
const keysFile=path.join(directory,'debug-keys.json');
const initial=await fetch(base+'/api/trajectories/v2',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
const active=new Set(initial.vehicles.map(v=>v.key));
const selected=preferred.filter(k=>active.has(k));
for(const v of initial.vehicles)if(selected.length<40&&!selected.includes(v.key))selected.push(v.key);
if(!fs.existsSync(keysFile))fs.writeFileSync(keysFile,JSON.stringify(selected));
fs.writeFileSync(path.join(directory,'debug-capture-meta.json'),JSON.stringify({pid:process.pid,base,startedAtMs,endAtMs,durationMs:duration,keys:selected}));
const seen=new Map();let errors=0,n=0,lastHealth=0;
while(Date.now()<endAtMs){
 const cycle=Date.now();let keys=selected;
 try{keys=JSON.parse(fs.readFileSync(keysFile,'utf8')).slice(0,60);}catch{}
 for(let i=0;i<keys.length;i+=3)await Promise.all(keys.slice(i,i+3).map(async key=>{
  try{const r=await fetch(base+'/api/vehicle/'+key+'/debug',{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('HTTP '+r.status);const value=await r.json();
   const revision=value.found?value.emittedAtMs:'missing';if(seen.get(key)!==revision){debug.write(JSON.stringify({receivedAtMs:Date.now(),value})+'\n');seen.set(key,revision);n++;}
  }catch(error){errors++;health.write(JSON.stringify({receivedAtMs:Date.now(),key,error:String(error)})+'\n');}
 }));
 if(Date.now()-lastHealth>=15000){try{const value=await fetch(base+'/api/summary',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());health.write(JSON.stringify({receivedAtMs:Date.now(),value})+'\n');}catch(error){health.write(JSON.stringify({receivedAtMs:Date.now(),error:String(error)})+'\n');errors++;}lastHealth=Date.now();}
 await new Promise(r=>setTimeout(r,Math.max(0,5000-(Date.now()-cycle))));
}
await Promise.all([new Promise(r=>debug.end(r)),new Promise(r=>health.end(r))]);
fs.writeFileSync(path.join(directory,'debug-capture-result.json'),JSON.stringify({startedAtMs,endedAtMs:Date.now(),n,errors}));
