// HTTP actions, served at CONVEX_SITE_ORIGIN (https://tram-site.acex.sh).
//
// Two routes: per-trip geometry (backend-convex.md §7 step 4) and the
// cold-start geometry pack (uploaded by the predictor, 2026-08-21). The app
// makes NO direct Golemio requests and, since the pack moved here, knows no
// other backend host at all.

import { httpRouter } from 'convex/server';
import { serve } from './geometry';
import { serve as servePack } from './geometryPack';

const http = httpRouter();

http.route({
  pathPrefix: '/geometry/',
  method: 'GET',
  handler: serve,
});

http.route({
  path: '/geometry-pack',
  method: 'GET',
  handler: servePack,
});

export default http;
