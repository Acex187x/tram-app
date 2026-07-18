// TransPhoto URL-builder + quick-search parser. Fixtures are trimmed real
// responses from /api.php?action=index-qsearch&cid=82&type=1 (July 2026).
import {
  buildQuickSearchUrl,
  buildVehiclePageUrl,
  parseQuickSearchMatches,
  pickBestMatch,
  PRAGUE_CITY_URL,
} from '@/lib/photos/transphoto';

// Car #9435 (Škoda 15T7) — single in-service match.
const SINGLE_ACTIVE = `<table>
<tbody class="s11" style="border:solid 2px #fff; cursor:pointer" onclick="window.open('/vehicle/469967/#n585465')" onmouseover="this.focus(); this.className='s1'" onmouseout="this.className='s11'">
<tr>
<td style="padding:10px"><a href="/vehicle/469967/#n585465" target="_blank" onclick="return false" class="num pcnt">9435</a></td>
<td class="nw" style="padding:10px">Škoda 15T7 ForCity Alfa Praha</td>
<td style="padding:10px" class="d nw"><div class="sm" style="margin-bottom:3px">Žižkov depot</div><div class="nw">2018 — ...</div></td>
</tr>
</tbody>
</table>`;

// Car #8415 (T3R.P) — renumbering history: three rows for the same physical
// car; only the FIRST is the current in-service record ("2016 — ...").
const MULTI_HISTORY = `<table>
<tbody class="s11" onclick="window.open('/vehicle/54427/#n563216')">
<tr><td><a href="/vehicle/54427/#n563216" class="num pcnt">8415</a></td>
<td class="nw">Vozy T3</td>
<td class="d nw"><div class="nw">2016 — ...</div></td></tr>
</tbody>
<tbody class="s19" onclick="window.open('/vehicle/54427/#n563215')">
<tr><td><a href="/vehicle/54427/#n563215" class="num pcnt">8415</a></td>
<td class="nw">Vozy T3</td>
<td class="d nw"><div class="nw">2016</div></td></tr>
</tbody>
<tbody class="s19" onclick="window.open('/vehicle/54427/#n146112')">
<tr><td><a href="/vehicle/54427/#n146112" class="num pcnt">8415</a></td>
<td class="nw">Vozy T3</td>
<td class="d nw"><div class="nw">2004 — 2016</div></td></tr>
</tbody>
</table>`;

// Retired-only match (loaned prototype): no "— ..." anywhere.
const RETIRED_ONLY = `<table>
<tbody class="s19" onclick="window.open('/vehicle/79756/#n77331')">
<tr><td><a href="/vehicle/79756/#n77331" class="num pcnt">9200</a></td>
<td class="nw">Škoda 15T0 ForCity Alfa Praha</td>
<td class="d nw"><div class="nw">2009</div></td></tr>
</tbody>
</table>`;

describe('buildQuickSearchUrl', () => {
  it('targets the public index-qsearch endpoint for Prague trams', () => {
    const url = buildQuickSearchUrl(9435);
    expect(url).toBe(
      'https://transphoto.org/api.php?action=index-qsearch&cid=82&type=1&num=9435&lang=en',
    );
  });

  it('truncates non-integer numbers', () => {
    expect(buildQuickSearchUrl(8415.0)).toContain('num=8415');
  });
});

describe('parseQuickSearchMatches', () => {
  it('parses a single in-service match', () => {
    expect(parseQuickSearchMatches(SINGLE_ACTIVE)).toEqual([
      { path: '/vehicle/469967/#n585465', inService: true },
    ]);
  });

  it('parses all renumbering-history rows with in-service flags', () => {
    expect(parseQuickSearchMatches(MULTI_HISTORY)).toEqual([
      { path: '/vehicle/54427/#n563216', inService: true },
      { path: '/vehicle/54427/#n563215', inService: false },
      { path: '/vehicle/54427/#n146112', inService: false },
    ]);
  });

  it('returns [] for an empty result fragment', () => {
    expect(parseQuickSearchMatches('<table>\n</table>')).toEqual([]);
    expect(parseQuickSearchMatches('')).toEqual([]);
  });
});

describe('pickBestMatch', () => {
  it('prefers the in-service row', () => {
    const matches = [
      { path: '/vehicle/1/#a', inService: false },
      { path: '/vehicle/2/#b', inService: true },
    ];
    expect(pickBestMatch(matches)?.path).toBe('/vehicle/2/#b');
  });

  it('falls back to the first row when nothing is in service', () => {
    expect(pickBestMatch(parseQuickSearchMatches(RETIRED_ONLY))?.path).toBe(
      '/vehicle/79756/#n77331',
    );
  });

  it('returns null for no matches', () => {
    expect(pickBestMatch([])).toBeNull();
  });
});

describe('buildVehiclePageUrl', () => {
  it('inserts ?lang=en before the #n anchor', () => {
    expect(buildVehiclePageUrl('/vehicle/54427/#n563216')).toBe(
      'https://transphoto.org/vehicle/54427/?lang=en#n563216',
    );
  });

  it('handles anchor-less paths', () => {
    expect(buildVehiclePageUrl('/vehicle/54427/')).toBe(
      'https://transphoto.org/vehicle/54427/?lang=en',
    );
  });
});

describe('constants', () => {
  it('city fallback URL points at Prague', () => {
    expect(PRAGUE_CITY_URL).toBe('https://transphoto.org/city/82/?lang=en');
  });
});
