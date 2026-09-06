import type {RouteGeometry,TramSnapshot} from '@/lib/types';
import {projectObservation} from '@/lib/physics/observationProjection';
export interface ApproachEvidence {atMs:number;sM:number;speedMs:number;platformId:string;platformSequence:number;offsetM:number;paceEvidence:'observed-span'|'learned-fallback'}
export interface MotionPhase {kind:'approach'|'probable-dwell'|'moving'|'unknown';sourceAgeS:number;projectionM:number|null;projectionOffsetM:number|null;approach:ApproachEvidence|null}
/** Provider at_stop is an anchor/announcement, never verified door telemetry. */
export function assessMotionPhase(fix:TramSnapshot,previous:TramSnapshot|undefined,geom:RouteGeometry,emittedAtMs:number,paceAt:(s:number,t:number)=>number):MotionPhase {
 const projection=projectObservation(fix,geom),ageS=(emittedAtMs-fix.observedAtMs)/1000;
 const result:MotionPhase={kind:fix.statePosition==='on_track'?'moving':fix.statePosition==='at_stop'?'probable-dwell':'unknown',sourceAgeS:ageS,projectionM:projection?.s??null,projectionOffsetM:projection?.offsetM??null,approach:null};
 if(fix.statePosition!=='at_stop'||!projection||ageS<0||ageS>=120)return result;
 const stops=geom.stops.filter(s=>s.stopId===fix.lastStopId&&s.sequence===fix.lastStopSequence);
 if(stops.length!==1)return result;const st=stops[0],gap=st.distM-projection.s;
 if(!(gap>30&&gap<=150))return result;
 let speedMs=Math.max(2,Math.min(13.9,paceAt(projection.s,fix.observedAtMs))),paceEvidence:'observed-span'|'learned-fallback'='learned-fallback';
 if(previous?.tripId===fix.tripId){const p=projectObservation(previous,geom),dt=(fix.observedAtMs-previous.observedAtMs)/1000;if(p&&dt>=5&&dt<=120&&projection.s>=p.s){speedMs=Math.min(16.7,(projection.s-p.s)/dt);paceEvidence='observed-span';}}
 return {...result,kind:'approach',approach:{atMs:fix.observedAtMs,sM:projection.s,speedMs,platformId:st.stopId,platformSequence:st.sequence,offsetM:projection.offsetM,paceEvidence}};
}
/** Existing learned dwell cells name the successor, not the served platform.
 * Repeated IDs and terminal visits have no safe legacy correspondence. */
export function legacyDwellSuccessor(geom:RouteGeometry,stopId:string):string|null {
 const current=geom.stops.filter(s=>s.stopId===stopId);if(current.length!==1)return null;
 const st=current[0],i=geom.stops.indexOf(st),next=geom.stops[i+1];
 if(st.isTerminal||!next||next.sequence<=st.sequence||next.distM<=st.distM||geom.stops.filter(s=>s.stopId===next.stopId).length!==1)return null;
 return next.stopId;
}
