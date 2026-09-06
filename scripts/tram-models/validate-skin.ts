import {readFileSync} from 'node:fs';
import {validateSkinPackage} from '../../src/lib/skins/manifest';
const result=validateSkinPackage(JSON.parse(readFileSync(process.argv[2],'utf8')));
console.log(`Validated ${result.manifest.title}: ${Object.keys(result.decoded).length} compatible GLBs`);
