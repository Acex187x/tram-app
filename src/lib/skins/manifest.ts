import { Matrix4, Quaternion, Vector3 } from 'three';
import { MODEL_SPECS } from '@/lib/fleet/modelSpecs';
import type { TramModelId } from '@/lib/types';
import expected from './compatibility.json';

export interface SkinPackage {
  schemaVersion: 1; id: string; title: string; modelId: TramModelId;
  sourceUrl?: string; notes?: string;
  mapAssets: Record<string,string>; viewerAssets: Record<string,string>;
}
export interface GlbEvidence { bounds:number[]; triangles:number; mechanisms:string; textureBytes:number; }
export const MAX_PACKAGE_BYTES=32*1024*1024;
const MAX_ASSET_BYTES=4*1024*1024;
const fail=(message:string):never=>{throw new Error(message);};
export function decodeBase64(text:string):Uint8Array {
  if(text.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))fail('Invalid embedded GLB encoding');
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out=new Uint8Array(text.length/4*3-(text.endsWith('==')?2:text.endsWith('=')?1:0));
  let n=0;
  for(let i=0;i<text.length;i+=4){const a=alphabet.indexOf(text[i]),b=alphabet.indexOf(text[i+1]),c=alphabet.indexOf(text[i+2]),d=alphabet.indexOf(text[i+3]);
    if(n<out.length)out[n++]=(a<<2)|(b>>4);if(n<out.length)out[n++]=(b<<4)|(c>>2);if(n<out.length)out[n++]=(c<<6)|d;}
  return out;
}
/** Read actual geometry, including node transforms. Imported material/image
 * changes cannot bypass finite-coordinate, envelope or triangle checks. */
