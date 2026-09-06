import type {RouteGeometry, TramSnapshot} from '../../src/lib/types';
import {assessGeometryCoherence, type GeometryCoherence} from '../../src/lib/physics/geometryCoherence';

export function isOlderSameTripFix(
  incoming: Pick<TramSnapshot, 'tripId' | 'observedAtMs'>,
  current: Pick<TramSnapshot, 'tripId' | 'observedAtMs'> | undefined,
): boolean {
  return current !== undefined && incoming.tripId === current.tripId
    && incoming.observedAtMs < current.observedAtMs;
}

/** Invalid observations remain inspectable while they are excluded from the
 * learned/predicted axis. Entries are rechecked on new fixes or new geometry;
 * there is no timeout or permanent quarantine latch. */
export class SourceValidity {
  private cache = new Map<string, {snapshot:TramSnapshot; geometry:RouteGeometry|undefined; result:GeometryCoherence}>();
  private invalid = new Map<string, {snapshot:TramSnapshot; result:GeometryCoherence}>();
  rejectedObservations = 0;
  assess(snapshot:TramSnapshot, geometry:RouteGeometry|undefined):GeometryCoherence {
    const prior=this.cache.get(snapshot.key);
    if(prior?.snapshot===snapshot&&prior.geometry===geometry)return prior.result;
    const result=assessGeometryCoherence(snapshot,geometry);
    this.cache.set(snapshot.key,{snapshot,geometry,result});
    if(result.status==='invalid'){
      if(this.invalid.get(snapshot.key)?.snapshot.observedAtMs!==snapshot.observedAtMs)this.rejectedObservations++;
      this.invalid.set(snapshot.key,{snapshot,result});
    }else this.invalid.delete(snapshot.key);
    return result;
  }
  get(key:string):{snapshot:TramSnapshot; result:GeometryCoherence}|undefined {return this.invalid.get(key);}
  /** Snapshot the iterator before reassessment mutates the quarantine map. */
  recoverable(resolve:(tripId:string)=>RouteGeometry|undefined):TramSnapshot[] {
    const recovered:TramSnapshot[]=[];
    for(const {snapshot} of [...this.invalid.values()]){
      const geometry=resolve(snapshot.tripId);
      if(geometry&&this.assess(snapshot,geometry).status!=='invalid')recovered.push(snapshot);
    }
    return recovered;
  }
  drop(key:string):void {this.cache.delete(key);this.invalid.delete(key);}
  retain(keys:Set<string>):void {for(const key of this.cache.keys())if(!keys.has(key))this.drop(key);}
  get size():number{return this.invalid.size;}
}
