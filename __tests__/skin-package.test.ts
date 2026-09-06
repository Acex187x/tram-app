import {readFileSync} from 'node:fs';
import {TextDecoder} from 'node:util';
import {inspectGlb,validateSkinPackage,decodeBase64} from '@/lib/skins/manifest';
import {assignedSkin,registrationNumber,skinModelKey,type SkinRecord} from '@/lib/skins/registry';
Object.assign(globalThis,{TextDecoder});
const glb=(name:string)=>readFileSync(`assets/models/${name}.glb`).toString('base64');

const rewrite=(encoded:string,change:(json:any)=>void)=>{
 const bytes=Buffer.from(encoded,'base64'),n=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+n).toString());change(json);
 const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(Math.ceil(text.length/4)*4,32);text.copy(padded);
 const bin=bytes.subarray(20+n),out=Buffer.alloc(20+padded.length+bin.length);bytes.copy(out,0,0,20);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);padded.copy(out,20);bin.copy(out,20+padded.length);return out.toString('base64');
};
const pack=()=>({schemaVersion:1,id:'qa-only',title:'QA only',modelId:'t3',mapAssets:{t3:glb('t3'),'t3-open':rewrite(glb('t3-viewer'),j=>{for(const node of j.nodes){const e=node.extras;if(!e?.doorOpenTranslation)continue;node.translation=(node.translation??[0,0,0]).map((v:number,i:number)=>v+e.doorOpenTranslation[i]);node.rotation=[0,Math.sin((e.doorOpenRotationY??0)/2),0,Math.cos((e.doorOpenRotationY??0)/2)];}})},viewerAssets:{t3:glb('t3-viewer')}});
it('accepts all model sections with authentic geometry and viewer mechanisms',()=>{expect(Object.keys(validateSkinPackage(pack()).decoded)).toHaveLength(3);});
it('rejects incomplete/open state or wrong model packages',()=>{const p=pack();delete(p.mapAssets as any)['t3-open'];expect(()=>validateSkinPackage(p)).toThrow(/every map section/);expect(()=>validateSkinPackage({...pack(),modelId:'52t'})).toThrow(/every map section/);});
it('rejects traversal IDs, external buffers and oversized geometry',()=>{
 expect(()=>validateSkinPackage({...pack(),id:'../other'})).toThrow(/ID/);
 for(const change of [(j:any)=>j.buffers[0].uri='https://example.com/data.bin',(j:any)=>j.nodes[0].scale=[100,100,100]]){
  const p=pack();p.mapAssets.t3=rewrite(p.mapAssets.t3,change);expect(()=>validateSkinPackage(p)).toThrow();
 }
});
it('rejects tampered mechanisms and invalid embedded data',()=>{
 const p=pack();p.viewerAssets.t3=rewrite(p.viewerAssets.t3,(j:any)=>{const node=j.nodes.find((n:any)=>n.extras&&Object.keys(n.extras).some(k=>/door/i.test(k)));node.extras={};});
 expect(()=>validateSkinPackage(p)).toThrow(/mechanism/);expect(()=>decodeBase64('abc?')).toThrow();expect(()=>inspectGlb(new Uint8Array(24))).toThrow();
});
it('never applies a skin to a different model or unassigned vehicle',()=>{
 const skin={id:'test',modelId:'t3'} as SkinRecord,assignments={'7001':{skinId:'test',modelId:'t3' as const}};
 expect(assignedSkin('7001','t3',[skin],assignments)).toBe(skin);expect(assignedSkin('7001','15t',[skin],assignments)).toBeUndefined();expect(assignedSkin('7002','t3',[skin],assignments)).toBeUndefined();
 expect(registrationNumber(' 7001 ')).toBe('7001');expect(registrationNumber('007001')).toBe('7001');expect(()=>registrationNumber('0')).toThrow();expect(()=>registrationNumber('../7001')).toThrow();
});

