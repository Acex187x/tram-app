// ДАННЫЕ С БД, транспортный слой: опрос движка про один трамвай.
//
// Дебаг-режим only. Один хук на потребителя (оверлей + трассы на карте — два
// опроса по 3 с, оба живут только пока панель/карта дебага смонтированы).
// Формат ответа — lab/src/run.ts getVehicleDebug; меняются вместе.

import { useEffect, useState } from 'react';

export const SERVER_DEBUG_BASE = 'https://tram-lab.acex.sh/api/vehicle';
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
  ml?: { ready: boolean; lastOkMs: number; lastError: string | null };
  publish?: { enabled: boolean; emittedAtMs: number | null; synced: boolean };
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

export function useServerDebug(key: string | null): {
  data: ServerVehicleDebug | null;
  error: string | null;
} {
  const [data, setData] = useState<ServerVehicleDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setData(null);
      setError(null);
      return;
    }
    let alive = true;
    setData(null);
    setError(null);
    const read = async () => {
      try {
        const res = await fetch(`${SERVER_DEBUG_BASE}/${encodeURIComponent(key)}/debug`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ServerVehicleDebug;
        if (alive) {
          setData(body);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void read();
    const id = setInterval(() => void read(), SERVER_DEBUG_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key]);
  return { data, error };
}
