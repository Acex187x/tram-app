import { appendSample, diagnose, geometryEvidence, formatNumber, HISTORY_LIMIT, sampleFuture, sampledSpeed, standDuration, type MotionSample } from '../src/components/debug/diagnostics';
import type { PhysicsDebugInfo } from '../src/lib/types';
const sample = (atMs: number, renderedM = 10, tripId = 'a'): MotionSample => ({ atMs, renderedM, tripId, mode: 'smooth', speedKmh: 0, deltaM: null, fixAgeS: 0, emissionAgeS: null });
const debug = (override: Partial<PhysicsDebugInfo> = {}): PhysicsDebugInfo => ({ hasGeometry: true, hasTrajectory: true, pastHorizon: false, simSpeedKmh: 0, phase: 'dwell', connection: 'live', renderGuardActive: false, ...override }) as PhysicsDebugInfo;

describe('bounded tracking evidence', () => {
  it('retains at most a minute and never joins different trips or modes', () => {
    let history: MotionSample[] = [];
    for (let i = 0; i < 600; i++) history = appendSample(history, sample(i * 1000));
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0].atMs).toBe(539000);
    expect(appendSample(history, sample(600000, 5, 'b'))).toHaveLength(1);
    expect(appendSample(history, { ...sample(600000), mode: 'fixed' })).toHaveLength(1);
  });
  it('does not turn a pause or clock reversal into speed or a long freeze', () => {
    expect(sampledSpeed([sample(0), sample(1000, 20)])).toBe(36);
    expect(sampledSpeed([sample(0), sample(10000, 20)])).toBeNull();
    expect(standDuration([sample(0), sample(1000), sample(10000), sample(11000)])).toBe(1);
    expect(appendSample([sample(1000)], sample(900))).toEqual([sample(900)]);
  });
  it('bounds stationary evidence by half a meter around the latest marker', () => {
    expect(standDuration([sample(0, 0), sample(1000, 4), sample(2000, 4.1), sample(3000, 4.2)])).toBe(2);
  });
  it('never confuses missing values with zero', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(2, 1, true)).toBe('+2.0');
  });
});
describe('future curves and hold diagnoses', () => {
  const track = new Float64Array([1000, 10, 16000, 40]);
  it('samples only valid published future; no endpoint-clamp forecast', () => {
    expect(sampleFuture(track, 6000)).toEqual([{seconds:0,distanceM:20},{seconds:5,distanceM:30},{seconds:10,distanceM:40}]);
    expect(sampleFuture(track, 17000)).toEqual([]);
    expect(sampleFuture(track, 0)).toEqual([]);
    expect(sampleFuture(undefined, 1000)).toEqual([]);
  });
  it('does not say a coasting past-horizon tram has frozen', () => {
    expect(diagnose(debug({pastHorizon:true,simSpeedKmh:5}), [], []).title).toContain('докатывание');
    expect(diagnose(debug({pastHorizon:true}), [], []).title).toContain('удерживается');
  });
  it('does not claim a profile hold proves a physical stop', () => {
    expect(diagnose(debug(), [], []).detail).toContain('неизвестна');
  });
  it('exposes movement later in the curve without inventing the cause', () => {
    const history = Array.from({ length: 7 }, (_, i) => sample(i * 1000));
    const verdict = diagnose(debug(), history, [{seconds:0,distanceM:10},{seconds:30,distanceM:100}]);
    expect(verdict.title).toContain('путь впереди есть');
    expect(verdict.detail).toContain('ещё не доказательство бага');
  });
  it('identifies client hold from its explicit guard gap', () => {
    expect(diagnose(debug({renderGuardActive:true,renderGuardGapM:-20}), [], []).title).toContain('отставшую цель');
  });
  it('prioritizes contradictory geometry over generic loading, missing profile or hold', () => {
    const verdict = diagnose(debug({geometryCoherence:'invalid',hasGeometry:false,hasTrajectory:false,pastHorizon:true}), [], []);
    expect(verdict.level).toBe('warning');
    expect(verdict.title).toBe('Фикс противоречит маршруту');
    expect(verdict.detail).toContain('GPS-координаты без протяжки');
    expect(verdict.detail).toContain('не подтверждает остановку');
  });
  it('keeps missing coherence evidence distinct from a passed contradiction check', () => {
    expect(geometryEvidence(debug()).title).toContain('неизвестна');
    expect(geometryEvidence(debug({geometryCoherence:'unknown',geometryCoherenceReason:'missing-stop-ids'})).detail).toContain('Недостаточно идентификаторов');
    expect(geometryEvidence(debug({geometryCoherence:'unknown',geometryCoherenceReason:'missing-geometry'})).detail).toContain('недоступна');
    expect(geometryEvidence(debug({geometryCoherence:'unknown',geometryCoherenceReason:'nonfinite-position'})).detail).toContain('не позволяют');
    expect(geometryEvidence(debug({geometryCoherence:'valid'})).detail).toContain('не гарантия точности');
  });
});
