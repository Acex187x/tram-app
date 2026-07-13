// Real MotionLogFS backed by the expo-file-system (SDK 57) synchronous
// File/Directory/Paths API, rooted at <document>/motionlogs|rides via a single
// base dir. All operations are best-effort; the core wraps them in try/catch.
import { Directory, File, Paths } from 'expo-file-system';

import type { MotionFileInfo, MotionLogFS } from './core';

/** Base directory holding both the motionlogs/ and rides/ subdirectories. */
function baseDir(): Directory {
  return new Directory(Paths.document, 'tramspotter-motion');
}

function ensureDir(rel: string): Directory {
  const dir = new Directory(baseDir(), rel);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function createExpoFS(): MotionLogFS {
  return {
    append(relPath, text) {
      const slash = relPath.lastIndexOf('/');
      const dirRel = slash >= 0 ? relPath.slice(0, slash) : '';
      const name = slash >= 0 ? relPath.slice(slash + 1) : relPath;
      const dir = dirRel ? ensureDir(dirRel) : ensureDir('.');
      const file = new File(dir, name);
      if (!file.exists) file.create({ intermediates: true });
      file.write(text, { append: true });
    },

    list(relDir) {
      const dir = new Directory(baseDir(), relDir);
      if (!dir.exists) return [];
      const out: MotionFileInfo[] = [];
      for (const entry of dir.list()) {
        if (entry instanceof File) {
          out.push({
            relPath: `${relDir}/${entry.name}`,
            name: entry.name,
            uri: entry.uri,
            size: entry.size ?? 0,
            modifiedMs: entry.lastModified ?? entry.creationTime ?? 0,
          });
        }
      }
      return out;
    },

    read(relPath) {
      const file = new File(baseDir(), relPath);
      return file.exists ? file.textSync() : '';
    },

    remove(relPath) {
      const file = new File(baseDir(), relPath);
      if (file.exists) file.delete();
    },

    uri(relPath) {
      return new File(baseDir(), relPath).uri;
    },
  };
}
