import {repairCompressedBoundary} from '../lab/src/compressionBoundary';
const endpoint=(b:number[],v:number[],start=0)=>start+b.slice(1).reduce((s,x,i)=>s+(v[b[i]]+v[x])*.5*(x-b[i]),0);
it('repairs area inflation without changing the seam or exceeding the knot budget',()=>{
 const v=[2,1,0,1,2],b=[0,1,4],protectedSteps=new Set([0,4]);
 expect(endpoint(b,v)).toBe(6);
 const r=repairCompressedBoundary(b,v,protectedSteps,0,4,1,3);
 expect(r.remainingM).toBe(0);expect(b).toEqual([0,2,4]);expect(endpoint(b,v)).toBe(4);
 expect(v).toEqual([2,1,0,1,2]);
});
it('keeps already admissible profiles byte-identical and retains protected holds',()=>{
 const b=[0,2,4],v=[2,1,0,1,2];
 expect(repairCompressedBoundary(b,v,new Set(b),0,4,1,3)).toEqual({repaired:false,remainingM:0});
 expect(b).toEqual([0,2,4]);
 const tight=[0,1,4];const r=repairCompressedBoundary(tight,v,new Set(tight),0,4,1,3);
 expect(r.remainingM).toBe(2);expect(tight).toEqual([0,1,4]);
});
it('repairs a terminal plateau rather than clamping its moving knot to a stand',()=>{
 const v=[3,2,1,0,1,2,1,0,0,0],b=[0,6,7,9],start=100,total=start+v.slice(1).reduce((s,x,i)=>s+(x+v[i])*.5,0);
 const before=[...v];const r=repairCompressedBoundary(b,v,new Set([0,7,9]),start,total,1,5);
 expect(r.remainingM).toBe(0);expect(endpoint(b,v,start)).toBeLessThanOrEqual(total+1e-8);
 expect(b[0]).toBe(0);expect(b).toContain(7);expect(b.at(-1)).toBe(9);expect(b.length).toBeLessThanOrEqual(5);expect(v).toEqual(before);
});
