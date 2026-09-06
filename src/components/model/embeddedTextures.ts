/** GLTFLoader's browser ImageLoader is unavailable in React Native. ExpoGL
 * accepts a local image URI as texImage2D input; decoding happens natively once. */
import {Directory,File,Paths} from 'expo-file-system';
import {Image} from 'react-native';
import * as THREE from 'three';
import type {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
export function registerEmbeddedTextures(loader:GLTFLoader,namespace:string):()=>void {
  const directory=new Directory(Paths.cache,'skin-textures',`${namespace}-${Date.now()}`);
  directory.create({intermediates:true,idempotent:true});
  const textures=new Set<THREE.Texture>();
  let textureSerial=0; // Each section parser restarts glTF texture indices at zero.
  loader.register(parser=>({name:'TRAM_EXPO_EMBEDDED_TEXTURES',
    loadTexture:async(index:number)=>{
      const definition=parser.json.textures[index],source=parser.json.images[definition.source];
      if(source.uri||source.mimeType!=='image/png'||source.bufferView==null)throw new Error('Skin textures must be embedded PNGs');
      const bytes=await parser.getDependency('bufferView',source.bufferView) as ArrayBuffer;
      const file=new File(directory,`${textureSerial++}-${index}.png`);file.write(new Uint8Array(bytes));
      const size=await new Promise<{width:number;height:number}>((resolve,reject)=>Image.getSize(file.uri,(width,height)=>resolve({width,height}),reject));
      if(size.width>2048||size.height>2048)throw new Error('Skin texture exceeds2048 pixels');
      const texture=new THREE.Texture({localUri:file.uri,...size} as unknown as TexImageSource);
      texture.flipY=false;texture.generateMipmaps=true;
      const sampler=parser.json.samplers?.[definition.sampler]??{};
      const wraps:Record<number,THREE.Wrapping>={33071:THREE.ClampToEdgeWrapping,33648:THREE.MirroredRepeatWrapping,10497:THREE.RepeatWrapping};
      texture.wrapS=wraps[sampler.wrapS]??THREE.RepeatWrapping;texture.wrapT=wraps[sampler.wrapT]??THREE.RepeatWrapping;
      texture.magFilter=sampler.magFilter===9728?THREE.NearestFilter:THREE.LinearFilter;
      const powerOfTwo=(n:number)=>(n&(n-1))===0;
      if(powerOfTwo(size.width)&&powerOfTwo(size.height))texture.minFilter=THREE.LinearMipmapLinearFilter;
      else{texture.wrapS=THREE.ClampToEdgeWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;}
      texture.needsUpdate=true;textures.add(texture);
      parser.associations.set(texture,{textures:index});return texture;
    },
  }));
  return()=>{textures.forEach(texture=>texture.dispose());textures.clear();if(directory.exists)directory.delete();};
}
