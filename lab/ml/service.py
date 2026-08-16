#!/usr/bin/env python3
"""Tram Lab ML service: nightly trainer + batch inference in one process.

Trains two models on the archived fix pairs to predict ds — "how far does the
tram travel in the next gapS seconds":
  gbdt — LightGBM regressor (trees; the tabular workhorse)
  mlp  — small neural net (sklearn MLPRegressor; the honest "нейронка" probe)

FEATURE CONTRACT v1 lives in lab/src/ml.ts — the TS side builds the same
features online; keep the two in sync BY HAND and bump FEATURE_VERSION on any
change (mismatched versions refuse predictions, which the lab treats as a
safe skip). Offline parity notes:
  - evaluation instant tEval := next.seenAtMs (the batch arrival ≈ the wall
    instant the online scorer runs at);
  - gapS := (tEval - prev.obsAtMs)/1000;
  - target ds := next.shapeDistM - prev.shapeDistM, same trip, gap 4..300 s;
  - learnedPace/learnedRelease are read from the CURRENT learned_cells (the
    surfaces evolve, so old pairs see today's surface — mild leakage toward
    the statistical layer, i.e. it makes the ML models' win condition
    HARDER, not easier; documented, acceptable).

Holdout: last 20% of pairs by time. MAE per model (plus the naive ds=0
baseline) is appended to ml_train_log for the Grafana panel, and the full
report (with LightGBM feature importances — the "where does signal live"
data-analysis artifact) is written to /data/models/report.json, served by the
lab at /api/mlreport.
"""

import json
import os
import sqlite3
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

FEATURE_VERSION = 2
FEATURES = [
    "gapS", "atStop", "delayS", "hourSin", "hourCos", "weekend",
    "distToNextStopM", "stopsNext1km", "learnedPace", "learnedRelease", "posFrac",
    # v2 (2026-08-12): the corridor/leader signal — recent measured pace of
    # this km of track by any vehicle. Added after v1 plateaued at ~58.6 m
    # across a ×1.8 data growth. Offline: time-decayed mean of prior samples
    # (30-min window, 12-min half-life, STRICTLY before t_eval — no leakage);
    # online mirror: LearnedModel.corridorPaceAt (same half-life EWMA).
    "corridorPace", "corridorTrust",
]

CORRIDOR_HL_MS = 12 * 60 * 1000
CORRIDOR_WIN_MS = 30 * 60 * 1000

DB = os.environ.get("LAB_DB", "/data/lab.db")
MODELS_DIR = os.environ.get("MODELS_DIR", "/data/models")
PORT = int(os.environ.get("ML_PORT", "8092"))
PRAGUE = ZoneInfo("Europe/Prague")
MIN_PAIRS = 4000
TRAIN_HOUR_UTC = 2
RETRAIN_MIN_INTERVAL_S = 20 * 3600

state = {"gbdt": None, "mlp": None, "ready": False, "trained_at": 0.0}
lock = threading.Lock()


