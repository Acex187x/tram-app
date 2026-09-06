/// <reference types="jest" />
jest.mock('../lab/src/db', () => ({ round2: (n: number) => Math.round(n * 100) / 100 }));
it('passes the full offline generator contract and perceptual invariant suite', () => {
 const exit = jest.spyOn(process, 'exit').mockImplementation((code?: number|string|null):never => {
   if(code) throw new Error(`generator selftest failed: ${code}`);
   return undefined as never;
 });
 try { require('../lab/scripts/selftest-v2'); } finally {exit.mockRestore();}
});
