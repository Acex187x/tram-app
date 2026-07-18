/// <reference types="jest" />

// Icon-pack system contract:
//  1. registry completeness — every pack id in ICON_PACK_IDS exists in
//     ICON_PACKS with meta, all 7 model face components and all 7 sprite
//     entries;
//  2. every pack's baked sprite PNGs exist on disk and are non-empty
//     (assets/images/faces/<packId>/<modelId>.png);
//  3. TramFace honors the `pack` prop, falls back to the settings-store
//     selection when omitted, and survives unknown model ids.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TramFace } from '@/components/tram/TramFace';
import {
  DEFAULT_ICON_PACK,
  getFace,
  ICON_PACKS,
  ICON_PACK_IDS,
} from '@/lib/fleet/iconPacks';
import type { TramModelId } from '@/lib/types';

// TramFace reads the selected pack from the settings store; mock it so the
// test controls the selection without touching persistence (expo-file-system).
jest.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: { iconPack: string }) => unknown) =>
    selector({ iconPack: 'chibi' }),
}));

const FACES_DIR = join(__dirname, '../assets/images/faces');
const ALL_MODEL_IDS: TramModelId[] = ['t3', 't3rp', 't3rplf', 'kt8d5', '14t', '15t', '52t'];

function renderJson(element: React.ReactElement): string {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  const json = JSON.stringify(renderer!.toJSON());
  act(() => renderer!.unmount());
  return json;
}

describe('ICON_PACKS registry', () => {
  it('lists classic first and defaults to it', () => {
    expect(ICON_PACK_IDS[0]).toBe('classic');
    expect(DEFAULT_ICON_PACK).toBe('classic');
  });

  it('has an entry with matching meta for every pack id, and no extras', () => {
    expect(Object.keys(ICON_PACKS).sort()).toEqual([...ICON_PACK_IDS].sort());
    for (const packId of ICON_PACK_IDS) {
      const pack = ICON_PACKS[packId];
      expect(pack.meta.id).toBe(packId);
      expect(pack.meta.name.length).toBeGreaterThan(0);
      expect(pack.meta.description.length).toBeGreaterThan(0);
    }
  });

  it.each(ICON_PACK_IDS)('%s: has all 7 model face components', (packId) => {
    expect(Object.keys(ICON_PACKS[packId].faces).sort()).toEqual([...ALL_MODEL_IDS].sort());
    for (const modelId of ALL_MODEL_IDS) {
      expect(typeof ICON_PACKS[packId].faces[modelId]).toBe('function');
    }
  });

  it.each(ICON_PACK_IDS)('%s: has all 7 sprite entries', (packId) => {
    expect(Object.keys(ICON_PACKS[packId].sprites).sort()).toEqual([...ALL_MODEL_IDS].sort());
  });

  it.each(ICON_PACK_IDS)('%s: all 7 sprite PNGs exist non-empty on disk', (packId) => {
    for (const modelId of ALL_MODEL_IDS) {
      const file = join(FACES_DIR, packId, `${modelId}.png`);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(200);
    }
  });

  it('face art is DISTINCT between packs for the same model', () => {
    const renders = ICON_PACK_IDS.map((packId) =>
      renderJson(createElement(ICON_PACKS[packId].faces['15t'], { size: 48 })),
    );
    expect(new Set(renders).size).toBe(ICON_PACK_IDS.length);
  });

  it('getFace falls back to the default pack / classic t3', () => {
    expect(getFace('nope' as never, '15t')).toBe(ICON_PACKS.classic.faces['15t']);
    expect(getFace('side', 'nope' as never)).toBe(ICON_PACKS.classic.faces.t3);
  });
});

describe('TramFace pack selection', () => {
  it('renders the requested pack when `pack` is passed', () => {
    for (const packId of ICON_PACK_IDS) {
      expect(renderJson(createElement(TramFace, { modelId: '52t', size: 48, pack: packId }))).toBe(
        renderJson(createElement(ICON_PACKS[packId].faces['52t'], { size: 48 })),
      );
    }
  });

  it('falls back to the settings-store pack when `pack` is omitted', () => {
    // The mocked settings store selects 'chibi'.
    expect(renderJson(createElement(TramFace, { modelId: 't3', size: 40 }))).toBe(
      renderJson(createElement(ICON_PACKS.chibi.faces.t3, { size: 40 })),
    );
  });

  it('unknown model id falls back to the classic T3', () => {
    expect(
      renderJson(createElement(TramFace, { modelId: 'kt3000' as never, size: 40, pack: 'classic' })),
    ).toBe(renderJson(createElement(ICON_PACKS.classic.faces.t3, { size: 40 })));
  });
});
