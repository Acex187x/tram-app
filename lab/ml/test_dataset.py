"""Regression tests for observation-time targets and evidence availability."""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import service

class DatasetClockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db, self.old_min = service.DB, service.MIN_PAIRS
        service.DB = os.path.join(self.tmp.name, 'test.db')
        service.MIN_PAIRS = 1
        db = sqlite3.connect(service.DB)
        db.executescript('''
        CREATE TABLE fixes (key TEXT, tripId TEXT, routeId TEXT, obsAtMs REAL,
            seenAtMs REAL, shapeDistM REAL, statePos TEXT, delayS REAL, nextStopId TEXT);
        CREATE TABLE geometries (tripId TEXT, shapeId TEXT, json TEXT);
        CREATE TABLE learned_cells (tbl TEXT, cellKey TEXT, mean REAL, weight REAL);
        ''')
        self.t0 = 1788616800000
        geom = json.dumps({'totalM': 5000, 'stops': [{'distM': 4000, 'stopId': 'end'}]})
        for key, offset in [('A', 20), ('B', 0)]:
            db.execute('INSERT INTO geometries VALUES (?, ?, ?)', (key, key, geom))
            for seconds, distance in [(offset, 0), (offset+30, 300), (offset+60, 600)]:
                db.execute('INSERT INTO fixes VALUES (?,?,?,?,?,?,?,?,?)',
                           (key, key, 'r', self.t0+seconds*1000, self.t0+(seconds+6)*1000,
                            distance, 'on_track', 0, 'end'))
        db.commit()
        db.close()

    def tearDown(self):
        service.DB, service.MIN_PAIRS = self.old_db, self.old_min
        self.tmp.cleanup()

    def test_target_clock_global_order_and_own_pair_leak(self):
        X, y, n, meta = service.build_dataset(metadata=True)
        old, old_y, _, old_meta = service.build_dataset(
            target_clock='arrival', causal_corridor=False, metadata=True)
        self.assertEqual(n, 4)
        self.assertEqual(meta['targetMs'].tolist(), [self.t0+s*1000 for s in [30, 50, 60, 80]])
        self.assertEqual(X[:,0].tolist(), [30]*4)
        self.assertEqual(old[:,0].tolist(), [36]*4)
        self.assertEqual(y.tolist(), old_y.tolist())
        # First forecast on each shape cannot know its own future measured
        # 10m/s pace. Version 2 did: observation < target arrival by 6 seconds.
        self.assertEqual(X[:2,11].tolist(), [5.5, 5.5])
        self.assertEqual(X[:2,12].tolist(), [0, 0])
        self.assertTrue(all(abs(old[:2,11] - 10) < 1e-9))
        # The next forecast can use the previous pair, now received.
        self.assertTrue(all(abs(X[2:,11] - 10) < 1e-9))
        self.assertTrue(all(X[2:,12] > 0.9))

    def test_displacement_reset_and_unavailable_anchor_rejected(self):
        db=sqlite3.connect(service.DB)
        db.execute('UPDATE fixes SET shapeDistM=2000 WHERE key="B" AND shapeDistM=300')
        db.execute('UPDATE fixes SET seenAtMs=obsAtMs+45000 WHERE key="A" AND shapeDistM=0')
        db.commit(); db.close()
        X,y,n,meta=service.build_dataset(metadata=True)
        self.assertEqual(n, 1)
        self.assertEqual(meta['targetMs'].tolist(), [self.t0+80000])

if __name__ == '__main__':
    unittest.main()
