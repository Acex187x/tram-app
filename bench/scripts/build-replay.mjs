/** Research bundler: optional smooth-shim ablation never edits application source. */
import fs from "node:fs";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
const noShim = process.argv.includes("--no-smooth-shim");
const baselineRef = process.argv
  .find((v) => v.startsWith("--baseline-ref="))
  ?.slice(15);
if (baselineRef && !/^[0-9a-f]{7,40}$/.test(baselineRef))
  throw Error("Use an exact baseline commit hash");
const outfile =
  process.argv.find((v) => v.startsWith("--out="))?.slice(6) ??
  "/tmp/tram-replay.cjs";
await build({
  entryPoints: ["bench/src/replay-wire.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: "lab/tsconfig.runtime.json",
  outfile,
  external: ["react-native", "expo-constants"],
  banner: noShim
    ? { js: "process.env.RESEARCH_NO_SMOOTH_SHIM='1';" }
    : undefined,
  plugins: baselineRef
    ? [
        {
          name: "recorded-client-baseline",
          setup(b) {
            b.onLoad(
              {
                filter: /src\/lib\/physics\/(fleet|adapter|bundle|render)\.ts$/,
              },
              (args) => ({
                contents: execFileSync(
                  "git",
                  [
                    "show",
                    `${baselineRef}:${args.path.slice(process.cwd().length + 1)}`,
                  ],
                  { encoding: "utf8" },
                ),
                loader: "ts",
              }),
            );
          },
        },
      ]
    : noShim
      ? [
          {
            name: "research-no-smooth-shim",
            setup(b) {
              b.onLoad(
                { filter: /src\/lib\/physics\/render\.ts$/ },
                async (args) => {
                  const source = await fs.promises.readFile(args.path, "utf8");
                  const needle =
                    "const tau = fixForwardTauMs(track, fixS, fixAtMs, anchorMs);";
                  if (source.split(needle).length !== 2)
                    throw Error(
                      "Research ablation patch no longer uniquely matches",
                    );
                  return {
                    contents: source.replace(
                      needle,
                      "if (Number.isFinite(catchupVMs)) return curveWithCoast(track, tMs, endMs);\n  " +
                        needle,
                    ),
                    loader: "ts",
                  };
                },
              );
            },
          },
        ]
      : [],
});
console.error(
  JSON.stringify({ outfile, researchNoSmoothShim: noShim, baselineRef }),
);