export function inspectGlb(bytes:Uint8Array, openDoors=false):GlbEvidence {
  if(bytes.length<28||bytes.length>MAX_ASSET_BYTES)fail('GLB must be smaller than4 MiB');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==bytes.length)fail('Invalid GLB2 header');
  const jsonLength=view.getUint32(12,true);
  if(view.getUint32(16,true)!==0x4e4f534a||jsonLength>bytes.length-20)fail('Invalid GLB JSON chunk');
  const json=JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+jsonLength)));
  let bin:Uint8Array=new Uint8Array();const off=20+jsonLength;
  if(off+8<=bytes.length){const n=view.getUint32(off,true);if(view.getUint32(off+4,true)!==0x004e4942||off+8+n!==bytes.length)fail('Invalid GLB binary chunk');bin=bytes.subarray(off+8);}
  if(json.asset?.version!=='2.0'||json.buffers?.length!==1||json.buffers[0].uri||json.buffers[0].byteLength>bin.length)fail('Use one embedded GLB buffer');
  if((json.images??[]).some((x:any)=>x.uri||!Number.isInteger(x.bufferView)))fail('Embed every texture in the GLB');
  let textureBytes=0;
  for(const image of json.images??[]){
    const b=json.bufferViews?.[image.bufferView];
    const start=b?.byteOffset??0,length=b?.byteLength;
    if(image.mimeType!=='image/png'||b?.buffer!==0||!Number.isInteger(length)||start<0||length<24||start+length>bin.length)fail('Use embedded PNG textures');
    const png=new DataView(bin.buffer,bin.byteOffset+start,length);
    if(png.getUint32(0)!==0x89504e47||png.getUint32(4)!==0x0d0a1a0a||png.getUint32(12)!==0x49484452)fail('Invalid PNG header');
    const width=png.getUint32(16),height=png.getUint32(20);
    if(width<1||height<1||width>2048||height>2048)fail('PNG textures must be at most2048×2048');
    textureBytes+=Math.ceil(width*height*4*4/3); // include full mip chain
    if(textureBytes>48*1024*1024)fail('Section textures exceed48 MiB decoded');
  }
  if((json.extensionsUsed??[]).length || (json.extensionsRequired??[]).length)fail('Required GLB extensions are unsupported');
  if((json.skins??[]).length||(json.animations??[]).length)fail('Use the tram viewer mechanism nodes, not a separate rig');
  const textures=json.textures??[],samplers=json.samplers??[],materials=json.materials??[];
  if(textures.length>32||materials.length>128)fail('Too many textures or materials');
  const reference=(value:any,array:any[])=>Number.isInteger(value)&&value>=0&&value<array.length;
  for(const t of textures)if(!reference(t.source,json.images??[])||(t.sampler!=null&&!reference(t.sampler,samplers))||t.extensions)fail('Invalid texture reference');
  for(const sampler of samplers){
    if(sampler.magFilter!=null&&![9728,9729].includes(sampler.magFilter)||sampler.minFilter!=null&&![9728,9729,9984,9985,9986,9987].includes(sampler.minFilter)||[sampler.wrapS,sampler.wrapT].some(v=>v!=null&&![33071,33648,10497].includes(v)))fail('Invalid texture sampler');
  }
  for(const material of materials){
    if((material.alphaMode??'OPAQUE')!=='OPAQUE'||material.doubleSided===true||material.extensions)fail('Use opaque, single-sided materials without extensions');
    for(const info of [material.pbrMetallicRoughness?.baseColorTexture,material.pbrMetallicRoughness?.metallicRoughnessTexture,material.normalTexture,material.occlusionTexture,material.emissiveTexture]){
      if(info!=null&&(!reference(info.index,textures)||info.extensions||!Number.isInteger(info.texCoord??0)||(info.texCoord??0)<0||(info.texCoord??0)>1))fail('Invalid material texture reference');
    }
  }

  const nodes=json.nodes??[],meshes=json.meshes??[],accessors=json.accessors??[],views=json.bufferViews??[];
  if(nodes.length>4096||meshes.length>4096||accessors.length>512)fail('Too many GLB objects or accessors');
  let scannedFloatValues=0;
  const componentBytes:Record<number,number>={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
  const dimensions:Record<string,number>={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
  for(const a of accessors){const b=views[a.bufferView],size=componentBytes[a.componentType]*dimensions[a.type],stride=b?.byteStride??size,start=(b?.byteOffset??0)+(a.byteOffset??0);
    if(a.sparse||!b||b.buffer!==0||!Number.isInteger(b.byteLength)||b.byteLength<0||!Number.isFinite(size)||!Number.isInteger(a.count)||a.count<0||a.count>500000||!Number.isInteger(start)||!Number.isInteger(stride)||!Number.isInteger(a.byteOffset??0)||!Number.isInteger(b.byteOffset??0)||(a.byteOffset??0)<0||(b.byteOffset??0)<0||start<0||stride<size||start+Math.max(0,a.count-1)*stride+size>bin.length||(a.byteOffset??0)+Math.max(0,a.count-1)*stride+size>b.byteLength)fail('Invalid GLB accessor');
    if(a.componentType===5126){scannedFloatValues+=a.count*dimensions[a.type];if(scannedFloatValues>1000000)fail('Too many decoded vertex values');const data=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);for(let i=0;i<a.count;i++)for(let j=0;j<dimensions[a.type];j++)if(!Number.isFinite(data.getFloat32(start+i*stride+j*4,true)))fail('Non-finite GLB attribute');}
  }
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];let triangles=0;
  const visited=new Set<number>(),usedMeshes=new Set<number>(),stack=new Set<number>();
  const readPositions=(index:number,matrix:Matrix4)=>{
    const a=accessors[index],b=views[a?.bufferView];
    if(!a||!b||a.sparse||a.componentType!==5126||a.type!=='VEC3'||!Number.isInteger(a.count)||a.count<1||a.count>100000)fail('Invalid vertex positions');
    const stride=b.byteStride??12,start=(b.byteOffset??0)+(a.byteOffset??0);
    if(b.buffer!==0||stride<12||stride>256||start<0||start+(a.count-1)*stride+12>bin.length)fail('Vertex positions exceed embedded buffer');
    const data=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);
    for(let i=0;i<a.count;i++){const p=new Vector3(data.getFloat32(start+i*stride,true),data.getFloat32(start+i*stride+4,true),data.getFloat32(start+i*stride+8,true)).applyMatrix4(matrix);
      if(![p.x,p.y,p.z].every(v=>Number.isFinite(v)&&Math.abs(v)<100))fail('Invalid or oversized model coordinates');
      [p.x,p.y,p.z].forEach((v,j)=>{bounds[j]=Math.min(bounds[j],v);bounds[j+3]=Math.max(bounds[j+3],v);});}
  };
  const walk=(i:number,parent:Matrix4)=>{
    if(!Number.isInteger(i)||!nodes[i]||stack.has(i)||visited.has(i))fail('Invalid GLB node graph');visited.add(i);stack.add(i);
    const node=nodes[i],local=new Matrix4();
    if(openDoors&&node.extras?.doorOpenTranslation){
      node.translation=(node.translation??[0,0,0]).map((v:number,j:number)=>v+node.extras.doorOpenTranslation[j]);
      const angle=node.extras.doorOpenRotationY??0;node.rotation=[0,Math.sin(angle/2),0,Math.cos(angle/2)];
    }
    for(const field of ['matrix','translation','rotation','scale'])if(node[field]&&(!Array.isArray(node[field])||node[field].some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v))))fail('Invalid node transform');
    if(node.matrix){if(node.matrix.length!==16)fail('Invalid node matrix');local.fromArray(node.matrix);}
    else{if(node.translation&&node.translation.length!==3||node.rotation&&node.rotation.length!==4||node.scale&&node.scale.length!==3)fail('Invalid transform dimensions');local.compose(new Vector3().fromArray(node.translation??[0,0,0]),new Quaternion().fromArray(node.rotation??[0,0,0,1]),new Vector3().fromArray(node.scale??[1,1,1]));}
    const world=new Matrix4().multiplyMatrices(parent,local);
    if(node.mesh!=null){const mesh=meshes[node.mesh];if(!mesh)fail('Missing GLB mesh');usedMeshes.add(node.mesh);for(const p of mesh.primitives??[]){
      if(p.material!=null&&!reference(p.material,materials))fail('Invalid primitive material');
      if(p.extensions)fail('Primitive extensions are unsupported');
      if((p.mode??4)!==4)fail('Use triangle meshes');readPositions(p.attributes?.POSITION,world);
      const position=accessors[p.attributes.POSITION];
      for(const index of Object.values(p.attributes))if(accessors[index as number]?.count!==position.count)fail('Vertex attribute counts differ');
      const count=accessors[p.indices??p.attributes.POSITION]?.count;if(!Number.isInteger(count)||count%3)fail('Invalid triangle count');
      if(p.indices!=null){const a=accessors[p.indices],b=views[a?.bufferView];if(a?.type!=='SCALAR'||![5121,5123,5125].includes(a.componentType))fail('Invalid triangle index accessor');
        const size=componentBytes[a.componentType],stride=b.byteStride??size,start=(b.byteOffset??0)+(a.byteOffset??0),data=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);
        for(let n=0;n<a.count;n++){const at=start+n*stride,value=a.componentType===5121?data.getUint8(at):a.componentType===5123?data.getUint16(at,true):data.getUint32(at,true);if(value>=position.count)fail('Triangle index exceeds vertex count');}}
      triangles+=count/3;if(triangles>12000)fail('Model exceeds12000 triangles');
    }}
    for(const child of node.children??[])walk(child,world);stack.delete(i);
  };
  for(const i of json.scenes?.[json.scene??0]?.nodes??[])walk(i,new Matrix4());
  if(visited.size!==nodes.length||usedMeshes.size!==meshes.length)fail('Unused nodes or meshes are unsupported');
  if(!bounds.every(Number.isFinite)||triangles>12000)fail('Empty model or more than12000 triangles');
  const mechanisms=JSON.stringify(nodes.filter((n:any)=>n.extras&&Object.keys(n.extras).some(k=>/door|indicator/i.test(k))).map((n:any)=>({name:n.name,extras:n.extras})).sort((a:any,b:any)=>String(a.name).localeCompare(String(b.name))));
  return {bounds,triangles,mechanisms,textureBytes};
}
export function validateSkinPackage(input:unknown):{manifest:SkinPackage; decoded:Record<string,Uint8Array>;mapTextureBytes:number;viewerTextureBytes:number} {
  const p=input as SkinPackage;
  if(!p||p.schemaVersion!==1||typeof p.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,47}$/.test(p.id))fail('Invalid skin package ID or version');
  if(typeof p.title!=='string'||!p.title.trim()||p.title.length>80||!Object.hasOwn(MODEL_SPECS,p.modelId))fail('Invalid skin title or model');
  if(p.sourceUrl!=null&&(typeof p.sourceUrl!=='string'||p.sourceUrl.length>2000||!/^https:\/\//.test(p.sourceUrl)))fail('Reference link must use HTTPS');
  if(p.notes!=null&&(typeof p.notes!=='string'||p.notes.length>1000))fail('Notes are too long');
  const spec=MODEL_SPECS[p.modelId];const decoded:Record<string,Uint8Array>={};let total=0,closedTriangles=0,viewerTriangles=0,mapTextureBytes=0,viewerTextureBytes=0;
  for(const role of ['map','viewer'] as const){const assets=p[`${role}Assets`];const keys=spec.sections.flatMap(s=>role==='map'&&s.openModelKey?[s.modelKey,s.openModelKey]:[s.modelKey]);
    if(!assets||typeof assets!=='object'||Array.isArray(assets)||Object.keys(assets).sort().join('|')!==keys.sort().join('|'))fail(`Package needs every ${role} section for ${spec.name}`);
    for(const key of keys){const encoded=assets[key];if(typeof encoded!=='string'||encoded.length>MAX_ASSET_BYTES*4/3+4)fail('Oversized GLB asset');const bytes=decodeBase64(encoded);total+=bytes.length;if(total>MAX_PACKAGE_BYTES)fail('Skin package exceeds32 MiB');
      const actual=inspectGlb(bytes),reference=(expected as Record<string,GlbEvidence>)[`${role}/${key}`];if(!reference)fail('This app has no compatibility template for this section');
      // Open-state reference is derived from the same viewer door transforms,
      // so every axis keeps the same five-centimetre envelope tolerance.
      const tolerance=0.05;
      if(actual.bounds.some((v,i)=>Math.abs(v-reference.bounds[i])>tolerance))fail(`Geometry envelope differs: ${key}`);
      if(role==='viewer'&&actual.mechanisms!==reference.mechanisms)fail(`Door or indicator mechanism differs: ${key}`);
      if(role==='viewer'){viewerTriangles+=actual.triangles;viewerTextureBytes+=actual.textureBytes;}else{mapTextureBytes+=actual.textureBytes;if(!key.endsWith('-open'))closedTriangles+=actual.triangles;}
      decoded[`${role}/${key}`]=bytes;
    }
  }
  if(mapTextureBytes>96*1024*1024||viewerTextureBytes>64*1024*1024)fail('Decoded textures exceed96 MiB map /64 MiB viewer; reduce atlas resolution');
  if(closedTriangles>12000||viewerTriangles>12000)fail('Whole tram exceeds12000 triangles');
  return {manifest:{schemaVersion:1,id:p.id,title:p.title.trim(),modelId:p.modelId,sourceUrl:p.sourceUrl,notes:p.notes,mapAssets:p.mapAssets,viewerAssets:p.viewerAssets},decoded,mapTextureBytes,viewerTextureBytes};
}
