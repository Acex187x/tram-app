// HTTP actions, served at CONVEX_SITE_ORIGIN (https://tram-site.acex.sh).
//
// One route today: geometry serving (backend-convex.md §7 step 4). The app
// makes NO direct Golemio requests — this is the only path trip geometry
// reaches a client by, and the Golemio key never leaves the server.

import { httpRouter } from 'convex/server';
import { serve } from './geometry';

const http = httpRouter();

http.route({
  pathPrefix: '/geometry/',
  method: 'GET',
  handler: serve,
});

export default http;
