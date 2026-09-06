// Shared foreground-only diagnostics requests for the selected tram.
// Map and inspector share a stream, with timeout, cancellation and no overlap.

import { useCallback, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

export const SERVER_DEBUG_BASE = (process.env.EXPO_PUBLIC_LAB_DEBUG_URL || 'https://tram-lab.acex.sh/api/vehicle').replace(/\/$/, '');
export const SERVER_DEBUG_POLL_MS = 3_000;

export interface ServerVehicleDebug {
  found: boolean;
  atMs?: number;
  tripId?: string;
  emittedAtMs?: number;
  curveSource?: 'ml' | 'naive' | null;
  anchorFix?: { obsAtMs: number; s: number } | null;
  latestFix?: {
    obsAtMs: number;
    s: number;
    statePosition: string;
    fixGapS: number;
    stuckAtM: number | null;
  } | null;
  ml?: { ready?: boolean; lastOkMs?: number; lastError?: string | null; lastRequestMs?: number; lastLatencyMs?: number | null; inFlight?: boolean };
  pipeline?: { refreshing?: boolean; builtAtMs?: number; pendingFix?: boolean; horizonRemainingS?: number };
  publish?: { enabled?: boolean; emittedAtMs?: number | null; synced?: boolean; lastOkAtMs?: number; failures?: number; lastError?: string | null };
  /** Сырые ML-таргеты (13 точек {t,s}) — то, за чем едет профиль. */
  target?: { t: number; s: number }[];
  fixes?: {
    observedAtMs?: number;
    obsAtMs?: number;
    shapeDistM?: number;
    distM?: number;
    statePosition?: string;
  }[];
}

export interface ServerDebugState {
  data: ServerVehicleDebug | null;
  error: string | null;
  receivedAtMs: number | null;
  loading: boolean;
}
const EMPTY: ServerDebugState = { data: null, error: null, receivedAtMs: null, loading: false };
interface Entry {
  value: ServerDebugState;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}
// Overlay and map share one request stream; entries disappear with the last
// subscriber. No background polling, overlapping requests or late key writes.
const entries = new Map<string, Entry>();
function subscribe(key: string, listener: () => void): () => void {
  let entry = entries.get(key);
  if (!entry) {
    entry = { value: EMPTY, listeners: new Set(), stop: null };
    entries.set(key, entry);
  }
  entry.listeners.add(listener);
  if (!entry.stop) entry.stop = start(key, entry);
  return () => {
    entry!.listeners.delete(listener);
    if (entry!.listeners.size === 0) {
      entry!.stop?.();
      entries.delete(key);
    }
  };
}
function start(key: string, entry: Entry): () => void {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let disposed = false;
  const publish = (value: ServerDebugState) => {
    entry.value = value;
    entry.listeners.forEach((listener) => listener());
  };
  const pause = () => {
    generation++;
    clearTimeout(timer);
    clearTimeout(timeout);
    controller?.abort();
    controller = null;
  };
  const read = async () => {
    if (disposed || AppState.currentState !== 'active') return;
    const epoch = generation;
    const abort = new AbortController();
    controller = abort;
    timeout = setTimeout(() => abort.abort(), 8_000);
    publish({ ...entry.value, loading: true });
    try {
      const res = await fetch(`${SERVER_DEBUG_BASE}/${encodeURIComponent(key)}/debug`, { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as ServerVehicleDebug;
      if (typeof body?.found !== 'boolean') throw new Error('Некорректный ответ диагностики');
      if (disposed || epoch !== generation) return;
      publish({ data: body, error: null, receivedAtMs: Date.now(), loading: false });
    } catch (e) {
      if (disposed || epoch !== generation) return;
      publish({ ...entry.value, error: abort.signal.aborted ? 'Тайм-аут диагностики (8 с)' : e instanceof Error ? e.message : String(e), loading: false });
    } finally {
      if (epoch === generation && !disposed) {
        clearTimeout(timeout);
        controller = null;
        timer = setTimeout(() => void read(), SERVER_DEBUG_POLL_MS);
      }
    }
  };
  const appState = AppState.addEventListener('change', (state) => {
    pause();
    if (state === 'active') void read();
  });
  void read();
  return () => { disposed = true; pause(); appState.remove(); };
}

export function useServerDebug(key: string | null): ServerDebugState {
  const attach = useCallback((listener: () => void) => key ? subscribe(key, listener) : () => {}, [key]);
  const snapshot = useCallback(() => key ? entries.get(key)?.value ?? EMPTY : EMPTY, [key]);
  return useSyncExternalStore(attach, snapshot, () => EMPTY);
}
