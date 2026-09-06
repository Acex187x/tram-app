/// <reference types="jest" />
jest.mock('../convex/_generated/server', () => ({
  mutation: (definition: unknown) => definition,
  internalMutation: (definition: unknown) => definition,
  query: (definition: unknown) => definition,
}));
import { publish, sweepStaleVehicles } from '../convex/trajectories';

const handler = (fn: unknown) => (fn as {handler: (ctx: any, args: any) => Promise<any>}).handler;
function database() {
  const tables: Record<string, any[]> = {
    trajectoryMeta: [{_id: 'meta', singleton: 'meta', lastSeq: 9, atMs: 2_000_000, publishedAtMs: 2_000_001}],
    trajectoryVehicles: [], trajectoryBatches: [],
  };
  const valueAt = (row: any, path: string) => path.split('.').reduce((v, key) => v[key], row);
  const db = {
    query: (table: string) => {
      let rows = [...tables[table]];
      const chain: any = {
        withIndex: (_name: string, filter?: (q: any) => void) => {
          const q = {eq: (key: string, value: any) => {rows = rows.filter(r => valueAt(r,key) === value); return q;},
            lt: (key: string, value: any) => {rows = rows.filter(r => valueAt(r,key) < value); return q;}};
          filter?.(q);return chain;
        },
        first: async () => rows[0] ?? null, take: async (n: number) => rows.slice(0,n),
      };return chain;
    },
    insert: async (table: string, row: any) => {tables[table].push({_id: `${table}-${tables[table].length}`, ...row});},
    patch: async (id: string, fields: any) => {Object.assign(Object.values(tables).flat().find(r => r._id === id), fields);},
    delete: async (id: string) => {for (const name in tables) tables[name] = tables[name].filter(r => r._id !== id);},
  };
  return {db, tables};
}

describe('published trajectory delta integrity', () => {
  beforeEach(() => {process.env.ENGINE_PUSH_TOKEN = 'test-only';});
  afterEach(() => {delete process.env.ENGINE_PUSH_TOKEN;});
  it('heartbeats refresh liveness without spending a delta sequence', async () => {
    const ctx = database();
    const args = {token:'test-only',atMs:2_001_000,horizonS:120,generator:'drive-v3',changed:[],removed:[]};
    expect(await handler(publish)(ctx,args)).toEqual({seq:9});
    expect(ctx.tables.trajectoryMeta[0].atMs).toBe(args.atMs);
    expect(ctx.tables.trajectoryBatches).toHaveLength(0);
    expect(await handler(publish)(ctx,{...args,removed:['gone']})).toEqual({seq:10});
    expect(ctx.tables.trajectoryBatches[0]).toMatchObject({seq:10,removed:['gone']});
  });
  it('retiring ghosts behind >256 fresh rows sends a removal without pretending the predictor checked in', async () => {
    const ctx = database();
    ctx.tables.trajectoryVehicles = Array.from({length:300}, (_,i) => ({_id:`fresh-${i}`,key:`fresh-${i}`,vehicle:{emittedAtMs:1_999_000}}));
    ctx.tables.trajectoryVehicles.push({_id:'ghost',key:'ghost',vehicle:{emittedAtMs:100}});
    expect(await handler(sweepStaleVehicles)(ctx,{})).toEqual({deleted:1});
    expect(ctx.tables.trajectoryVehicles).toHaveLength(300);
    expect(ctx.tables.trajectoryBatches[0]).toMatchObject({seq:10,atMs:2_000_000,changed:[],removed:['ghost']});
    expect(ctx.tables.trajectoryBatches[0].publishedAtMs).toBeGreaterThan(2_000_000);
    expect(ctx.tables.trajectoryMeta[0]).toMatchObject({lastSeq:10,atMs:2_000_000,publishedAtMs:2_000_001});
  });
});
