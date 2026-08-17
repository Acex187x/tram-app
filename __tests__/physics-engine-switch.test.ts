/// <reference types="jest" />
//
// The physics-engine switcher: one setting that changes WHICH server-side
// predictor built the bundle the client draws.
//
// The wire format is identical across generations (physics-v3-protocol §Wire),
// so nothing in the parser, the evaluator or the renderers is generation-aware
// — the entire feature is a query parameter plus an honest swap. That makes the
// contract small and worth pinning exactly:
//
//   1. persistence — the setting survives a restart, defaults to the shipped
//      engine, and can never rehydrate into a generation this build cannot ask
//      for (including from installs persisted before the setting existed);
//   2. URL construction — 'current' is the server DEFAULT and must go out as a
//      bare request, so the app keeps working against a server that has never
//      heard of `gen`;
//   3. the swap — changing it refetches IMMEDIATELY, drops the previous
//      engine's bundle rather than animating it, cannot be corrupted by a reply
//      from the engine just left, and leaves the connection machine telling the
//      truth ('degraded' = connecting, never a false 'offline' banner).

import { parseBundle } from '@/lib/physics/bundle';
import { connectionState } from '@/lib/physics/connection';
import {
  TRAJECTORIES_URL,
  TrajectoryStore,
  genFromGenerator,
  trajectoriesUrl,
  type PhysicsGen,
} from '@/lib/physics/trajectoryStore';
import { T0, wireBundle, wireVehicle } from './physicsFixtures';

// Persistence adapter: in-memory, so the real settings store (with its real
// persist middleware and migration) can be exercised without expo-file-system.
jest.mock('@/stores/favorites', () => {
  const blobs = new Map<string, string>();
  return {
    fileSystemStorage: {
      getItem: (name: string) => blobs.get(name) ?? null,
      setItem: (name: string, value: string) => {
        blobs.set(name, value);
      },
      removeItem: (name: string) => {
        blobs.delete(name);
      },
    },
  };
});

import { fileSystemStorage } from '@/stores/favorites';
import {
  normalizePhysicsEngine,
  useSettingsStore,
  type PhysicsEngine,
} from '@/stores/settings';

