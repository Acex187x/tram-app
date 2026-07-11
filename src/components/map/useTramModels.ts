// GLB model loading. SPIKE-VERIFIED: require()'d asset URLs are broken in dev
// (native strips metro query params) — models MUST be resolved through
// Asset.downloadAsync() and passed to <Models> as file:// / local URIs, and
// <Models> may only render once ALL entries are resolved.

import { Asset } from 'expo-asset';
import { useEffect, useState } from 'react';

import { MODEL_ASSETS, STOP_TOTEM_ASSET } from '@/lib/fleet/modelSpecs';
import { STOP_TOTEM_MODEL_KEY } from './RouteNetwork';

/** modelKey → local URI for <Models>, or null while any GLB is still loading. */
export function useTramModels(): Record<string, string> | null {
  const [uris, setUris] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Tram GLBs + the stop totem (kept out of MODEL_ASSETS — it's not a
      // tram). Falsy ids occur under jest or when an asset is missing (see
      // modelSpecs.glbAsset); skip them — consumers detect the absent key.
      const entries = Object.entries({
        ...MODEL_ASSETS,
        [STOP_TOTEM_MODEL_KEY]: STOP_TOTEM_ASSET,
      }).filter(([, moduleId]) => !!moduleId);
      const pairs = await Promise.all(
        entries.map(async ([key, moduleId]) => {
          const asset = Asset.fromModule(moduleId);
          await asset.downloadAsync();
          return [key, asset.localUri ?? asset.uri] as const;
        }),
      );
      if (!cancelled) setUris(Object.fromEntries(pairs));
    })().catch((e) => {
      console.warn('[map] tram GLB load failed — 3D layer disabled', e);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return uris;
}
