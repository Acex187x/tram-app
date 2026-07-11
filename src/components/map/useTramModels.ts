// GLB model loading. SPIKE-VERIFIED: require()'d asset URLs are broken in dev
// (native strips metro query params) — models MUST be resolved through
// Asset.downloadAsync() and passed to <Models> as file:// / local URIs, and
// <Models> may only render once ALL entries are resolved.

import { Asset } from 'expo-asset';
import { useEffect, useState } from 'react';

import { MODEL_ASSETS } from '@/lib/fleet/modelSpecs';

/** modelKey → local URI for <Models>, or null while any GLB is still loading. */
export function useTramModels(): Record<string, string> | null {
  const [uris, setUris] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Falsy ids only occur under jest (see modelSpecs.glbAsset); skip them.
      const entries = Object.entries(MODEL_ASSETS).filter(([, moduleId]) => !!moduleId);
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
