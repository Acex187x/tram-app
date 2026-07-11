// Favorites store: favorited tram registration numbers + line short names.
// Persisted to the document directory via expo-file-system so favorites survive
// reinstalls of the JS bundle and app restarts.

import { create } from 'zustand';
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from 'zustand/middleware';
import { Directory, File, Paths } from 'expo-file-system';

const STORES_DIR = 'stores';

function storesDir(): Directory {
  return new Directory(Paths.document, STORES_DIR);
}

function ensureDir(): void {
  const dir = storesDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

/** Synchronous file-backed storage adapter for zustand/persist. */
export const fileSystemStorage: StateStorage = {
  getItem: (name) => {
    try {
      const file = new File(storesDir(), `${name}.json`);
      return file.exists ? file.textSync() : null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      ensureDir();
      new File(storesDir(), `${name}.json`).write(value);
    } catch {
      // best-effort persistence
    }
  },
  removeItem: (name) => {
    try {
      const file = new File(storesDir(), `${name}.json`);
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
  },
};

export interface FavoritesState {
  /** Registration numbers as strings. */
  favoriteTrams: string[];
  /** Line short names, e.g. '9', '22'. */
  favoriteLines: string[];
  toggleTram: (reg: string) => void;
  toggleLine: (line: string) => void;
  hasTram: (reg: string) => boolean;
  hasLine: (line: string) => boolean;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favoriteTrams: [],
      favoriteLines: [],
      toggleTram: (reg) =>
        set((state) => ({
          favoriteTrams: state.favoriteTrams.includes(reg)
            ? state.favoriteTrams.filter((r) => r !== reg)
            : [...state.favoriteTrams, reg],
        })),
      toggleLine: (line) =>
        set((state) => ({
          favoriteLines: state.favoriteLines.includes(line)
            ? state.favoriteLines.filter((l) => l !== line)
            : [...state.favoriteLines, line],
        })),
      hasTram: (reg) => get().favoriteTrams.includes(reg),
      hasLine: (line) => get().favoriteLines.includes(line),
    }),
    {
      name: 'favorites',
      storage: createJSONStorage(() => fileSystemStorage),
      partialize: (state) => ({
        favoriteTrams: state.favoriteTrams,
        favoriteLines: state.favoriteLines,
      }),
    },
  ),
);
