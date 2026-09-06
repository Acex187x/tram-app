/** Refresh after base geometry changes; derives evidence from real53GLBs. */
import {readFileSync,writeFileSync} from 'node:fs';
import {inspectGlb} from '../../src/lib/skins/manifest';
import {MODEL_SPECS} from '../../src/lib/fleet/modelSpecs';
const result:Record<string,unknown>={};
for(const spec of Object.values(MODEL_SPECS))for(const section of spec.sections){
 for(const key of [section.modelKey,...section.openModelKey?[section.openModelKey]:[]])result[`map/${key}`]=key.endsWith('-open')?inspectGlb(new Uint8Array(readFileSync(`assets/models/${section.modelKey}-viewer.glb`)),true):inspectGlb(new Uint8Array(readFileSync(`assets/models/${key}.glb`)));
 result[`viewer/${section.modelKey}`]=inspectGlb(new Uint8Array(readFileSync(`assets/models/${section.modelKey}-viewer.glb`)));
}
writeFileSync('src/lib/skins/compatibility.json',JSON.stringify(result,null,2)+'\n');
console.log(Object.keys(result).length,'asset envelopes recorded');
