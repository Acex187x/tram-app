// Cold-start geometry pack: the seeding contract and — most importantly today —
// the silent-fallback contract, because the endpoint 404s until the predictor
// service ships it. Every failure mode must leave the app exactly as it is.

import {
  fetchGeometryPack,
  seedFromPack,
  warmFromGeometryPack,
  type GeometryPack,
} from "@/lib/golemio/geometryPack";
import * as shapeCache from "@/lib/golemio/shapeCache";
import type { ServedGeometry } from "@/lib/golemio/gtfs";

const SERVICE_MIDNIGHT = Date.UTC(2026, 7, 16, 0, 0, 0);

function servedShape(shapeId: string, tripId: string): ServedGeometry {
  return {
    tripId,
    shapeId,
    routeId: "L22",
    line: "22",
    headsign: "Bílá Hora",
    serviceMidnightMs: SERVICE_MIDNIGHT,
    coordinates: [
      [14.4, 50.08],
      [14.41, 50.08],
      [14.42, 50.08],
    ],
    cumDistM: [0, 715, 1430],
    totalM: 1430,
    stops: [
      {
        stopId: "U1Z1",
        name: "A",
        sequence: 1,
        coordinates: [14.4, 50.08],
        distM: 0,
        arrivalMs: SERVICE_MIDNIGHT + 36_000_000,
        departureMs: SERVICE_MIDNIGHT + 36_000_000,
        dwellSeconds: 0,
        isTerminal: false,
      },
      {
        stopId: "U2Z1",
        name: "B",
        sequence: 2,
        coordinates: [14.42, 50.08],
        distM: 1430,
        arrivalMs: SERVICE_MIDNIGHT + 36_120_000,
        departureMs: SERVICE_MIDNIGHT + 36_120_000,
        dwellSeconds: 0,
        isTerminal: true,
      },
    ],
    builtAtMs: SERVICE_MIDNIGHT + 36_000_000,
  };
}

const PACK: GeometryPack = {
  atMs: SERVICE_MIDNIGHT + 36_000_000,
  shapes: [servedShape("S1", "trip-a"), servedShape("S2", "trip-c")],
  // Two trips share S1 — exactly the dedup the pack is built around.
  trips: {
    "trip-a": "S1",
    "trip-b": "S1",
    "trip-c": "S2",
    "trip-missing": "S9",
  },
};

const realFetch = Object.getOwnPropertyDescriptor(global, "fetch");

afterEach(() => {
  shapeCache.clearMemoryCache();
  if (realFetch) Object.defineProperty(global, "fetch", realFetch);
  else delete (global as any).fetch;
});

describe("fetchGeometryPack — silent fallback", () => {
  it("returns null on 404 (endpoint not deployed yet)", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
    await expect(fetchGeometryPack("http://x/pack")).resolves.toBeNull();
  });

  it("returns null on a network throw", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await expect(fetchGeometryPack("http://x/pack")).resolves.toBeNull();
  });

  it("returns null on non-JSON / malformed bodies", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("not json")),
    }) as unknown as typeof fetch;
    await expect(fetchGeometryPack("http://x/pack")).resolves.toBeNull();

    for (const bad of [
      null,
      {},
      { shapes: [], trips: {} },
      { shapes: "no", trips: {} },
    ]) {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(bad),
      }) as unknown as typeof fetch;
      await expect(fetchGeometryPack("http://x/pack")).resolves.toBeNull();
    }
  });

  it("parses a well-formed pack", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(PACK),
    }) as unknown as typeof fetch;
    const pack = await fetchGeometryPack("http://x/pack");
    expect(pack?.shapes).toHaveLength(2);
    expect(pack?.trips["trip-b"]).toBe("S1");
  });
});

