// RESEARCH ONLY. Builds a virtual source variant; does not edit serving code.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import * as esbuild from 'esbuild';import {spawnSync} from 'node:child_process';
const dir=process.argv[2];if(!dir)throw Error('capture directory required');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tram-phase-chain-'));
const once=(s,a,b)=>{if(s.split(a).length!==2)throw Error('intervention marker changed: '+a.slice(0,70));return s.replace(a,b)};
const hook=`
import {repairCompressedBoundary} from './compressionBoundary';
import {evalTrajectory as studyEvalTrajectory,prepareHermiteTrack as studyPrepare} from '@/lib/physics/evaluator';
function studyEval(track:any[],t:number){const p=studyPrepare(new Float64Array(track.flatMap(p=>[p.t,p.s])),new Float64Array(track.map(p=>p.v??NaN)));return studyEvalTrajectory(p,t)}
let STUDY_CAPTURE:any=null, STUDY_PREFIX:any=null, STUDY_SPEED:number|null=null, STUDY_CONTINUOUS=false, STUDY_RELEASE:any=null,STUDY_SERVICE=false;
export function studyBuild(args:DriveArgs, startS:number|null, startV:number|null, continuous:boolean, platformId:string|null=null,serviceOnly=false){
 STUDY_CONTINUOUS=continuous; STUDY_SERVICE=serviceOnly; STUDY_PREFIX=null; STUDY_SPEED=null;
 if(startS!==null && args.emittedAtMs>args.anchorMs && args.emittedAtMs-args.anchorMs<120000){
   const originalEmit=args.emittedAtMs;
   const raw=[{t:args.anchorMs,s:startS},...args.raw.filter(p=>p.t>args.anchorMs)];
   for(let i=1;i<raw.length;i++)raw[i]={...raw[i],s:Math.max(raw[i-1].s,raw[i].s)};
   STUDY_SPEED=startV;STUDY_RELEASE=platformId&&args.modal?{stopId:platformId,atMs:args.modal.releaseAtMs}:null;
   const pre=buildDriveVehicle({...args,raw,emittedAtMs:args.anchorMs,modal:null,servedPlatform:null,prev:null,ageFloorS:0,prevFixS:undefined,anchorFixS:startS,clientFixS:startS});
   STUDY_SPEED=null;STUDY_RELEASE=null;
   if(pre&&STUDY_CAPTURE){STUDY_PREFIX=STUDY_CAPTURE;} if(process.env.STUDY_TRACE && args.key==='9096' && args.emittedAtMs===1788687980520)console.error(JSON.stringify({startS,startV,pre,grid:STUDY_CAPTURE?.grid,ss:STUDY_CAPTURE?.fine.s,plan:STUDY_CAPTURE?.plan}));
 }
 const out=buildDriveVehicle(args);STUDY_PREFIX=null;STUDY_SPEED=null;STUDY_CONTINUOUS=false;STUDY_SERVICE=false;return out;
}
function studyCrop(prefix:any, grid:number[]):FineRun {
 const old=prefix.grid, f=prefix.fine;
 const indices=grid.map(t=>Math.max(0,Math.min(old.length-1,(t-old[0])/1000)));
 const interp=(xs:number[],i:number)=>{const a=Math.floor(i),b=Math.min(xs.length-1,a+1),u=i-a;return xs[a]+(xs[b]-xs[a])*u;};
 return {...f,s:indices.map(i=>interp(f.s,i)),v:indices.map(i=>interp(f.v,i)),holdPos:indices.map(i=>f.holdPos[Math.round(i)]),binding:indices.map(i=>f.binding[Math.round(i)]),standKind:indices.map(i=>f.standKind[Math.round(i)]),protectedSteps:new Set([...f.protectedSteps].map((i:any)=>Math.round((old[i]-grid[0])/1000)).filter(i=>i>=0&&i<grid.length))};
}
`;
try{await esbuild.build({stdin:{contents:fs.readFileSync('lab/scripts/counterfactual-phase-chain-entry.ts','utf8'),loader:'ts',resolveDir:path.resolve('lab')},bundle:true,platform:'node',outfile:tmp+'/study.cjs',tsconfig:'lab/tsconfig.runtime.json',plugins:[{name:'research',setup(b){b.onResolve({filter:/drive-recovery$/},()=>({path:path.resolve('lab/src/drive.ts'),namespace:'recoverydrive'}));b.onLoad({filter:/.*/,namespace:'recoverydrive'},a=>{let s=fs.readFileSync(a.path,'utf8');s=once(s,'Math.max(surfaces.paceAt(sI, tMs), surfaces.paceAt(oHold, tMs))','Math.max(surfaces.paceAt(sI, tMs), surfaces.paceAt(oHold, tMs), STUDY_RECOVERY_PACE)');s=once(s,'const paceCeil = Math.max(surfaces.paceAt(sI, tMs), surfaces.paceAt(o, tMs));','const paceCeil = Math.max(surfaces.paceAt(sI, tMs), surfaces.paceAt(o, tMs), STUDY_RECOVERY_PACE);');s=once(s,'vCmd = Math.max(YIELD_FACTOR * vO, Math.min(YIELD_MIN_V_MS, vO));','vCmd = STUDY_REACQUIRE_AHEAD ? Math.min(Math.max(YIELD_FACTOR * vO, Math.min(YIELD_MIN_V_MS, vO)),Math.max(0,vO-Math.max(0,-g-20)/60)) : Math.max(YIELD_FACTOR * vO, Math.min(YIELD_MIN_V_MS, vO));');s=once(s,'vCmd = CREEP_AHEAD_V_MS;','vCmd = STUDY_REACQUIRE_AHEAD ? 0 : CREEP_AHEAD_V_MS;');return{contents:s+`
let STUDY_REACQUIRE_AHEAD=false;let STUDY_RECOVERY_PACE=0;export function studyRecover(a:DriveArgs){const p=a.motionPhase?.approach;STUDY_RECOVERY_PACE=p?.paceEvidence==='observed-span'?p.speedMs:0;const e=(a as any).studyRecovery;STUDY_REACQUIRE_AHEAD=e?.direction===1;if(e?.direction===-1)STUDY_RECOVERY_PACE=Math.max(STUDY_RECOVERY_PACE,e.pace);if((a as any).studyOnlyYield)STUDY_RECOVERY_PACE=0;try{return buildDriveVehicle(a)}finally{STUDY_RECOVERY_PACE=0;STUDY_REACQUIRE_AHEAD=false}}`,loader:'ts',resolveDir:path.dirname(a.path)};});b.onResolve({filter:/drive-fast$/},()=>({path:path.resolve('lab/src/drive.ts'),namespace:'fastdrive'}));b.onLoad({filter:/.*/,namespace:'fastdrive'},a=>({contents:fs.readFileSync(a.path,'utf8').replace('export const V_LIMIT_MAX = 13.9;','export const V_LIMIT_MAX = 16.7;'),loader:'ts',resolveDir:path.dirname(a.path)}));b.onResolve({filter:/drive-runtime$/},()=>({path:path.resolve('lab/src/drive.ts'),namespace:'currentdrive'}));b.onLoad({filter:/.*/,namespace:'currentdrive'},a=>({contents:fs.readFileSync(a.path,'utf8'),loader:'ts',resolveDir:path.dirname(a.path)}));b.onResolve({filter:/^\.\/db$/},()=>({path:'db',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export const round2=n=>Math.round(n*100)/100;export const pct=()=>0;',loader:'js'}));b.onLoad({filter:/\/lab\/src\/drive\.ts$/},a=>{const frozen=spawnSync('git',['show','93720af:lab/src/drive.ts'],{encoding:'utf8'});if(frozen.status!==0)throw Error('pinned baseline unavailable');let s=frozen.stdout;
 s=once(s,'const v0 = standingStart ? 0 : Math.min(vSeamCap, vInherit);','const v0 = STUDY_SPEED!==null ? Math.min(vSeamCap,Math.max(0,STUDY_SPEED)) : standingStart ? 0 : Math.min(vSeamCap, vInherit);');
 s=once(s,'const leaderO = args.leader ? effLeader(args.leader.opinion, s0) : null;','if(STUDY_PREFIX){const crop=studyCrop(STUDY_PREFIX,grid);s0=crop.s[0];plan.splice(0,plan.length,...STUDY_PREFIX.plan);}\nconst leaderO = args.leader ? effLeader(args.leader.opinion, s0) : null;');
 s=once(s,'const oFine = runDrive({','const oFine = STUDY_PREFIX ? studyCrop(STUDY_PREFIX,grid) : runDrive({');
 s=once(s,'if (oFine === null) return null;','if (oFine === null) return null; if(!STUDY_PREFIX)STUDY_CAPTURE={fine:oFine,grid,plan:[...plan]};');
 s=once(s,"if (discKind === 'none') {","if(STUDY_CONTINUOUS && prev.tripId===args.tripId)discKind='none';\n    if (discKind === 'none') {");
 s=once(s,"? clientSmoothProjectionM(prev.smooth.points, args.clientFixS ?? args.anchorFixS, args.anchorMs, t0)","? (STUDY_CONTINUOUS ? studyEval(prev.smooth.points,t0) : clientSmoothProjectionM(prev.smooth.points, args.clientFixS ?? args.anchorFixS, args.anchorMs, t0))");
 s=once(s,': evalTrack(prev.smooth.points, t0);',': STUDY_CONTINUOUS ? studyEval(prev.smooth.points,t0) : evalTrack(prev.smooth.points, t0);');
 s=once(s,'const points: TrackPoint[] = [];\n  const v: number[] = [];',"if(STUDY_CONTINUOUS && process.env.STUDY_REPAIR==='1'){const repaired=repairCompressedBoundary(bounds,vFine,prot,sFine[0],geom.totalM,DT_S,TRAJ_MAX_POINTS);if(repaired.remainingM>.01)console.error(JSON.stringify({unrepaired:repaired.remainingM,total:geom.totalM,start:sFine[0]}));}\n const points: TrackPoint[] = []; const v: number[] = [];");
 s=once(s,"mode === 'ladder' ? grid[i + 1] + legDwellS * 1000 : ref!.gateMs[nextStop]","mode === 'ladder' ? (STUDY_RELEASE?.stopId===target.stopId ? Math.max(grid[i+1]+3000,STUDY_RELEASE.atMs) : grid[i + 1] + legDwellS * 1000) : ref!.gateMs[nextStop]");
 s=once(s,'if (!isTerminal && requestStopSkippable(raw, surfaces, st.stopId, distM)) {','if (!isTerminal && (!STUDY_SERVICE || st.requestOnly === true) && requestStopSkippable(raw, surfaces, st.stopId, distM)) {');
 return {contents:hook+s,loader:'ts'};});}}]});const r=spawnSync(process.execPath,[tmp+'/study.cjs',path.resolve(dir)],{stdio:'inherit'});process.exitCode=r.status??1;}finally{fs.rmSync(tmp,{recursive:true,force:true})}
