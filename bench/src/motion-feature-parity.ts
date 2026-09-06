/** Replay captured post-fusion fixes through the real TS history and learned
 * callback. This is cross-language parity, not a historical accuracy score. */
import { readFileSync } from 'node:fs';
import { MotionFeatureHistory } from '../../lab/src/motionFeatures';
import { LearnedModel } from '../../lab/src/learned';
import { pragueContext } from '../../lab/src/config';
import type { Store } from '../../lab/src/db';
import type { RouteGeometry, TramSnapshot } from '@/lib/types';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const learned = new LearnedModel({
  loadCells: () => input.cellRows.map((row: object) => ({ s: 0, n: 0, ...row })),
  getMeta: () => null,
} as unknown as Store);
const history = new MotionFeatureHistory();
const offsets = [0, 30_000, 120_000, 180_000, 360_000];
const paceCalls: object[] = [];
const paceAt = (shapeId: string, routeId: string, distM: number, observedAtMs: number) => {
  const value = learned.paceAt(shapeId, routeId, distM, observedAtMs);
  const context = pragueContext(observedAtMs);
  paceCalls.push({ shapeId, routeId, distM, observedAtMs, hourBand: Math.floor(context.hour / 4), dayType: context.dayType, value });
  return value;
};
const rows = input.fixes.map((row: any, index: number) => ({ row, index }))
  .sort((a: any, b: any) => a.row.seenAtMs - b.row.seenAtMs || a.index - b.index);
const outputs: object[] = [];
for (const { row, index } of rows) {
  const snapshot = { ...row, observedAtMs: row.obsAtMs, coordinates: [row.lng, row.lat],
    statePosition: row.statePos, lastStopId: null, nextStopId: row.nextStopId ?? null } as TramSnapshot;
  const evidence = history.observe(snapshot, input.geometries[row.tripId] as RouteGeometry | undefined, paceAt, row.seenAtMs);
  outputs.push({ index, fresh: evidence.freshObservation, values: offsets.map(offset =>
    history.features(row.key, row.tripId, row.seenAtMs + offset)) });
}
console.log(JSON.stringify({ offsets, outputs, paceCalls }));