it.each([
  ['floating-point indices',(j:any)=>{j.accessors[j.meshes[0].primitives[0].indices].componentType=5126;}],
  ['different attribute count',(j:any)=>{j.accessors[j.meshes[0].primitives[0].attributes.NORMAL].count-=1;}],
  ['accessor escapes view',(j:any)=>{j.bufferViews[j.accessors[0].bufferView].byteLength=1;}],
  ['fractional stride',(j:any)=>{j.bufferViews[j.accessors[0].bufferView].byteStride=12.5;}],
  ['unused mechanism node',(j:any)=>{j.nodes.push({name:'fake door',extras:{doorOpenTranslation:[0,0,1]}});}],
] as const)('rejects %s',(_,change)=>{const p=pack();p.mapAssets.t3=rewrite(p.mapAssets.t3,change);expect(()=>validateSkinPackage(p)).toThrow();});
it('rejects an index exceeding the position count',()=>{
 const encoded=glb('t3'),bytes=Buffer.from(encoded,'base64'),n=bytes.readUInt32LE(12),j=JSON.parse(bytes.subarray(20,20+n).toString());
 const a=j.accessors[j.meshes[0].primitives[0].indices],b=j.bufferViews[a.bufferView],start=28+n+(b.byteOffset??0)+(a.byteOffset??0);
 if(a.componentType===5123)bytes.writeUInt16LE(65535,start);else bytes.writeUInt32LE(0xffffffff,start);
 expect(()=>inspectGlb(bytes)).toThrow(/index exceeds/);
});
it('bounds decoded PNG dimensions before native image decoding',()=>{
 const encoded=rewrite(glb('t3'),j=>{j.images=[{mimeType:'image/png',bufferView:j.bufferViews.length}];j.bufferViews.push({buffer:0,byteOffset:0,byteLength:24});});
 const bytes=Buffer.from(encoded,'base64'),start=28+bytes.readUInt32LE(12);bytes.writeUInt32BE(0x89504e47,start);bytes.writeUInt32BE(0x0d0a1a0a,start+4);bytes.writeUInt32BE(0x49484452,start+12);bytes.writeUInt32BE(65535,start+16);bytes.writeUInt32BE(65535,start+20);
 expect(()=>inspectGlb(bytes)).toThrow(/2048/);
});

it.each([
 ['transparent material',(j:any)=>{j.materials[0].alphaMode='BLEND';}],
 ['double-sided material',(j:any)=>{j.materials[0].doubleSided=true;}],
 ['missing texture',(j:any)=>{j.materials[0].pbrMetallicRoughness.baseColorTexture={index:999};}],
 ['missing image',(j:any)=>{j.textures=[{source:999}];}],
 ['missing sampler',(j:any)=>{j.textures=[{source:0,sampler:999}];}],
 ['invalid primitive material',(j:any)=>{j.meshes[0].primitives[0].material=999;}],
 ['undeclared extension',(j:any)=>{j.materials[0].extensions={KHR_materials_transmission:{transmissionFactor:1}};}],
] as const)('rejects %s',(_,change)=>{expect(()=>inspectGlb(Buffer.from(rewrite(glb('t3'),change),'base64'))).toThrow();});
it('versions native model IDs when a package is replaced',()=>{expect(skinModelKey('campaign-100','t3')).not.toBe(skinModelKey('campaign-101','t3'));});

it('bounds validation cost when accessors alias the same binary bytes',()=>{
 expect(()=>inspectGlb(Buffer.from(rewrite(glb('t3'),j=>{j.accessors=Array.from({length:513},()=>j.accessors[0]);}),'base64'))).toThrow(/Too many GLB/);
 expect(()=>inspectGlb(Buffer.from(rewrite(glb('t3'),j=>{const source=j.accessors.find((a:any)=>a.componentType===5126&&a.type==='VEC3'&&a.count>1000);j.accessors=Array.from({length:Math.ceil(1000000/(source.count*3))+1},()=>source);}),'base64'))).toThrow(/decoded vertex values/);
});
it('rejects repeated active mesh instances at the running triangle budget',()=>{
 expect(()=>inspectGlb(Buffer.from(rewrite(glb('t3'),j=>{const first=j.nodes.find((n:any)=>n.mesh!=null);for(let i=0;i<20;i++){j.scenes[j.scene??0].nodes.push(j.nodes.length);j.nodes.push({...first});}}),'base64'))).toThrow(/12000 triangles/);
});
