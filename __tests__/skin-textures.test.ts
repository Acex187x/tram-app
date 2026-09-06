import * as THREE from 'three';
const mockWrites=new Map<string,Uint8Array>();
const mockDirectories=new Set<string>();
let mockSize={width:768,height:512};
jest.mock('react-native',()=>({TurboModuleRegistry:{get:()=>null},Image:{getSize:(_uri:string,resolve:(width:number,height:number)=>void)=>resolve(mockSize.width,mockSize.height)}}));
jest.mock('expo-file-system',()=>{
 const path=(args:any[])=>args.map(p=>typeof p==='string'?p:p.uri).join('/');
 return {Paths:{cache:'cache'},Directory:class {uri:string;constructor(...a:any[]){this.uri=path(a);}create(){mockDirectories.add(this.uri);}get exists(){return mockDirectories.has(this.uri);}delete(){mockDirectories.delete(this.uri);}},File:class {uri:string;constructor(...a:any[]){this.uri=path(a);}write(bytes:Uint8Array){mockWrites.set(this.uri,bytes);}}};
});
import {registerEmbeddedTextures} from '@/components/model/embeddedTextures';
function setup(){
 const parser={json:{textures:[{source:0,sampler:0}],images:[{mimeType:'image/png',bufferView:0}],samplers:[{wrapS:10497,wrapT:10497}]},getDependency:async()=>new ArrayBuffer(8),associations:new Map()};
 let plugin:any;const cleanup=registerEmbeddedTextures({register:(callback:any)=>{plugin=callback(parser);}} as any,'qa');
 return{plugin,cleanup,parser};
}
beforeEach(()=>{mockWrites.clear();mockDirectories.clear();mockSize={width:768,height:512};});
it('uses native local URI with safe NPOT sampling and no DOM resize/mip path',async()=>{const{plugin,cleanup,parser}=setup();const texture:THREE.Texture=await plugin.loadTexture(0);expect(texture.image).toEqual(expect.objectContaining({localUri:expect.stringMatching(/^cache\/skin-textures\//),width:768,height:512}));expect(texture.flipY).toBe(false);expect(texture.generateMipmaps).toBe(false);expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping);expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);expect(texture.minFilter).toBe(THREE.LinearFilter);expect(parser.associations.get(texture)).toEqual({textures:0});const dispose=jest.spyOn(texture,'dispose');cleanup();expect(dispose).toHaveBeenCalledTimes(1);expect(mockDirectories.size).toBe(0);});
it('permits mipmaps only for power-of-two images',async()=>{mockSize={width:512,height:512};const{plugin,cleanup}=setup();const texture=await plugin.loadTexture(0);expect(texture.generateMipmaps).toBe(true);expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);cleanup();});
it('rechecks native decoder dimensions before constructing a texture',async()=>{mockSize={width:4096,height:512};const{plugin,cleanup}=setup();await expect(plugin.loadTexture(0)).rejects.toThrow(/2048/);cleanup();expect(mockDirectories.size).toBe(0);});

it('never overwrites a previous section image with the same local glTF index',async()=>{const{plugin,cleanup}=setup();const first=await plugin.loadTexture(0),second=await plugin.loadTexture(0);expect(first.image.localUri).not.toBe(second.image.localUri);expect(mockWrites.size).toBe(2);cleanup();});
