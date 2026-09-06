#!/usr/bin/env python3
"""Read-only numerical v3/v4 research export. No serving module is modified.

Usage: python export_motion_dataset.py SERVICE_SOURCE MOTION_SOURCE SINCE UNTIL
May be bundled with both source strings to run through stdin in an existing
Python environment. Connections are query_only and raw identifiers stay remote.
"""
import sys,types,sqlite3,time
import numpy as np

def export(service_source,motion_source,since,until):
    motion=types.ModuleType('research_motion_features');sys.modules[motion.__name__]=motion
    exec(compile(motion_source,'research_motion_features.py','exec'),motion.__dict__)
    native = 'if FEATURE_VERSION == 4:' in service_source
    if native:
        source=service_source
    else:
        source=service_source.replace('statePos, delayS, nextStopId"','statePos, delayS, nextStopId, lat, lng"')
        marker='    c.close()\n\n    nxt = fixes.shift(-1)'
        assert source.count(marker)==1
        source=source.replace(marker,'    c.close()\n    fixes = add_motion_history(fixes, geoms, cells, pace_at, PRAGUE)\n\n    nxt = fixes.shift(-1)')
        marker='            cp, ct,\n        ])'
        assert source.count(marker)==1
        source=source.replace(marker,'            cp, ct,\n            *motion_at(p, t_eval_ms),\n        ])')
        source=source.replace('mask = (same & (gap_obs >= 4)', 'mask = ((fixes["motionFresh"] == 1) & same & (gap_obs >= 4)')
    mod=types.ModuleType('research_service');sys.modules[mod.__name__]=mod
    mod.__dict__.update(add_motion_history=motion.add_motion_history,motion_at=motion.motion_at)
    exec(compile(source,'research_service_v3.py','exec'),mod.__dict__)
    if native: mod.FEATURE_VERSION=4
    def readonly():
        c=sqlite3.connect('file:'+mod.DB+'?mode=ro',uri=True,timeout=30);c.execute('PRAGMA query_only=ON');return c
    mod.connect=readonly
    start=time.time();X,y,n,timing=mod.build_dataset(since_ms=since,until_ms=until,metadata=True)
    if X is None:raise ValueError('Insufficient pairs '+str(n))
    print('rows',n,'seconds',round(time.time()-start,1),'columns',X.shape[1],file=sys.stderr,flush=True)
    np.savez_compressed(sys.stdout.buffer,v3=X[:,:13],motion=X,y=y,**timing,
                        sinceMs=np.asarray([since]),untilMs=np.asarray([until]))
if __name__=='__main__':
    from pathlib import Path
    export(Path(sys.argv[1]).read_text(),Path(sys.argv[2]).read_text(),float(sys.argv[3]),float(sys.argv[4]))
