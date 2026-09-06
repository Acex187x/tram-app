// GLB model loading. SPIKE-VERIFIED: require()'d asset URLs are broken in dev
// (native strips metro query params) — models MUST be resolved through
// Asset.downloadAsync() and passed to <Models> as file:// / local URIs, and
// <Models> may only render once ALL entries are resolved.

import { Asset } from 'expo-asset';
import { useEffect, useMemo, useState } from 'react';

import { MODEL_ASSETS, STOP_TOTEM_ASSET } from '@/lib/fleet/modelSpecs';
import { STOP_TOTEM_MODEL_KEY } from './RouteNetwork';
import { useSkinsStore, skinAssetUri } from '@/stores/skins';
import { skinModelKey } from '@/lib/skins/registry';

export interface TramModelResources { base: Record<string,string>; skins: {version:string;models:Record<string,string>}[]; all: Record<string,string>; }
/** Native Models registers only on mount. Base resources stay mounted; each
 * imported revision gets its own immutable IDs and component lifetime. */
export function useTramModels(): TramModelResources | null {
  const registry = useSkinsStore();
  const skins = registry.skins;
  const assignments = registry.assignments;
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

  return useMemo(() => {
    if (!uris) return null;
    const groups = skins.filter(s => Object.values(assignments).some(a => a.skinId === s.id))
      .map(s => ({version:s.directory, models:Object.fromEntries(s.mapKeys.map(key => [skinModelKey(s.directory,key),skinAssetUri(s,'map',key)]))}));
    return {base:uris,skins:groups,all:Object.assign({},uris,...groups.map(g=>g.models))};
  }, [uris,skins,assignments]);
}
