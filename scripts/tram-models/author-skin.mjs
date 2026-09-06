/** Author a livery without changing the tram's geometry or movable mechanisms.
 * template MODEL DIRECTORY -> SVG guides and transparent PNG paint canvases.
 * build MODEL DIRECTORY -> canonical map/viewer GLBs for package-skin.mjs.
 */
import { NodeIO } from '@gltf-transform/core';
import { cloneDocument, dedup, flatten, join, prune, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import validator from 'gltf-validator';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const lengths={t3:[14],t3rp:[14],t3rplf:[15.1],kt8d5:[10.9,6.5,10.9],'14t':[6.265,5.48,3.38,5.48,6.265],'15t':[10.4,8.6,10.4],'52t':[9,3.5,3.79,3.5,9]};
const noOpen=new Set(['14t-a','14t-c','52t-b','52t-d']);
const roofHeight={t3:3.06,t3rp:3.06,t3rplf:3.185,kt8d5:3.145,'14t':3.37,'15t':3.45,'52t':3.35};
const paint=new Set(['red','cream','white','silver']);
const faces=['right','left','front','rear','roof','underside'];
const W=1536,H=1024,CELL=512,PAD=12;
const io=new NodeIO();
function point(matrix,p){return [0,1,2].map(i=>matrix[i]*p[0]+matrix[4+i]*p[1]+matrix[8+i]*p[2]+matrix[12+i]);}
function faceOf(p){
 const a=p[1].map((x,i)=>x-p[0][i]),b=p[2].map((x,i)=>x-p[0][i]);
 const n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const abs=n.map(Math.abs),axis=abs.indexOf(Math.max(...abs));
 return axis===0?(n[0]>0?0:1):axis===2?(n[2]<0?2:3):(n[1]>0?4:5);
}
function pixel(p,f,L){
 let u,v;
 if(f<2){u=.5+(f===0?-p[2]:p[2])/L;v=1-p[1]/3.6;}
 else if(f<4){u=.5+(f===2?p[0]:-p[0])/2.6;v=1-p[1]/3.6;}
 else {u=.5+p[0]/2.6;v=.5+p[2]/L;}
 return [(f%3)*CELL+PAD+u*(CELL-2*PAD),Math.floor(f/3)*CELL+PAD+v*(CELL-2*PAD)];
}
async function prepare(model,index){
 const key=lengths[model].length===1?model:`${model}-${String.fromCharCode(97+index)}`;
 const doc=await io.read(resolve(root,'assets/models',`${key}-viewer.glb`));
 const paths=[]; const buffer=doc.getRoot().listBuffers()[0];
 for(const node of doc.getRoot().listNodes()){
  const mesh=node.getMesh();if(!mesh)continue;
  for(const prim of mesh.listPrimitives()){
   if(!paint.has(prim.getMaterial()?.getName()))continue;
   const pos=prim.getAttribute('POSITION'),indices=prim.getIndices();
   const count=indices?.getCount()??pos.getCount();
   if(count%3)throw new Error('Expected triangle geometry');
   const attrs=prim.listSemantics();
   const groups=[0,1].map(()=>({values:Object.fromEntries(attrs.map(x=>[x,[]])),uv:[]}));
   for(let j=0;j<count;j+=3){
    const ids=[0,1,2].map(k=>indices?indices.getScalar(j+k):j+k);
    const points=ids.map(id=>point(node.getWorldMatrix(),pos.getElement(id,[])));
    const protectedPart=points.some(p=>p[1]>roofHeight[model]+.005);
    const group=groups[protectedPart?1:0];
    const f=faceOf(points);const xy=points.map(p=>pixel(p,f,lengths[model][index]));
    if(!protectedPart)paths.push(`<path d="M${xy.map(p=>p.map(x=>x.toFixed(2)).join(',')).join('L')}Z"/>`);
    for(let k=0;k<3;k++){
     for(const semantic of attrs)group.values[semantic].push(...prim.getAttribute(semantic).getElement(ids[k],[]));
     group.uv.push(xy[k][0]/W,xy[k][1]/H);
    }
   }
   const material=prim.getMaterial();
   for(const [i,group] of groups.entries()){
    if(!group.values.POSITION.length)continue;
    const replacement=doc.createPrimitive().setMode(prim.getMode());
    for(const semantic of attrs){const old=prim.getAttribute(semantic);replacement.setAttribute(semantic,doc.createAccessor().setType(old.getType()).setArray(new Float32Array(group.values[semantic])).setBuffer(buffer));}
    if(i===0){
     replacement.setMaterial(material).setAttribute('TEXCOORD_0',doc.createAccessor().setType('VEC2').setArray(new Float32Array(group.uv)).setBuffer(buffer));
    }else replacement.setMaterial(material.clone().setName(`protected-${material.getName()}`));
    mesh.addPrimitive(replacement);
   }
   mesh.removePrimitive(prim);prim.dispose();
  }
 }
 return {doc,key,paths};
}
async function save(doc,path){
 const bytes=await io.writeBinary(doc);
 const report=await validator.validateBytes(bytes,{uri:path});
 if(report.issues.numErrors||report.issues.numWarnings)throw new Error(`${path}: ${JSON.stringify(report.issues)}`);
 if(bytes.length>4*1024*1024)throw new Error(`${path}: exceeds4MiB package asset limit`);
 await writeFile(path,bytes);
}
async function main(){
 const [mode,model,output]=process.argv.slice(2);
 if(!['template','build'].includes(mode)||!lengths[model]||!output)throw new Error('Usage: node scripts/tram-models/author-skin.mjs template|build MODEL DIRECTORY');
 const directory=resolve(output);await mkdir(directory,{recursive:true});
 for(let i=0;i<lengths[model].length;i++){
  const {doc,key,paths}=await prepare(model,i);
  if(mode==='template'){
   const labels=faces.map((f,j)=>`<text x="${(j%3)*CELL+16}" y="${Math.floor(j/3)*CELL+24}">${key}: ${f}</text>`).join('');
   await writeFile(resolve(directory,`${key}-guide.svg`),`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#eee"/><g fill="none" stroke="#555" stroke-width=".45" opacity=".5">${paths.join('')}</g><g font-family="sans-serif" font-size="14" fill="#111">${labels}</g></svg>`);
   const png=resolve(directory,`${key}.png`);
   try{await access(png);}catch{await sharp({create:{width:W,height:H,channels:4,background:'#00000000'}}).png().toFile(png);}
   continue;
  }
  const image=await readFile(resolve(directory,`${key}.png`));const meta=await sharp(image,{limitInputPixels:W*H}).metadata();
  if(meta.width!==W||meta.height!==H||meta.format!=='png')throw new Error(`${key}.png must be ${W}×${H} PNG`);
  for(const material of doc.getRoot().listMaterials()){
   if(!paint.has(material.getName()))continue;
   const rgb=material.getBaseColorFactor().slice(0,3).map(x=>Math.round(255*(x<=.0031308?12.92*x:1.055*Math.pow(x,1/2.4)-.055)));
   const composite=await sharp({create:{width:W,height:H,channels:4,background:{r:rgb[0],g:rgb[1],b:rgb[2],alpha:1}}}).composite([{input:image}]).png().toBuffer();
   // Each original paint batch keeps its base color under transparent ink.
   // Bound the duplicate atlas cost across both map door states and sections.
   const atlas=await sharp(composite).resize(W/2,H/2).png().toBuffer();
   const texture=doc.createTexture(`paint-${material.getName()}`).setImage(atlas).setMimeType('image/png');
   material.setName(`paint-${material.getName()}`).setBaseColorFactor([1,1,1,1]).setBaseColorTexture(texture);
   material.getBaseColorTextureInfo().setWrapS(33071).setWrapT(33071);
  }
  await doc.transform(prune(),weld(),dedup());
  await mkdir(resolve(directory,'viewer'),{recursive:true});await mkdir(resolve(directory,'map'),{recursive:true});
  await save(doc,resolve(directory,'viewer',`${key}-viewer.glb`));
  for(const opened of noOpen.has(key)?[false]:[false,true]){
   const map=cloneDocument(doc);
   if(opened)for(const node of map.getRoot().listNodes()){
    const e=node.getExtras();if(!e.doorOpenTranslation)continue;
    node.setTranslation(node.getTranslation().map((v,j)=>v+e.doorOpenTranslation[j]));
    const angle=e.doorOpenRotationY??0;
    // Authored leaf node rotation is identity; reject rather than overwrite a
    // future nonidentity basis without quaternion composition.
    if(node.getRotation().some((v,j)=>Math.abs(v-(j===3?1:0))>1e-6))throw new Error('Unexpected door rotation basis');
    node.setRotation([0,Math.sin(angle/2),0,Math.cos(angle/2)]);
   }
   for(const node of map.getRoot().listNodes())node.setExtras({});
   await map.transform(flatten(),join(),weld(),dedup(),prune());
   await save(map,resolve(directory,'map',`${key}${opened?'-open':''}.glb`));
  }
 }
 console.log(`${mode}: ${model} → ${directory}`);
}
await main();
