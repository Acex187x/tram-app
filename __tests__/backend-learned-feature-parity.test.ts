import fixture from '../lab/ml/fixtures/learned-trust-parity.json';
import {LearnedModel} from '../lab/src/learned';
import type {Store} from '../lab/src/db';

describe('Python/TypeScript shared learned trust contract',()=>{
 test.each(fixture.cases)('$name',c=>{
  const rows=c.rows.map(([tbl,cellKey,mean,weight,offset])=>({tbl,cellKey,mean,weight,updatedAtMs:fixture.baseMs+Number(offset),s:0,n:1}));
  const learned=new LearnedModel({loadCells:()=>rows,getMeta:()=>null} as unknown as Store);
  const at=fixture.baseMs+c.ageMs;
  expect(learned.paceAt('shape','route',600,at)).toBe(c.pace);
  expect(learned.releaseAt('stop',at)).toBe(c.release);
  expect(learned.releaseStats('stop',at).mean).toBe(c.release);
 });
 test('expired modal distribution keeps its original broad fallback',()=>{
  const at=fixture.baseMs;
  const rows=[{tbl:'stopRelease',cellKey:'stop|0|weekend',mean:41.58,weight:3.01,updatedAtMs:at-86400000,s:120,n:4}];
  const learned=new LearnedModel({loadCells:()=>rows,getMeta:()=>null} as unknown as Store);
  expect(learned.releaseStats('stop',at)).toEqual({mean:20,sd:12});
 });
});
