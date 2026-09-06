import { v } from 'convex/values';
import { query } from './_generated/server';

/** Explicit clock sample. Feed queries are cached: their Date.now() is the
 * transaction time, potentially seconds before delivery, not a send timestamp.
 * A unique nonce forces a fresh transaction. Clients measure request RTT and
 * use its midpoint, rejecting slow samples; never subscribe to this query.
 */
export const now = query({
  args: { nonce: v.string() },
  returns: v.object({ serverNowMs: v.number() }),
  handler: async () => ({ serverNowMs: Date.now() }),
});
