import {create} from 'zustand';
import {MODEL_SPECS} from '@/lib/fleet/modelSpecs';
import {Directory,File,Paths} from 'expo-file-system';
import {type SkinRecord,type SkinAssignment,registrationNumber} from '@/lib/skins/registry';
const root=()=>new Directory(Paths.document,'tram-skins');
interface Data {skins:SkinRecord[];assignments:Record<string,SkinAssignment>;}
/** Immutable index generations retain the last valid state after a partial
 * write. Only a successfully read index permits orphan cleanup on cold start. */
const empty=():Data=>({skins:[],assignments:{}});
function validData(d:any):Data|null {
  if(d?.version!==1||!Array.isArray(d.skins)||!d.assignments||typeof d.assignments!=='object'||Array.isArray(d.assignments))return null;
  if(d.skins.some((s:any)=>!s||typeof s.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,47}$/.test(s.id)||typeof s.title!=='string'||!Object.hasOwn(MODEL_SPECS,s.modelId)||!/^[a-z0-9-]+$/.test(s.directory)||!Array.isArray(s.mapKeys)||!Array.isArray(s.viewerKeys)||!Number.isFinite(s.bytes)||!Number.isFinite(s.mapTextureBytes)||[...s.mapKeys,...s.viewerKeys].some((key:unknown)=>typeof key!=='string'||!/^[a-z0-9-]+$/.test(key))))return null;
  if(Object.entries(d.assignments).some(([reg,a]:[string,any])=>!/^\d{1,6}$/.test(reg)||!a||typeof a.skinId!=='string'||!Object.hasOwn(MODEL_SPECS,a.modelId)))return null;
  return {skins:d.skins,assignments:d.assignments};
}
function indexFiles():File[]{if(!root().exists)return[];return root().list().filter((f):f is File=>f instanceof File&&(/^index-[0-9-]+\.json$/.test(f.name)||f.name==='index.json')).sort((a,b)=>Number(b.name.match(/^index-(\d+)/)?.[1]??0)-Number(a.name.match(/^index-(\d+)/)?.[1]??0));}
export function readSkinLibrary():Data {
  try{const valid=indexFiles().flatMap(f=>{try{const data=validData(JSON.parse(f.textSync()));return data?[{file:f,data}]:[];}catch{return[];}});
    if(!valid.length)return empty();
    const retained=valid.slice(0,3),references=new Set(retained.flatMap(x=>x.data.skins.map(s=>s.directory)));
    // App startup precedes model registration; retained recovery generations
    // keep their files too. A corrupt index never grants deletion authority.
    for(const entry of root().list())if(entry instanceof Directory&&!references.has(entry.name)){try{entry.delete();}catch{/* Retry on next cold start. */}}
    for(const old of valid.slice(3)){try{old.file.delete();}catch{/* Keep harmless recovery metadata. */}}
    return {skins:retained[0].data.skins.filter(s=>new Directory(root(),s.directory).exists),assignments:retained[0].data.assignments};
  }catch{return empty();}
}
let generation=Date.now();
function save(d:Data){
  root().create({intermediates:true,idempotent:true});
  const next=new File(root(),`index-${generation=Math.max(Date.now(),generation+1)}.json`);
  next.write(JSON.stringify({version:1,...d}));
  if(!validData(JSON.parse(next.textSync())))throw new Error('Skin library could not be saved');
}
interface State extends Data { revision:number; add:(skin:SkinRecord)=>void;assign:(reg:string,id:string)=>void;reset:(reg:string)=>void;remove:(id:string)=>void; }
export const useSkinsStore=create<State>((set,get)=>({
  ...readSkinLibrary(),revision:0,
  add:skin=>{const old=get();if(old.skins.some(s=>s.id===skin.id&&s.modelId!==skin.modelId))throw new Error('This skin ID already belongs to a different tram model');
    const skins=[...old.skins.filter(s=>s.id!==skin.id),skin];if(skins.length>8)throw new Error('Keep at most8 imported skins');
    const activeIds=new Set(Object.values(old.assignments).map(a=>a.skinId));
    if(skins.filter(s=>activeIds.has(s.id)).reduce((sum,s)=>sum+s.mapTextureBytes,0)>96*1024*1024)throw new Error('Updated skin exceeds the active map texture budget');
    const data={skins,assignments:old.assignments};save(data);set({...data,revision:old.revision+1});},
  assign:(input,id)=>{const reg=registrationNumber(input),old=get(),skin=old.skins.find(s=>s.id===id);if(!skin)throw new Error('Skin is no longer installed');
    const assignments={...old.assignments,[reg]:{skinId:id,modelId:skin.modelId}};
    const activeIds=new Set(Object.values(assignments).map(a=>a.skinId));
    if(old.skins.filter(s=>activeIds.has(s.id)).reduce((sum,s)=>sum+s.mapTextureBytes,0)>96*1024*1024)throw new Error('Assigned skins exceed96 MiB decoded map textures; reset an assignment first');
    save({skins:old.skins,assignments});set({assignments,revision:old.revision+1});},
  reset:input=>{const reg=registrationNumber(input),old=get(),assignments={...old.assignments};delete assignments[reg];save({skins:old.skins,assignments});set({assignments,revision:old.revision+1});},
  remove:id=>{const old=get(),skins=old.skins.filter(s=>s.id!==id),assignments=Object.fromEntries(Object.entries(old.assignments).filter(([,a])=>a.skinId!==id));save({skins,assignments});set({skins,assignments,revision:old.revision+1});},
}));
export function skinAssetUri(skin:SkinRecord,role:'map'|'viewer',key:string):string{return new File(root(),skin.directory,`${role}-${key}.glb`).uri;}
