import {Directory,File,Paths} from 'expo-file-system';
import {validateSkinPackage,MAX_PACKAGE_BYTES} from './manifest';
import {useSkinsStore} from '@/stores/skins';
import type {SkinRecord} from './registry';
export async function importSkin(uri:string):Promise<SkinRecord>{
  const source=new File(uri);if(!source.exists||source.size>MAX_PACKAGE_BYTES*1.4+10000)throw new Error('Skin file is missing or larger than44 MiB');
  const {manifest:p,decoded,mapTextureBytes,viewerTextureBytes}=validateSkinPackage(JSON.parse(await source.text()));
  const bytes=Object.values(decoded).reduce((sum,b)=>sum+b.length,0);
  if(useSkinsStore.getState().skins.filter(s=>s.id!==p.id).reduce((sum,s)=>sum+s.bytes,0)+bytes>96*1024*1024)throw new Error('Imported skins exceed96 MiB; remove an unused skin first');
  const storage=new Directory(Paths.document,'tram-skins');
  if(storage.exists&&(storage.size??0)+bytes>384*1024*1024)throw new Error('Skin working files exceed384 MiB; restart the app to reclaim removed versions');
  const directory=`${p.id}-${Date.now()}`;const dir=new Directory(Paths.document,'tram-skins',directory);
  try{dir.create({intermediates:true,idempotent:false});
    for(const [name,content] of Object.entries(decoded)){new File(dir,`${name.replace('/','-')}.glb`).write(content);await new Promise(r=>setTimeout(r,0));}
    const skin:SkinRecord={id:p.id,title:p.title,modelId:p.modelId,directory,mapKeys:Object.keys(p.mapAssets),viewerKeys:Object.keys(p.viewerAssets),sourceUrl:p.sourceUrl,notes:p.notes,bytes,mapTextureBytes,viewerTextureBytes,importedAtMs:Date.now()};
    useSkinsStore.getState().add(skin);return skin;
  }catch(e){if(dir.exists)dir.delete();throw e;}
}
