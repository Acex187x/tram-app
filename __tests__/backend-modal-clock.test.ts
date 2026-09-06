jest.mock('../lab/src/db', () => ({ round2: (n: number) => Math.round(n * 100) / 100 }));
import { modalReleaseForFix } from '../lab/src/trajectory';

test('a 20s measured release ends 20s after observation even if the fix arrives 6s late', () => {
  const fix = {observedAtMs:100_000, receivedAtMs:106_000};
  const release = modalReleaseForFix(fix,0,20,0);
  expect(release).toBe(120_000);
  // This is the former phantom-dwell window: the tram should have departed,
  // but the legacy observation+5s anchor held it until125s.
  expect(release).toBeLessThan(122_000);
  const delayed = {...fix,receivedAtMs:118_000};
  expect(modalReleaseForFix(delayed,0,20,0)).toBe(release);
});
test('already-observed standing credit and genuine long timing holds are preserved', () => {
  expect(modalReleaseForFix({observedAtMs:100_000},12,20,0)).toBe(108_000);
  expect(modalReleaseForFix({observedAtMs:100_000},200,20,5)).toBe(200_000);
});
