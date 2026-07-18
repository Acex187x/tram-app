// TransPhoto (transphoto.org — "Urban Electric Transit", formerly СТТС)
// integration: community photo archive with a page per physical vehicle,
// including the whole Prague tram fleet. Vehicle pages use internal ids
// (/vehicle/54427/), not fleet numbers, so we resolve a DPP registration
// number → vehicle page via the site's own public quick-search endpoint
// (/api.php?action=index-qsearch…) — the exact same anonymous GET the search
// widget on https://transphoto.org/city/82/ issues. One tiny request per
// screen open; the photos themselves are never scraped — the resolved page is
// rendered as-is in a WebView so photographer credits, watermarks and site
// branding stay intact.
//
// The server rejects bot-looking user agents on HTML pages (403), so the
// resolver sends a Safari-like UA. WKWebView's real UA passes fine.

export const TRANSPHOTO_BASE = 'https://transphoto.org';

/** Prague's city id on TransPhoto (transphoto.org/city/82/). */
export const PRAGUE_CITY_ID = 82;

/** Vehicle-type discriminator used by the quick search. 1 = tramway. */
const VEHICLE_TYPE_TRAM = 1;

/** Prague city page — browser fallback when a car can't be resolved. */
export const PRAGUE_CITY_URL = `${TRANSPHOTO_BASE}/city/${PRAGUE_CITY_ID}/?lang=en`;

/** Safari-like UA for the resolver fetch (bot UAs get 403 on this host). */
export const RESOLVER_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Quick-search endpoint URL for a Prague tram fleet number. */
export function buildQuickSearchUrl(reg: number): string {
  const params = new URLSearchParams({
    action: 'index-qsearch',
    cid: String(PRAGUE_CITY_ID),
    type: String(VEHICLE_TYPE_TRAM),
    num: String(Math.trunc(reg)),
    lang: 'en',
  });
  return `${TRANSPHOTO_BASE}/api.php?${params.toString()}`;
}

export interface TransphotoMatch {
  /** Site-relative vehicle path, e.g. "/vehicle/54427/#n563216". */
  path: string;
  /**
   * True when the result row's service years end in "— ..." — TransPhoto's
   * marker for a car still in service under this number. Renumbered or
   * withdrawn cars (and historic reuses of the same number) lack it.
   */
  inService: boolean;
}

/**
 * Parse the quick-search HTML fragment into vehicle matches. Each result is a
 * `<tbody …>` block containing `/vehicle/<id>/#n<entry>` links; one fleet
 * number can yield several blocks (renumbering history, historic reuse).
 */
export function parseQuickSearchMatches(html: string): TransphotoMatch[] {
  const matches: TransphotoMatch[] = [];
  const blocks = html.split(/<tbody/i).slice(1);
  for (const block of blocks) {
    const link = /(?:href|window\.open\(')\s*=?\s*"?(\/vehicle\/\d+\/[^"')]*)/i.exec(block);
    if (!link) continue;
    matches.push({
      path: link[1],
      inService: /—\s*(\.\.\.|…)/.test(block),
    });
  }
  return matches;
}

/**
 * Choose the best match: the first in-service row (current holder of the
 * number), else the first row at all (retired cars still have galleries).
 */
export function pickBestMatch(matches: TransphotoMatch[]): TransphotoMatch | null {
  if (matches.length === 0) return null;
  return matches.find((m) => m.inService) ?? matches[0];
}

/**
 * Absolute vehicle-page URL with `?lang=en`, keeping any `#n…` anchor after
 * the query (fragment must come last or the server drops the lang).
 */
export function buildVehiclePageUrl(path: string): string {
  const hashIndex = path.indexOf('#');
  const base = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : path.slice(hashIndex);
  const sep = base.includes('?') ? '&' : '?';
  return `${TRANSPHOTO_BASE}${base}${sep}lang=en${fragment}`;
}

export type ResolveResult =
  | { status: 'found'; url: string }
  | { status: 'not-found' }
  | { status: 'error' };

/**
 * Resolve a Prague tram registration number to its TransPhoto vehicle-page
 * URL. Network/HTTP failures → 'error' (retryable); an empty result set →
 * 'not-found' (no gallery for this number).
 */
export async function resolveVehiclePageUrl(
  reg: number,
  fetchFn: typeof fetch = fetch,
): Promise<ResolveResult> {
  try {
    const res = await fetchFn(buildQuickSearchUrl(reg), {
      headers: { 'User-Agent': RESOLVER_USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) return { status: 'error' };
    const best = pickBestMatch(parseQuickSearchMatches(await res.text()));
    if (!best) return { status: 'not-found' };
    return { status: 'found', url: buildVehiclePageUrl(best.path) };
  } catch {
    return { status: 'error' };
  }
}
