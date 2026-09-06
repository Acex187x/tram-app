/** Strict temporal gate for current ride/calibration JSONL. No legacy file is
 * silently promoted to causal accuracy data. Usage: node ... file.jsonl [...] */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['src/lib/physics/predictionTiming.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { predictionTimingEligibility } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const files = process.argv.slice(2);
if (!files.length) throw Error('Expected JSONL files');
for (const file of files) {
  const bytes = readFileSync(file);
  const text = (file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
  const counts = { eligible: 0, 'unknown-availability': 0, 'timestamp-mismatch': 0, 'future-input': 0 };
  let malformed = 0, passive = 0, qualityExcluded = 0;
  const errors = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { malformed++; continue; }
    if (!r || r.type) continue;
    const reason = predictionTimingEligibility(r, r.t);
    counts[reason]++;
    if (!Object.hasOwn(r, 'gpsLat')) { passive++; continue; }
    if (reason !== 'eligible') continue;
    if (r.rej != null || !Number.isFinite(r.lagM) || !Number.isFinite(r.gpsAcc) || r.gpsAcc < 0 || r.gpsAcc > 25 || !Number.isFinite(r.gpsOffM) || r.gpsOffM > 30) {
      qualityExcluded++; continue;
    }
    errors.push(r.lagM);
  }
  const absolute = errors.map(Math.abs).sort((a, b) => a - b);
  console.log(JSON.stringify({ file, malformed, predictionTimingCounts: counts, temporalExcluded: counts['unknown-availability'] + counts['timestamp-mismatch'] + counts['future-input'], passiveRecordsWithoutSameTimeGpsTruth: passive, gpsQualityExcluded: qualityExcluded, eligibleRideGpsPairs: errors.length, rideGpsMaeM: errors.length ? absolute.reduce((a,b) => a+b,0)/errors.length : null, rideGpsBiasM: errors.length ? errors.reduce((a,b)=>a+b,0)/errors.length : null, rideGpsP90M: absolute.length ? absolute[Math.min(absolute.length - 1, Math.floor(.9 * absolute.length))] : null, limitation: 'Temporal and GPS accuracy/offset gates do not prove correct trip/rail projection or that the rider is aboard. Current prediction values are not the displayed Mapbox marker. Passive obsDist is older evidence and never scored against same-row simDist.' }));
}
