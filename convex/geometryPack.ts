// The cold-start geometry pack, hosted in Convex file storage.
//
// Until 2026-08-21 the app fetched this pack straight from the predictor's
// HTTP endpoint — the last thing the client knew the lab host for. Now the
// predictor UPLOADS the pack here (token-gated, same secret as
// trajectories:publish) and the app reads it from the same origin as the rest
// of its backend: GET {site}/geometry-pack (http.ts).
//
// The pack is an opaque gzip blob to this file — the predictor builds it, the
// client parses it (src/lib/golemio/geometryPack.ts owns the wire shape).

import { v } from 'convex/values';
import { httpAction, mutation, query } from './_generated/server';
import { internal } from './_generated/api';

function requireToken(token: string): void {
  const expected = process.env.ENGINE_PUSH_TOKEN;
  if (!expected || token !== expected) {
    throw new Error('geometryPack: bad or unconfigured token');
  }
}

/** Step 1 of an upload: a short-lived URL the predictor POSTs the gzip to. */
export const startUpload = mutation({
  args: { token: v.string() },
  returns: v.object({ uploadUrl: v.string() }),
  handler: async (ctx, args) => {
    requireToken(args.token);
    return { uploadUrl: await ctx.storage.generateUploadUrl() };
  },
});

/** Step 2: adopt the uploaded file as THE pack; the previous file is deleted. */
export const commit = mutation({
  args: {
    token: v.string(),
    storageId: v.id('_storage'),
    atMs: v.number(),
    shapes: v.number(),
    trips: v.number(),
    gzipBytes: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireToken(args.token);
    const row = await ctx.db
      .query('geometryPack')
      .withIndex('by_singleton', (q) => q.eq('singleton', 'pack'))
      .first();
    const fields = {
      storageId: args.storageId,
      atMs: args.atMs,
      shapes: args.shapes,
      trips: args.trips,
      gzipBytes: args.gzipBytes,
    };
    if (row) {
      if (row.storageId !== args.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.patch(row._id, fields);
    } else {
      await ctx.db.insert('geometryPack', { singleton: 'pack', ...fields });
    }
    return null;
  },
});

/** Current pack row (http serve + health checks). */
export const current = query({
  args: {},
  returns: v.union(
    v.object({
      storageId: v.id('_storage'),
      atMs: v.number(),
      shapes: v.number(),
      trips: v.number(),
      gzipBytes: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx) => {
    const row = await ctx.db
      .query('geometryPack')
      .withIndex('by_singleton', (q) => q.eq('singleton', 'pack'))
      .first();
    if (!row) return null;
    return {
      storageId: row.storageId,
      atMs: row.atMs,
      shapes: row.shapes,
      trips: row.trips,
      gzipBytes: row.gzipBytes,
    };
  },
});

/**
 * GET /geometry-pack — the client's one cold-start request. 404 while no pack
 * has ever been uploaded (the client treats that as "no pack", silently).
 * The body is served exactly as uploaded (gzip) with Content-Encoding set, so
 * fetch() on the phone transparently decompresses.
 */
export const serve = httpAction(async (ctx) => {
  const row = await ctx.runQuery(internal.geometryPack.currentInternal, {});
  if (!row) return new Response('no pack', { status: 404 });
  const blob = await ctx.storage.get(row.storageId);
  if (!blob) return new Response('pack file missing', { status: 404 });
  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'public, max-age=60',
      'X-Pack-At': String(row.atMs),
    },
  });
});

// Internal twin of `current` so the http action does not depend on the public
// surface (and the public query can change shape without touching serving).
import { internalQuery } from './_generated/server';

export const currentInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('geometryPack')
      .withIndex('by_singleton', (q) => q.eq('singleton', 'pack'))
      .first();
    return row ? { storageId: row.storageId, atMs: row.atMs } : null;
  },
});
