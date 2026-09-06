import { observationPredictions, ObservationHistory } from '../lab/src/observationScore';
const curve = {
  tripId: 'trip', anchorMs: 0, emittedAtMs: 10_000,
  opinion: [{t:10_000,s:0,v:0},{t:20_000,s:50,v:10}],
  smooth: [{t:10_000,s:0,v:0},{t:20_000,s:50,v:10}],
};
test('evaluates observation timestamp with the same eligible cubic as client', () => {
  const p = observationPredictions(curve, {tripId:'trip',observedAtMs:15_000});
  expect(p?.opinion).toBeCloseTo(12.5, 6);
  expect(p?.smooth).toBeCloseTo(12.5, 6);
});
test('never scores a future emission, wrong trip or extrapolated horizon as predicted truth', () => {
  expect(observationPredictions(curve, {tripId:'trip',observedAtMs:9_000})).toBeNull();
  expect(observationPredictions(curve, {tripId:'other',observedAtMs:15_000})).toBeNull();
  expect(observationPredictions(curve, {tripId:'trip',observedAtMs:21_000})).toBeNull();
});

test('selects the previously published revision when newest was issued after delayed truth', () => {
  const history = new ObservationHistory();
  history.record('v', curve, 10_500);
  history.record('v', {...curve, emittedAtMs:16_000, opinion:curve.opinion.map(p=>({...p,s:p.s+100}))}, 16_500);
  expect(history.predict('v',{tripId:'trip',observedAtMs:15_000})?.prediction.opinion).toBeCloseTo(12.5);
  expect(history.counts.eligible).toBe(1);
  expect(history.predict('v',{tripId:'trip',observedAtMs:10_200})).toBeNull();
  history.prune(400_000);
  expect(history.size).toBe(0);
});

test('withdrawn invalid-axis history cannot contaminate the first recovered observation', () => {
  const history = new ObservationHistory();
  history.record('invalid', curve, 10_500);
  history.record('other', curve, 10_500);
  history.forget('invalid');
  expect(history.predict('invalid', {tripId:'trip',observedAtMs:15_000})).toBeNull();
  expect(history.predict('other', {tripId:'trip',observedAtMs:15_000})).not.toBeNull();
  history.record('invalid', curve, 14_000);
  expect(history.predict('invalid', {tripId:'trip',observedAtMs:15_000})).not.toBeNull();
});
