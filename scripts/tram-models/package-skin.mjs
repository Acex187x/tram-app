/** Package authored embedded-texture GLBs for native Files import.
 * node scripts/tram-models/package-skin.mjs author-directory metadata.json output.json
 */
import {readFile,writeFile,readdir,mkdir,rename,rm} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
const [source,metadataPath,output]=process.argv.slice(2);
if(!source||!metadataPath||!output)throw new Error('Use AUTHOR_DIRECTORY METADATA_JSON OUTPUT_JSON');
const geometry=spawnSync(process.execPath,['scripts/tram-models/verify-skin-geometry.mjs',source],{stdio:'inherit'});
if(geometry.status!==0)throw new Error('Authored skin changed base geometry or mechanisms');
const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
const pack={schemaVersion:1,id:metadata.id,title:metadata.title,modelId:metadata.modelId,sourceUrl:metadata.sourceUrl,notes:metadata.notes,mapAssets:{},viewerAssets:{}};
for(const role of ['map','viewer'])for(const name of (await readdir(resolve(source,role))).filter(n=>n.endsWith('.glb'))){
 const key=name.replace(/-viewer\.glb$/,'.glb').replace(/\.glb$/,'');
 if(!/^[a-z0-9-]+$/.test(key))throw new Error('Noncanonical asset filename');
 pack[`${role}Assets`][key]=(await readFile(resolve(source,role,name))).toString('base64');
}
await mkdir(dirname(resolve(output)),{recursive:true});const temp=resolve(dirname(output),`.${basename(output)}.${process.pid}.tmp`);
try{await writeFile(temp,JSON.stringify(pack));const check=spawnSync('npx',['--yes','tsx','--tsconfig','lab/tsconfig.runtime.json','scripts/tram-models/validate-skin.ts',temp],{stdio:'inherit'});
 if(check.status!==0)throw new Error('Skin compatibility validation failed');await rename(temp,resolve(output));console.log('Ready for native Files import:',resolve(output));
}catch(e){await rm(temp,{force:true});throw e;}
