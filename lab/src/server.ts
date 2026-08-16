// Plain-node HTTP server: the live map (static HTML) + JSON API.

import fs from 'fs';
import http from 'http';
import path from 'path';
import { HTTP_PORT } from './config';

export interface ServerDeps {
  getLive: () => unknown;
  getSummary: () => unknown;
  /** Already-serialized JSON (cached upstream) — sent verbatim. */
  getTrajectories: () => string;
  /** physics-v3 bundle (docs/research/physics-v3-protocol.md), also cached. */
  getTrajectoriesV2: () => string;
  /** Published curves + recent real fixes for one vehicle (the /physics page). */
  getVehicleDebug: (key: string) => unknown;
  isHealthy: () => boolean;
}

export function startServer(deps: ServerDeps): void {
  const mapHtml = fs.readFileSync(path.join(__dirname, 'static', 'map.html'));
  const physicsHtml = fs.readFileSync(path.join(__dirname, 'static', 'physics.html'));

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const jsonRaw = (code: number, serialized: string) => {
      const buf = Buffer.from(serialized);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    };
    const json = (code: number, body: unknown) => jsonRaw(code, JSON.stringify(body));
    try {
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(mapHtml);
      } else if (url === '/physics') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(physicsHtml);
      } else if (url.startsWith('/api/vehicle/') && url.endsWith('/debug')) {
        const key = decodeURIComponent(url.slice('/api/vehicle/'.length, -'/debug'.length));
        json(200, deps.getVehicleDebug(key));
      } else if (url === '/api/live') {
        json(200, deps.getLive());
      } else if (url === '/api/summary') {
        json(200, deps.getSummary());
      } else if (url === '/api/trajectories') {
        jsonRaw(200, deps.getTrajectories()); // v1 — build-12 phones; frozen
      } else if (url === '/api/trajectories/v2') {
        jsonRaw(200, deps.getTrajectoriesV2());
      } else if (url === '/api/mlreport') {
        try {
          const raw = fs.readFileSync('/data/models/report.json', 'utf8');
          json(200, JSON.parse(raw));
        } catch {
          json(404, { error: 'no ML report yet (first training pending)' });
        }
      } else if (url === '/healthz') {
        json(deps.isHealthy() ? 200 : 503, { ok: deps.isHealthy() });
      } else {
        json(404, { error: 'not found' });
      }
    } catch (e) {
      json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.listen(HTTP_PORT, () => {
    console.log(`[lab] http on :${HTTP_PORT}`);
  });
}
