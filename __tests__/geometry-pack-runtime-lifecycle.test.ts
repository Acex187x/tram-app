import { TramRuntime } from "@/hooks/tramData";
import { warmFromGeometryPack } from "@/lib/golemio/geometryPack";

jest.mock("@/lib/physics/convexSource", () => ({
  ConvexTrajectorySource: class {
    start() {}
    stop() {}
  },
}));
jest.mock("@/lib/golemio/geometryPack", () => ({
  warmFromGeometryPack: jest.fn(),
}));
const warm = warmFromGeometryPack as jest.Mock;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const runtimes: TramRuntime[] = [];
function runtime() {
  const rt = new TramRuntime();
  runtimes.push(rt);
  const p = rt as any;
  p.refCount = 1;
  return { rt, p };
}
beforeEach(() => {
  jest.useFakeTimers();
  warm.mockReset();
});
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.release();
  jest.useRealTimers();
});

it("background aborts, resume retries, and late prior completion cannot clear the new session", async () => {
  const pending: Array<(n: number) => void> = [];
  warm.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const { p } = runtime();
  p.resume();
  const first = warm.mock.calls[0][0] as AbortSignal;
  p.onAppState("background");
  expect(first.aborted).toBe(true);
  p.onAppState("active");
  const second = warm.mock.calls[1][0] as AbortSignal;
  const version = p.uiVersion;
  pending[0](12);
  await flush();
  expect(second.aborted).toBe(false);
  expect(p.packController.signal).toBe(second);
  expect(p.uiVersion).toBe(version);
  p.onAppState("background");
  expect(second.aborted).toBe(true);
  pending[1](0);
  await flush();
  expect(jest.getTimerCount()).toBe(0);
});

it("a completed unsuccessful attempt remains one-shot across foreground resumes", async () => {
  warm.mockResolvedValue(0);
  const { p } = runtime();
  p.resume();
  await flush();
  p.onAppState("background");
  p.onAppState("active");
  await flush();
  expect(warm).toHaveBeenCalledTimes(1);
});
