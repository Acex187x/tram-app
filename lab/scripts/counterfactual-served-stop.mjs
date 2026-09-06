// Offline exact-input comparison: legacy plan omits served-platform evidence;
// candidate uses the captured identity. No persisted cells/server are changed.
// Usage: node lab/scripts/counterfactual-served-stop.mjs CAPTURE_DIR > result.json
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capture = process.argv[2];
if (!capture) throw Error('capture directory required');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tram-double-stop-study-'));
const program = fs.readFileSync(path.join(lab, 'scripts/counterfactual-served-stop-entry.ts'), 'utf8');
try {
  await esbuild.build({
    stdin: { contents: program, loader: 'ts', resolveDir: lab },
    bundle: true, platform: 'node', outfile: path.join(temporary, 'study.cjs'),
    tsconfig: path.join(lab, 'tsconfig.runtime.json'),
    plugins: [{name:'offline-intervention',setup(build) {
      build.onResolve({filter:/^\.\/db$/}, () => ({path:'db-stub',namespace:'stub'}));
      build.onLoad({filter:/.*/,namespace:'stub'}, () => ({contents:'export const round2=n=>Math.round(n*100)/100; export const pct=()=>{throw Error("unused DB helper")}',loader:'js'}));

    }}],
  });
  const result=spawnSync(process.execPath,[path.join(temporary,'study.cjs'),path.resolve(capture)],{stdio:'inherit'});
  if(result.error) throw result.error;
  process.exitCode=result.status??1;
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