/** Let zustand's persist write/read settle (its storage calls are thenable). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const persisted = () => JSON.parse(String(fileSystemStorage.getItem('settings')));

// ── 1. the setting ───────────────────────────────────────────────────────────

describe('physicsEngine setting', () => {
  beforeEach(() => {
    useSettingsStore.setState({ physicsEngine: 'current' });
  });

  it('defaults to the shipped engine', () => {
    expect(useSettingsStore.getInitialState().physicsEngine).toBe('current');
  });

  it('normalizes every value a build can be handed', () => {
    expect(normalizePhysicsEngine('current')).toBe('current');
    expect(normalizePhysicsEngine('v3')).toBe('v3');
    expect(normalizePhysicsEngine('mix')).toBe('mix');
    // Anything else is a generation this build cannot request — including the
    // shape an install from a FUTURE build would leave behind after a rollback.
    expect(normalizePhysicsEngine('v4')).toBe('current');
    expect(normalizePhysicsEngine(undefined)).toBe('current');
    expect(normalizePhysicsEngine(null)).toBe('current');
    expect(normalizePhysicsEngine(7)).toBe('current');
    expect(normalizePhysicsEngine({ gen: 'v3' })).toBe('current');
  });

  it('coerces an unknown value at the setter, so the store never holds one', () => {
    useSettingsStore.getState().setPhysicsEngine('v4' as PhysicsEngine);
    expect(useSettingsStore.getState().physicsEngine).toBe('current');
  });

  it('persists the selection and restores it on the next launch', async () => {
    useSettingsStore.getState().setPhysicsEngine('v3');
    await settle();
    const blob = String(fileSystemStorage.getItem('settings'));
    expect(JSON.parse(blob).state.physicsEngine).toBe('v3');

    // Simulate a relaunch: live state back to its initial value, then rehydrate
    // from the blob on disk. The reset must be written back, because persist
    // saves on EVERY state change — including this one, which would otherwise
    // erase the very blob the relaunch is supposed to read.
    useSettingsStore.setState({ physicsEngine: 'current' });
    fileSystemStorage.setItem('settings', blob);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().physicsEngine).toBe('v3');
  });

  it('round-trips every generation', async () => {
    for (const gen of ['v3', 'mix', 'current'] as const) {
      useSettingsStore.getState().setPhysicsEngine(gen);
      await settle();
      expect(persisted().state.physicsEngine).toBe(gen);
    }
  });

  it('rehydrates an install persisted before the setting existed as the default', async () => {
    // At a real launch the live state is the initial state; nothing in the blob
    // can supply physicsEngine, so the default has to win. Seed AFTER the reset
    // — a setState of its own re-persists and would replace the blob.
    useSettingsStore.setState({ physicsEngine: 'v3' });
    useSettingsStore.setState({ physicsEngine: 'current' });
    fileSystemStorage.setItem(
      'settings',
      JSON.stringify({ state: { positionMode: 'smooth', showRouteLines: true }, version: 2 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().physicsEngine).toBe('current');

    // Rehydrating does NOT rewrite the blob — an upgraded install keeps a
    // field-less settings file and re-derives the default at every launch until
    // the user picks something, at which point it lands on disk for good.
    useSettingsStore.getState().setPhysicsEngine('mix');
    await settle();
    expect(persisted().state.physicsEngine).toBe('mix');
  });

  it('migrates a pre-v2 install to a requestable generation', async () => {
    fileSystemStorage.setItem(
      'settings',
      JSON.stringify({ state: { positionMode: 'ml', physicsEngine: 'ludicrous' }, version: 1 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().physicsEngine).toBe('current');
    expect(useSettingsStore.getState().positionMode).toBe('smooth');
  });
});

// ── 2. URL construction ──────────────────────────────────────────────────────

describe('trajectoriesUrl', () => {
  it('sends the default generation as a BARE request', () => {
    // Not `?gen=current`: the parameter is an addition to a published endpoint,
    // and a client on the default must be indistinguishable from one built
    // before the switcher existed.
    expect(trajectoriesUrl('current')).toBe(TRAJECTORIES_URL);
    expect(trajectoriesUrl('current')).not.toContain('?');
  });

  it('names the generation for everything else', () => {
    expect(trajectoriesUrl('v3')).toBe(`${TRAJECTORIES_URL}?gen=v3`);
    expect(trajectoriesUrl('mix')).toBe(`${TRAJECTORIES_URL}?gen=mix`);
  });

  it('applies to any base endpoint', () => {
    const base = 'https://example.invalid/api/trajectories/v2';
    expect(trajectoriesUrl('current', base)).toBe(base);
    expect(trajectoriesUrl('v3', base)).toBe(`${base}?gen=v3`);
  });

  it('accepts exactly the generations the setting can hold', () => {
    // The two unions are mirrors (settings.ts ↔ trajectoryStore.ts); this fails
    // to compile the day one of them grows a member the other lacks.
    const fromSetting: PhysicsGen = 'mix' satisfies PhysicsEngine;
    const fromStore: PhysicsEngine = 'v3' satisfies PhysicsGen;
    expect([fromSetting, fromStore]).toEqual(['mix', 'v3']);
  });
});

// ── 3. confirming the generation from the DATA ───────────────────────────────

describe('genFromGenerator', () => {
  it('maps the server’s own names onto the client’s generations', () => {
    expect(genFromGenerator('drive-v3')).toBe('v3');
    expect(genFromGenerator('mix')).toBe('mix');
  });

  it('reads an absent generator as the published chain', () => {
    expect(genFromGenerator(null)).toBe('current');
  });

  it('reads an unrecognised generator as published, because that is what it is', () => {
    // Asking for a `gen` the server does not know is deliberately served the
    // published bundle rather than an error, so an unfamiliar name must resolve
    // to something honest instead of being echoed back as if it had been served.
    expect(genFromGenerator('drive-v4')).toBe('current');
    expect(genFromGenerator('')).toBe('current');
  });
});

describe('parseBundle generator field', () => {
  it('keeps what the server called itself', () => {
    const parsed = parseBundle({ ...wireBundle(), generator: 'drive-v3' }, T0);
    expect(parsed?.generator).toBe('drive-v3');
  });

  it('is null when absent — the published bundle does not name itself', () => {
    expect(parseBundle(wireBundle(), T0)?.generator).toBeNull();
  });

  it('ignores a non-string generator rather than trusting it', () => {
    expect(parseBundle({ ...wireBundle(), generator: 3 }, T0)?.generator).toBeNull();
    expect(parseBundle({ ...wireBundle(), generator: '' }, T0)?.generator).toBeNull();
  });
});

// ── 4. the swap ──────────────────────────────────────────────────────────────

describe('TrajectoryStore generation swap', () => {
  const base = 'https://example.invalid/api/trajectories/v2';
  let fetchMock: jest.Mock;

  /** URLs requested so far, in order. */
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => wireBundle({ serverNowMs: Date.now() }),
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches the bare endpoint on the default generation', async () => {
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([base]);
    expect(s.health(Date.now()).gen).toBe('current');
    s.stop();
  });

  it('refetches IMMEDIATELY on a change — not at the next poll tick', async () => {
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 1 s in: far from the 5 s tick, so a second call can only be the swap's.
    await jest.advanceTimersByTimeAsync(1_000);
    s.setGen('v3');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls()[1]).toBe(`${base}?gen=v3`);
    s.stop();
  });

  it('keeps polling the new generation afterwards', async () => {
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    s.setGen('mix');
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(urls().slice(1)).toEqual([
      `${base}?gen=mix`,
      `${base}?gen=mix`,
      `${base}?gen=mix`,
    ]);
    s.stop();
  });

  it('returns to a bare request when switched back to the default', async () => {
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    s.setGen('v3');
    await jest.advanceTimersByTimeAsync(0);
    s.setGen('current');
    await jest.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([base, `${base}?gen=v3`, base]);
    expect(s.health(Date.now()).gen).toBe('current');
    s.stop();
  });

  it('is a no-op when the generation did not actually change', async () => {
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    const bundle = s.bundle;
    s.setGen('current');
    s.setGen('current');
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The runtime calls this on EVERY settings write; an unrelated toggle must
    // not throw the fleet's curves away.
    expect(s.bundle).toBe(bundle);
    s.stop();
  });

  it('drops the previous engine’s bundle instead of animating it', async () => {
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(s.bundle).not.toBeNull();

    s.setGen('v3');
    // Synchronously after the swap, before anything new can have landed: the
    // old curves are gone, so every tram falls back to its raw AVL fix rather
    // than gliding along a physics the user just left.
    expect(s.bundle).toBeNull();
    expect(s.bundleAgeS(Date.now())).toBeNull();
    expect(s.health(Date.now()).vehicleCount).toBe(0);
    s.stop();
  });

  it('reports ‘degraded’ during the swap, never a false ‘offline’', async () => {
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(s.connection(Date.now())).toBe('live');

    s.setGen('v3');
    const health = s.health(Date.now());
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError).toBeNull();
    // Same verdict the machine gives a cold start — because that is what this
    // is. Nothing failed; there is simply no bundle yet.
    expect(health.connection).toBe('degraded');
    expect(connectionState({ bundleAgeS: null, consecutiveFailures: 0 })).toBe('degraded');

    await jest.advanceTimersByTimeAsync(0);
    expect(s.connection(Date.now())).toBe('live');
    s.stop();
  });

  it('notifies subscribers on the swap so the UI re-derives at once', async () => {
    const s = new TrajectoryStore(base);
    const seen: (number | null)[] = [];
    s.subscribe(() => seen.push(s.bundle?.vehicles.size ?? null));
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    s.setGen('v3');
    await jest.advanceTimersByTimeAsync(0);
    // bundle in · dropped by the swap · new generation in.
    expect(seen).toEqual([1, null, 1]);
    s.stop();
  });

  it('cannot be corrupted by a reply from the generation just left', async () => {
    let releaseOld!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
    );
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);

    s.setGen('v3');
    await jest.advanceTimersByTimeAsync(0);
    const afterSwap = s.bundle;
    expect(afterSwap).not.toBeNull(); // the v3 request already answered

    // The old engine's reply lands late. It must not overwrite v3's curves.
    releaseOld({
      ok: true,
      json: async () => wireBundle({ vehicles: [wireVehicle({ key: 'stale-gen' })] }),
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(s.bundle).toBe(afterSwap);
    expect(s.getVehicle('stale-gen')).toBeUndefined();
    s.stop();
  });

  it('does not start polling when swapped while stopped (perf invariant #3)', async () => {
    const s = new TrajectoryStore(base);
    s.setGen('v3');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.health(Date.now()).pollIntervalMs).toBe(0);

    // …and the generation chosen while stopped is the one start() asks for.
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([`${base}?gen=v3`]);
    s.stop();
  });

  it('re-seeds the clock from the new generation instead of averaging across the swap', async () => {
    const s = new TrajectoryStore(base);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => wireBundle({ serverNowMs: Date.now() + 4_000 }),
    });
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(s.clock.offsetMs).toBeCloseTo(4_000, -1);

    // Each generation's bundle cache freezes independently, so their
    // serverNowMs stamps can sit ~2 s apart. The offset is an EWMA over the
    // last three fetches: blending the two would give a clock matching neither.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => wireBundle({ serverNowMs: Date.now() + 2_000 }),
    });
    s.setGen('mix');
    expect(s.clock.synced).toBe(false); // dropped, and nothing to evaluate yet

    await jest.advanceTimersByTimeAsync(0);
    // Exactly the new generation's offset — not the 2 s–4 s average an
    // un-reset window would have produced for the next three polls.
    expect(s.clock.offsetMs).toBeCloseTo(2_000, -1);
    s.stop();
  });

  it('reports the generation the BUNDLE names, not the one requested', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...wireBundle({ serverNowMs: Date.now() }), generator: 'drive-v3' }),
    });
    const s = new TrajectoryStore(base);
    s.setGen('v3');
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    const health = s.health(Date.now());
    expect(health.serverGen).toBe('drive-v3');
    expect(genFromGenerator(health.serverGen)).toBe(health.gen); // asked, and got
    s.stop();
  });

  it('makes a silent fallback to the published bundle detectable', async () => {
    // The server answers an unknown generation with the published bundle on
    // purpose. Nothing fails, nothing 404s — the ONLY evidence is that the
    // bundle does not name itself while v3 was asked for.
    const s = new TrajectoryStore(base);
    s.setGen('v3');
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    const health = s.health(Date.now());
    expect(health.gen).toBe('v3');
    expect(health.serverGen).toBeNull();
    expect(genFromGenerator(health.serverGen)).not.toBe(health.gen);
    s.stop();
  });

  it('has no generation to report before the first bundle of a swap lands', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...wireBundle({ serverNowMs: Date.now() }), generator: 'mix' }),
    });
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);

    s.setGen('mix');
    // Dropping the bundle drops the claim with it — better than reporting the
    // generation of curves that are no longer on screen.
    expect(s.health(Date.now()).serverGen).toBeNull();
    await jest.advanceTimersByTimeAsync(0);
    expect(s.health(Date.now()).serverGen).toBe('mix');
    s.stop();
  });

  it('restarts the discontinuity count with the new engine', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...wireBundle({ vehicles: [wireVehicle({ discontinuity: true, emittedAtMs: T0 })] }),
        serverNowMs: Date.now(),
      }),
    });
    const s = new TrajectoryStore(base);
    s.start(5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(s.health(Date.now()).discontinuities).toBe(1);

    // The counter answers "how jumpy is THIS engine" — carrying the previous
    // one's total across the swap would make the comparison unreadable.
    s.setGen('v3');
    expect(s.health(Date.now()).discontinuities).toBe(0);
    s.stop();
  });
});
