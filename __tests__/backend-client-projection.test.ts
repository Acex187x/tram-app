/// <reference types="jest" />
jest.mock('../lab/src/db', () => ({ round2: (n: number) => Math.round(n * 100) / 100 }));
import { clientProjectionM, clientSmoothProjectionM } from '../lab/src/trajectory';
import { renderedDistM } from '@/lib/physics/render';
const track=[{t:0,s:0},{t:10000,s:100},{t:20000,s:200}];
const packed=new Float64Array(track.flatMap(p=>[p.t,p.s]));
it('keeps the smooth seam on the client when time winding consumes the horizon early',()=>{
 expect(clientSmoothProjectionM(track,150,5000,19000)).toBe(218);
});
it('matches actual client composition across fixed/smooth, finite/overrun and coasting cases',()=>{
 for(const fixS of [0,50,150,200,201,300])for(const fixAt of [0,5000,18000])for(const now of [0,5000,19000,20000,30000,50000]){
  expect(clientSmoothProjectionM(track,fixS,fixAt,now)).toBeCloseTo(renderedDistM(packed,now,2,fixS,fixAt,NaN),8);
  expect(clientProjectionM(track,fixS,fixAt,now)).toBeCloseTo(renderedDistM(packed,now,Infinity,fixS,fixAt,NaN),8);
 }
});
