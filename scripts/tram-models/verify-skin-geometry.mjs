/** Verify the authoring pipeline preserves closed geometry and door mechanics. */
import {NodeIO} from '@gltf-transform/core';
import {resolve} from 'node:path';
import {readdir} from 'node:fs/promises';
const [directory]=process.argv.slice(2);
if(!directory)throw new Error('Usage: node scripts/tram-models/verify-skin-geometry.mjs DIRECTORY');
const io=new NodeIO();
function triangles(doc){
 const result=[];
 for(const node of doc.getRoot().listNodes())for(const prim of node.getMesh()?.listPrimitives()??[]){
  const a=prim.getAttribute('POSITION'),index=prim.getIndices(),matrix=node.getWorldMatrix();
  const count=index?.getCount()??a.getCount();
  for(let j=0;j<count;j+=3){
   const corners=[];
   for(let k=0;k<3;k++){
    const p=a.getElement(index?index.getScalar(j+k):j+k,[]);
    const q=[0,1,2].map(n=>matrix[n]*p[0]+matrix[n+4]*p[1]+matrix[n+8]*p[2]+matrix[n+12]);
    corners.push(q);
   }
   result.push(corners);
  }
 }
 return result;
}
function sameTriangles(a,b){
 const left=triangles(a),right=triangles(b);if(left.length!==right.length)return false;
 const cell=t=>[0,1,2].map(i=>Math.floor((t[0][i]+t[1][i]+t[2][i])/3/.01));
 const bins=new Map();right.forEach(t=>{const k=cell(t).join(',');if(!bins.has(k))bins.set(k,[]);bins.get(k).push(t);});
 for(const t of left){
  const c=cell(t);let found=false;
  for(let x=-1;x<=1&&!found;x++)for(let y=-1;y<=1&&!found;y++)for(let z=-1;z<=1&&!found;z++){
   const values=bins.get([c[0]+x,c[1]+y,c[2]+z].join(','));if(!values)continue;
   const index=values.findIndex(q=>t.every(p=>q.some(v=>p.every((n,i)=>Math.abs(n-v[i])<.00001))));
   if(index>=0){values.splice(index,1);found=true;}
  }
  if(!found)return false;
 }
 return true;
}
function mechanisms(doc){return doc.getRoot().listNodes().filter(n=>'doorOpenTranslation'in n.getExtras()||'indicatorSide'in n.getExtras()).map(n=>[n.getName(),n.getExtras()]).sort((a,b)=>a[0].localeCompare(b[0]));}
for(const file of (await readdir(resolve(directory,'viewer'))).filter(x=>x.endsWith('-viewer.glb'))){
 const key=file.replace('-viewer.glb','');
 const base=await io.read(resolve('assets/models',file));
 const view=await io.read(resolve(directory,'viewer',file));
 const map=await io.read(resolve(directory,'map',`${key}.glb`));
 for(const [label,doc]of[['viewer',view],['map',map]]){
  if(!sameTriangles(base,doc))throw new Error(`${key} ${label}: changed closed triangles`);
 }
 if(JSON.stringify(mechanisms(base))!==JSON.stringify(mechanisms(view)))throw new Error(`${key}: changed viewer mechanisms`);
 const hasDoors=mechanisms(view).some(([,e])=>e.doorOpenTranslation);
 if(hasDoors){
  for(const n of view.getRoot().listNodes()){
   const e=n.getExtras();if(!e.doorOpenTranslation)continue;
   n.setTranslation(n.getTranslation().map((v,i)=>v+e.doorOpenTranslation[i]));
   n.setRotation([0,Math.sin(e.doorOpenRotationY/2),0,Math.cos(e.doorOpenRotationY/2)]);
  }
  const open=await io.read(resolve(directory,'map',`${key}-open.glb`));
  if(!sameTriangles(view,open))throw new Error(`${key}: open map differs from transformed viewer`);
 }
 console.log(`${key}: unchanged triangles (10µm tolerance), exact mechanisms, baked open pose matches`);
}
