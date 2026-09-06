/** Recover an endpoint budget lost by velocity-knot compression. Interior
 * splits restore fine-profile area; paired removals retain the wire budget.
 * The seam, holds and protected curvature knots are never removed. */
export function repairCompressedBoundary(
  bounds:number[], velocities:readonly number[], protectedSteps:ReadonlySet<number>,
  startM:number, totalM:number, stepS:number, maxPoints:number,
): {repaired:boolean; remainingM:number} {
  const area=(a:number,b:number)=>(velocities[a]+velocities[b])*.5*(b-a)*stepS;
  const end=()=>startM+bounds.slice(1).reduce((sum,b,j)=>sum+area(bounds[j],b),0);
  let over=end()-totalM,repaired=false;
  // Rare endpoint pressure path, bounded independently of horizon length.
  for(let attempt=0;over>1e-7&&attempt<maxPoints*2;attempt++){
    let best:{split:number;remove:number|null;delta:number}|null=null;
    for(let j=1;j<bounds.length;j++){
      const a=bounds[j-1],b=bounds[j];
      for(let split=a+1;split<b;split++){
        const splitDelta=area(a,split)+area(split,b)-area(a,b);
        if(splitDelta>=-1e-8)continue;
        const expanded=[...bounds.slice(0,j),split,...bounds.slice(j)];
        if(expanded.length<=maxPoints){if(!best||splitDelta<best.delta)best={split,remove:null,delta:splitDelta};continue;}
        for(let k=1;k<expanded.length-1;k++){
          const remove=expanded[k];if(remove===split||protectedSteps.has(remove))continue;
          const l=expanded[k-1],r=expanded[k+1];
          const delta=splitDelta+area(l,r)-area(l,remove)-area(remove,r);
          if(delta< -1e-8&&(!best||delta<best.delta))best={split,remove,delta};
        }
      }
    }
    if(!best)break;
    if(best.remove!==null)bounds.splice(bounds.indexOf(best.remove),1);
    bounds.push(best.split);bounds.sort((a,b)=>a-b);repaired=true;over=end()-totalM;
  }
  return {repaired,remainingM:Math.max(0,over)};
}
