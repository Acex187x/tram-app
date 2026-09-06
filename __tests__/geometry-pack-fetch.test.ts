import { fetchGeometryPackSources } from "@/lib/golemio/geometryPackFetch";

const originalFetch = Object.getOwnPropertyDescriptor(global, "fetch");
const preferredUrl = "http://private/api/geometry-pack";
const publicUrl = "https://public/geometry-pack";
const privatePack = { shapes: ["private"] };
const publicPack = { shapes: ["public"] };
const parse = (x: unknown): { shapes: string[] } | null =>
  x && typeof x === "object" && Array.isArray((x as any).shapes)
    ? (x as typeof privatePack)
    : null;
const options = { preferredUrl, publicUrl, parse };
const response = (body: unknown) =>
  ({ ok: true, json: async () => body }) as Response;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  if (originalFetch) Object.defineProperty(global, "fetch", originalFetch);
  else delete (global as any).fetch;
  jest.useRealTimers();
});

it("accepts preferred success without requesting public or keeping deadline timers", async () => {
  global.fetch = jest.fn().mockResolvedValue(response(privatePack));
  await expect(fetchGeometryPackSources(options)).resolves.toEqual(privatePack);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it.each(["404", "malformed", "network"])(
  "falls back once on preferred %s",
  async (kind) => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(() =>
        kind === "network"
          ? Promise.reject(Error("offline"))
          : Promise.resolve(kind === "404" ? { ok: false } : response({})),
      )
      .mockResolvedValue(response(publicPack));
    await expect(fetchGeometryPackSources(options)).resolves.toEqual(
      publicPack,
    );
    expect((global.fetch as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      preferredUrl,
      publicUrl,
    ]);
  },
);

it.each(["network", "body"])(
  "bounds a preferred %s that ignores abort, discards late success",
  async (kind) => {
    let late!: (value: any) => void;
    const hung = new Promise((resolve) => {
      late = resolve;
    });
    let privateSignal!: AbortSignal;
    global.fetch = jest
      .fn()
      .mockImplementationOnce((_url, init) => {
        privateSignal = init.signal;
        return kind === "network"
          ? hung
          : Promise.resolve({ ok: true, json: () => hung });
      })
      .mockResolvedValue(response(publicPack));
    const result = fetchGeometryPackSources(options);
    await flush();
    jest.advanceTimersByTime(2999);
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(privateSignal.aborted).toBe(true);
    await expect(result).resolves.toEqual(publicPack);
    late(kind === "network" ? response(privatePack) : privatePack);
    await flush();
    await expect(result).resolves.toEqual(publicPack);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("cancels the whole attempt without fallback or parsing late private data", async () => {
  let late!: (value: Response) => void;
  global.fetch = jest.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        late = resolve;
      }),
  );
  const controller = new AbortController();
  const parser = jest.fn(parse);
  const result = fetchGeometryPackSources({
    ...options,
    signal: controller.signal,
    parse: parser,
  });
  await flush();
  controller.abort();
  await expect(result).resolves.toBeNull();
  late(response(privatePack));
  await flush();
  expect(parser).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("bounds the public fallback separately and permits an independent later session", async () => {
  global.fetch = jest
    .fn()
    .mockRejectedValueOnce(Error("private unavailable"))
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(response(privatePack));
  const result = fetchGeometryPackSources(options);
  await flush();
  jest.advanceTimersByTime(19999);
  await flush();
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(1);
  await expect(result).resolves.toBeNull();
  await expect(fetchGeometryPackSources(options)).resolves.toEqual(privatePack);
  expect(jest.getTimerCount()).toBe(0);
});

it("unconfigured or identical preferred URL keeps one ordinary public request", async () => {
  global.fetch = jest.fn().mockResolvedValue(response(publicPack));
  await fetchGeometryPackSources({ publicUrl, parse });
  await fetchGeometryPackSources({ publicUrl, preferredUrl: publicUrl, parse });
  expect((global.fetch as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
    publicUrl,
    publicUrl,
  ]);
});

it("pre-aborted session makes no request", async () => {
  global.fetch = jest.fn();
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchGeometryPackSources({ ...options, signal: controller.signal }),
  ).resolves.toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

it("delivers preferred immediately before a slow public supplement, preserving source order", async () => {
  let finishPublic!: (value: Response) => void;
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(response(privatePack))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPublic = resolve;
        }),
    );
  const accepted = jest.fn();
  const result = fetchGeometryPackSources({
    ...options,
    supplementPublic: true,
    onPack: accepted,
  });
  await flush();
  expect(accepted.mock.calls).toEqual([[privatePack, "preferred"]]);
  finishPublic(response(publicPack));
  await expect(result).resolves.toEqual(privatePack);
  expect(accepted.mock.calls).toEqual([
    [privatePack, "preferred"],
    [publicPack, "public"],
  ]);
});

it("cancelling while public supplement loads cannot deliver its late body", async () => {
  let late!: (value: Response) => void;
  const controller = new AbortController();
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(response(privatePack))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    );
  const accepted = jest.fn();
  const result = fetchGeometryPackSources({
    ...options,
    signal: controller.signal,
    supplementPublic: true,
    onPack: accepted,
  });
  await flush();
  controller.abort();
  await expect(result).resolves.toBeNull();
  late(response(publicPack));
  await flush();
  expect(accepted.mock.calls).toEqual([[privatePack, "preferred"]]);
});
