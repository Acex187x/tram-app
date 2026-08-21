/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as calibration_bundle from "../calibration/bundle.js";
import type * as calibration_fold from "../calibration/fold.js";
import type * as calibration_keys from "../calibration/keys.js";
import type * as calibration_models from "../calibration/models.js";
import type * as crons from "../crons.js";
import type * as geometry from "../geometry.js";
import type * as geometryPack from "../geometryPack.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as poller from "../poller.js";
import type * as stream from "../stream.js";
import type * as trajectories from "../trajectories.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "calibration/bundle": typeof calibration_bundle;
  "calibration/fold": typeof calibration_fold;
  "calibration/keys": typeof calibration_keys;
  "calibration/models": typeof calibration_models;
  crons: typeof crons;
  geometry: typeof geometry;
  geometryPack: typeof geometryPack;
  http: typeof http;
  ingest: typeof ingest;
  poller: typeof poller;
  stream: typeof stream;
  trajectories: typeof trajectories;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