describe("seedFromPack", () => {
  it("keeps opposite axes sharing a provider ID separate through content references", () => {
    const first = {
      ...servedShape("reused", "trip-out"),
      geometryKey: "axis-out",
    };
    const second = {
      ...servedShape("reused", "trip-back"),
      geometryKey: "axis-back",
      coordinates: [...first.coordinates].reverse(),
      stops: [...first.stops]
        .reverse()
        .map((s, i) => ({ ...s, sequence: i + 1, distM: i * 1430 })),
    };
    expect(
      seedFromPack(
        {
          atMs: SERVICE_MIDNIGHT,
          shapes: [first, second],
          trips: { "trip-out": "axis-out", "trip-back": "axis-back" },
        },
        SERVICE_MIDNIGHT,
      ),
    ).toBe(2);
    expect(shapeCache.getLoaded("trip-out")?.coordinates[0]).toEqual(
      first.coordinates[0],
    );
    expect(shapeCache.getLoaded("trip-back")?.coordinates[0]).toEqual(
      second.coordinates[0],
    );
    expect(shapeCache.getLoaded("trip-back")?.shapeId).toBe("reused");
    expect(shapeCache.getLoaded("trip-back")?.provisional).toBe(true);
  });

  it("rejects a conflicting duplicate legacy key rather than choosing a random direction", () => {
    const first = servedShape("reused", "trip-out");
    const second = { ...first, coordinates: [...first.coordinates].reverse() };
    expect(
      seedFromPack(
        {
          atMs: SERVICE_MIDNIGHT,
          shapes: [first, second, first],
          trips: { "trip-out": "reused" },
        },
        SERVICE_MIDNIGHT,
      ),
    ).toBe(0);
    expect(shapeCache.getLoaded("trip-out")).toBeUndefined();
  });

  it("seeds every trip that maps to a known shape, including deduped siblings", () => {
    const seeded = seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
    expect(seeded).toBe(3); // a, b, c — 'trip-missing' has no shape S9
    expect(shapeCache.has("trip-a")).toBe(true);
    expect(shapeCache.has("trip-b")).toBe(true);
    expect(shapeCache.has("trip-c")).toBe(true);
    expect(shapeCache.has("trip-missing")).toBe(false);
  });

  it("re-labels the borrowed shape with the borrowing tripId", () => {
    seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
    // trip-b borrows S1, whose served entry names trip-a.
    expect(shapeCache.getLoaded("trip-b")?.tripId).toBe("trip-b");
    expect(shapeCache.getLoaded("trip-b")?.shapeId).toBe("S1");
  });

  it("marks seeds provisional so the per-trip fetch still refines them", () => {
    seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
    expect(shapeCache.isProvisional("trip-a")).toBe(true);
    expect(shapeCache.isProvisional("trip-b")).toBe(true);
  });

  it("never downgrades an already-resident geometry", () => {
    const authoritative = {
      ...shapeCache.getLoaded("trip-a"),
      shapeId: "REAL",
      tripId: "trip-a",
      coordinates: [
        [14.4, 50.08],
        [14.5, 50.08],
      ],
      cumDistM: [0, 7150],
      totalM: 7150,
      stops: [],
      routeId: "L22",
      line: "22",
      headsign: "real",
    } as unknown as Parameters<typeof shapeCache.seedProvisional>[1];
    shapeCache.seedProvisional("trip-a", authoritative);
    expect(shapeCache.getLoaded("trip-a")?.shapeId).toBe("REAL");
    // A later pack seed must not overwrite it.
    seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
    expect(shapeCache.getLoaded("trip-a")?.shapeId).toBe("REAL");
  });

  it("produces a usable polyline (position/bearing are correct immediately)", () => {
    seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
    const g = shapeCache.getLoaded("trip-b");
    expect(g?.coordinates.length).toBeGreaterThanOrEqual(2);
    expect(g?.totalM).toBeGreaterThan(0);
  });
});

describe("warmFromGeometryPack", () => {
  it("seeds nothing and reports 0 when the endpoint is absent", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
    await expect(
      warmFromGeometryPack(undefined, "http://x/pack"),
    ).resolves.toBe(0);
    expect(shapeCache.getAllLoaded()).toHaveLength(0);
  });

  it("seeds the fleet when the endpoint answers", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(PACK),
    }) as unknown as typeof fetch;
    await expect(
      warmFromGeometryPack(undefined, "http://x/pack"),
    ).resolves.toBe(3);
  });

  it("does nothing once its signal is aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(
      warmFromGeometryPack(ctl.signal, "http://x/pack"),
    ).resolves.toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("provisional visibility", () => {
  it("keeps provisional trips out of the schedule surfaces but in the raw list", () => {
    seedFromPack(PACK, SERVICE_MIDNIGHT + 36_000_000);
    expect(shapeCache.getAllLoaded()).toHaveLength(3); // route-network still draws them
    expect(shapeCache.getAllAuthoritative()).toHaveLength(0); // arrivals see nothing
  });
});

it("preferred seeds immediately and a public supplement cannot downgrade resident axes", async () => {
  const previous = process.env.EXPO_PUBLIC_GEOMETRY_PACK_URL;
  process.env.EXPO_PUBLIC_GEOMETRY_PACK_URL =
    "http://private/api/geometry-pack";
  let finishPublic!: (value: Response) => void;
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => PACK })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPublic = resolve;
        }),
    );
  try {
    const result = warmFromGeometryPack();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(shapeCache.getLoaded("trip-a")?.shapeId).toBe("S1");
    const supplement = {
      ...PACK,
      trips: { "trip-a": "S2", "extra-trip": "S2" },
    };
    finishPublic({ ok: true, json: async () => supplement } as Response);
    await expect(result).resolves.toBe(4);
    expect(shapeCache.getLoaded("trip-a")?.shapeId).toBe("S1");
    expect(shapeCache.getLoaded("extra-trip")?.shapeId).toBe("S2");
  } finally {
    if (previous === undefined)
      delete process.env.EXPO_PUBLIC_GEOMETRY_PACK_URL;
    else process.env.EXPO_PUBLIC_GEOMETRY_PACK_URL = previous;
  }
});
