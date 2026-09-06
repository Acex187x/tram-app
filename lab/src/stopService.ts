import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {setInterval,clearInterval} from 'node:timers';
import type {RouteGeometry} from '@/lib/types';
export const STOP_SERVICE_MAX_AGE_MS=36*60*60*1000;
interface Metadata {version:1;source:string;sourceAtMs:number;fetchedAtMs:number;trips:Record<string,[string,number,boolean][]>}
/** Optional isolated-review bridge until the geometry producer carries GTFS
 * requestOnly. Geometry without explicit fresh evidence stays mandatory. */
export class StopServiceMetadata {
 private data:Metadata|null=null;
 private cache=new WeakMap<RouteGeometry,{generation:number;geometry:RouteGeometry}>();
 private generation=0; private expired=false;private counts=new Map<string,{matched:number;unmatched:number;request:number}>();
 private timer:ReturnType<typeof setInterval>|null=null;private running=false;private lastError:string|null=null;
 constructor(private file:string|undefined,private script:string|undefined){if(file)this.load();}
 private load(){try{const d=JSON.parse(fs.readFileSync(this.file!,'utf8'));if(d.version!==1||!Number.isFinite(d.sourceAtMs)||!Number.isFinite(d.fetchedAtMs)||!d.trips||typeof d.trips!=='object')throw Error('invalidmetadata');this.data=d;this.generation++;this.cache=new WeakMap();this.counts.clear();this.lastError=null;}catch(e){this.lastError=e instanceof Error?e.message:'metadataunavailable';}}
 start(){if(!this.file||!this.script||this.timer)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),12*60*60*1000);(this.timer as unknown as {unref?:()=>void}).unref?.();}
 close(){if(this.timer)clearInterval(this.timer);this.timer=null;}
 private refresh(){if(this.running||!this.file||!this.script)return;this.running=true;execFile('python3',[this.script,this.file],{timeout:120000,maxBuffer:8192},error=>{this.running=false;if(error)this.lastError=`refreshfailed:${error.code??'unknown'}`;else this.load();});}
 apply(geom:RouteGeometry,nowMs=Date.now()):RouteGeometry {
  if(!this.file)return geom;
  const fresh=this.data!==null&&nowMs>=this.data.sourceAtMs-300000&&nowMs-this.data.sourceAtMs<=STOP_SERVICE_MAX_AGE_MS;
  if(this.expired===fresh){this.expired=!fresh;this.generation++;this.cache=new WeakMap();this.counts.clear();}
  const old=this.cache.get(geom);if(old?.generation===this.generation)return old.geometry;
  const rows=fresh?this.data!.trips[geom.tripId]??[]:[];const lookup=new Map<string,boolean|null>();
  for(const row of rows){if(!Array.isArray(row)||row.length!==3||typeof row[0]!=='string'||!Number.isInteger(row[1])||typeof row[2]!=='boolean')continue;const k=row[0]+'|'+row[1];lookup.set(k,lookup.has(k)?null:row[2]);}
  let matched=0,unmatched=0,request=0;
  const stops=geom.stops.map(stop=>{const flag=lookup.get(stop.stopId+'|'+stop.sequence);if(typeof flag==='boolean'){matched++;if(flag)request++;return {...stop,requestOnly:flag};}unmatched++;return {...stop,requestOnly:false};});
  const result={...geom,stops};this.cache.set(geom,{generation:this.generation,geometry:result});this.counts.set(geom.tripId,{matched,unmatched,request});return result;
 }
 retain(trips:Set<string>){for(const trip of this.counts.keys())if(!trips.has(trip))this.counts.delete(trip);}
 diagnostics(nowMs=Date.now()){const c=[...this.counts.values()];return {enabled:Boolean(this.file),source:this.data?.source??null,sourceAtMs:this.data?.sourceAtMs??null,sourceAgeS:this.data?Math.max(0,(nowMs-this.data.sourceAtMs)/1000):null,fresh:this.data!==null&&nowMs>=this.data.sourceAtMs-300000&&nowMs-this.data.sourceAtMs<=STOP_SERVICE_MAX_AGE_MS,refreshing:this.running,lastError:this.lastError,activeTrips:c.length,matched:c.reduce((s,x)=>s+x.matched,0),unmatched:c.reduce((s,x)=>s+x.unmatched,0),request:c.reduce((s,x)=>s+x.request,0)};}
}