def log(msg):
    print(f"[ml {datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


def connect():
    c = sqlite3.connect(DB, timeout=30)
    c.execute("PRAGMA busy_timeout=15000")
    return c


# ── learned-surface lookups (mirror of lab/src/learned.ts fallback chain) ────

def load_learned_cells(c):
    cells = {}
    for tbl, key, mean, weight in c.execute("SELECT tbl, cellKey, mean, weight FROM learned_cells"):
        cells.setdefault(tbl, {})[key] = (mean, weight)
    return cells


def pace_at(cells, shape_id, route_id, s, band, day):
    b = int(s // 250)
    for tbl, key, minw in (
        ("seg", f"{shape_id}|{b}|{band}|{day}", 3),
        ("segShape", f"{shape_id}|{b}", 3),
        ("route", f"{route_id}|{band}", 5),
        ("global", f"{band}", 10),
    ):
        v = cells.get(tbl, {}).get(key)
        if v and v[1] >= minw:
            return v[0]
    return 5.5


def release_at(cells, stop_id, band, day):
    v = cells.get("stopRelease", {}).get(f"{stop_id}|{band}|{day}")
    return v[0] if v and v[1] >= 3 else 20.0


# ── dataset ──────────────────────────────────────────────────────────────────

def build_dataset():
    c = connect()
    fixes = pd.read_sql_query(
        "SELECT key, tripId, routeId, obsAtMs, seenAtMs, shapeDistM, statePos, delayS, nextStopId"
        " FROM fixes ORDER BY key, obsAtMs",
        c,
    )
    geoms = {}
    for trip_id, shape_id, js in c.execute("SELECT tripId, shapeId, json FROM geometries"):
        try:
            g = json.loads(js)
        except json.JSONDecodeError:
            continue
        stops = sorted((st["distM"], st["stopId"]) for st in g.get("stops", []))
        geoms[trip_id] = (shape_id, float(g.get("totalM", 0) or 0), stops)
    cells = load_learned_cells(c)
    c.close()

    nxt = fixes.shift(-1)
    same = (nxt["key"] == fixes["key"]) & (nxt["tripId"] == fixes["tripId"])
    gap_obs = (nxt["obsAtMs"] - fixes["obsAtMs"]) / 1000.0
    d_dist = nxt["shapeDistM"] - fixes["shapeDistM"]

    # Corridor pace samples (mirror of the online learner's moving gates).
    mv = (
        same
        & (gap_obs >= 8) & (gap_obs <= 240)
        & (fixes["statePos"] != "at_stop") & (nxt["statePos"] != "at_stop")
        & (d_dist >= 15) & ((d_dist / gap_obs) <= 22)
    )
    corr_raw = {}
    for trip_id, p_dist, t_ms, dd, gp in zip(
        fixes.loc[mv, "tripId"], fixes.loc[mv, "shapeDistM"],
        nxt.loc[mv, "obsAtMs"], d_dist[mv], gap_obs[mv],
    ):
        g = geoms.get(trip_id)
        if g is None:
            continue
        corr_raw.setdefault((g[0], int((p_dist + dd / 2) // 1000)), []).append(
            (float(t_ms), float(dd / gp))
        )
    corr = {
        k: (np.array([t for t, _ in sorted(v)]), np.array([s for _, s in sorted(v)]))
        for k, v in corr_raw.items()
    }

    def corridor_at(shape_id, s0, t_eval, fallback):
        e = corr.get((shape_id, int(s0 // 1000)))
        if e is None:
            return fallback, 0.0
        times, speeds = e
        hi = int(np.searchsorted(times, t_eval, side="left"))  # strictly before
        lo = int(np.searchsorted(times, t_eval - CORRIDOR_WIN_MS, side="left"))
        if hi <= lo:
            return fallback, 0.0
        w = 0.5 ** ((t_eval - times[lo:hi]) / CORRIDOR_HL_MS)
        sw = float(w.sum())
        trust = min(5.0, sw)
        if sw < 0.5:
            return fallback, trust
        return float((w * speeds[lo:hi]).sum() / sw), trust

    mask = same & (gap_obs >= 4) & (gap_obs <= 300) & nxt["seenAtMs"].notna()
    prev = fixes[mask].reset_index(drop=True)
    nxt = nxt[mask].reset_index(drop=True)
    if len(prev) < MIN_PAIRS:
        return None, None, len(prev)

    rows = []
    targets = []
    for p, n_obs_at, n_seen, n_dist in zip(
        prev.itertuples(index=False), nxt["obsAtMs"], nxt["seenAtMs"], nxt["shapeDistM"]
    ):
        geom = geoms.get(p.tripId)
        if geom is None:
            continue
        shape_id, total_m, stops = geom
        t_eval_ms = float(n_seen)
        dt = datetime.fromtimestamp(t_eval_ms / 1000.0, PRAGUE)
        hour = dt.hour
        weekend = 1.0 if dt.weekday() >= 5 else 0.0
        band = hour // 4
        day = "weekend" if weekend else "weekday"
        s0 = float(p.shapeDistM)
        gap_s = (t_eval_ms - float(p.obsAtMs)) / 1000.0
        if not (0 < gap_s <= 400):
            continue
        at_stop = 1.0 if p.statePos == "at_stop" else 0.0
        delay_s = min(900.0, max(-600.0, float(p.delayS or 0)))

        dist_next, stops_1km, seen_first = 1000.0, 0, False
        for dist_m, _sid in stops:
            if dist_m > s0:
                if not seen_first:
                    dist_next = min(2000.0, max(0.0, dist_m - s0))
                    seen_first = True
                if dist_m <= s0 + 1000:
                    stops_1km += 1
                else:
                    break

        lp = pace_at(cells, shape_id, p.routeId, s0 + 100, band, day)
        lr = release_at(cells, p.nextStopId, band, day) if (at_stop and p.nextStopId) else 0.0
        pos_frac = min(1.0, max(0.0, s0 / total_m)) if total_m > 0 else 0.0

        ds = float(n_dist) - s0
        if not (-100 <= ds <= 3500):
            continue
        cp, ct = corridor_at(shape_id, s0, t_eval_ms, lp)
        rows.append([
            gap_s, at_stop, delay_s,
            np.sin(2 * np.pi * hour / 24), np.cos(2 * np.pi * hour / 24), weekend,
            dist_next, float(stops_1km), lp, lr, pos_frac,
            cp, ct,
        ])
        targets.append(ds)

    if len(rows) < MIN_PAIRS:
        return None, None, len(rows)
    return np.asarray(rows, dtype=np.float64), np.asarray(targets, dtype=np.float64), len(rows)


# ── training ─────────────────────────────────────────────────────────────────

def train_once():
    t0 = time.time()
    X, y, n = build_dataset()
    if X is None:
        log(f"not enough pairs yet ({n} < {MIN_PAIRS}) — skipping train")
        return False
    split = int(len(X) * 0.8)
    X_tr, X_te, y_tr, y_te = X[:split], X[split:], y[:split], y[split:]

    gbdt = lgb.LGBMRegressor(
        n_estimators=400, learning_rate=0.05, num_leaves=63,
        min_child_samples=30, n_jobs=2, verbose=-1,
    )
    gbdt.fit(X_tr, y_tr)
    mae_gbdt = float(np.mean(np.abs(gbdt.predict(X_te) - y_te)))

    mlp = make_pipeline(
        StandardScaler(),
        MLPRegressor(hidden_layer_sizes=(64, 32), max_iter=300, early_stopping=True, random_state=1),
    )
    mlp.fit(X_tr, y_tr)
    mae_mlp = float(np.mean(np.abs(mlp.predict(X_te) - y_te)))

    mae_naive = float(np.mean(np.abs(y_te)))  # ds=0: the standing-still model
    train_s = round(time.time() - t0, 1)

    os.makedirs(MODELS_DIR, exist_ok=True)
    joblib.dump(gbdt, os.path.join(MODELS_DIR, "gbdt.pkl"))
    joblib.dump(mlp, os.path.join(MODELS_DIR, "mlp.pkl"))
    with open(os.path.join(MODELS_DIR, "version.txt"), "w") as f:
        f.write(str(FEATURE_VERSION))
    report = {
        "featureVersion": FEATURE_VERSION,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "nPairs": n,
        "holdout": {"gbdt": round(mae_gbdt, 1), "mlp": round(mae_mlp, 1), "naive_ds0": round(mae_naive, 1)},
        "trainSeconds": train_s,
        "featureImportances": dict(
            sorted(zip(FEATURES, [round(float(v), 1) for v in gbdt.feature_importances_]),
                   key=lambda kv: -kv[1])
        ),
    }
    with open(os.path.join(MODELS_DIR, "report.json"), "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    c = connect()
    c.execute(
        "CREATE TABLE IF NOT EXISTS ml_train_log (tsMin INTEGER, model TEXT, nPairs INTEGER,"
        " maeHoldout REAL, PRIMARY KEY (tsMin, model))"
    )
    ts_min = int(time.time() // 60)
    for model, mae in (("gbdt", mae_gbdt), ("mlp", mae_mlp), ("naive_ds0", mae_naive)):
        c.execute("INSERT OR REPLACE INTO ml_train_log VALUES (?,?,?,?)", (ts_min, model, n, round(mae, 1)))
    c.commit()
    c.close()

    with lock:
        state["gbdt"] = gbdt
        state["mlp"] = mlp
        state["ready"] = True
        state["trained_at"] = time.time()
    log(f"trained on {n} pairs in {train_s}s — holdout MAE: gbdt {mae_gbdt:.1f} m, "
        f"mlp {mae_mlp:.1f} m, naive(ds=0) {mae_naive:.1f} m")
    return True


def load_persisted():
    try:
        with open(os.path.join(MODELS_DIR, "version.txt")) as f:
            if int(f.read().strip()) != FEATURE_VERSION:
                log("persisted models are a different feature version — waiting for boot train")
                return
        gbdt = joblib.load(os.path.join(MODELS_DIR, "gbdt.pkl"))
        mlp = joblib.load(os.path.join(MODELS_DIR, "mlp.pkl"))
        with lock:
            state["gbdt"] = gbdt
            state["mlp"] = mlp
            state["ready"] = True
        log("loaded persisted models")
    except Exception:
        pass


def trainer_loop():
    load_persisted()
    try:
        train_once()
    except Exception:
        log("boot train failed:\n" + traceback.format_exc())
    while True:
        time.sleep(60)
        now = datetime.now(timezone.utc)
        due = now.hour == TRAIN_HOUR_UTC and (time.time() - state["trained_at"]) > RETRAIN_MIN_INTERVAL_S
        if due:
            try:
                train_once()
            except Exception:
                log("train failed:\n" + traceback.format_exc())


# ── inference server ─────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, body):
        buf = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(buf)))
        self.end_headers()
        self.wfile.write(buf)

    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, {"ok": True, "ready": state["ready"], "trainedAt": state["trained_at"]})
        elif self.path == "/report":
            try:
                with open(os.path.join(MODELS_DIR, "report.json")) as f:
                    self._json(200, json.load(f))
            except FileNotFoundError:
                self._json(404, {"error": "no report yet"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/predict":
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        except (json.JSONDecodeError, ValueError):
            return self._json(400, {"error": "bad json"})
        if body.get("version") != FEATURE_VERSION:
            return self._json(409, {"error": "feature version mismatch", "version": FEATURE_VERSION})
        rows = body.get("rows", [])
        with lock:
            gbdt, mlp, ready = state["gbdt"], state["mlp"], state["ready"]
        if not ready or not rows:
            return self._json(200, {"version": FEATURE_VERSION, "ready": ready, "gbdt": [], "mlp": []})
        X = np.asarray(rows, dtype=np.float64)
        try:
            g = [round(float(v), 1) for v in gbdt.predict(X)]
            m = [round(float(v), 1) for v in mlp.predict(X)]
        except Exception as e:
            return self._json(500, {"error": str(e)})
        self._json(200, {"version": FEATURE_VERSION, "ready": True, "gbdt": g, "mlp": m})


def main():
    threading.Thread(target=trainer_loop, daemon=True).start()
    log(f"inference server on :{PORT} (db={DB})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
