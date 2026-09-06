#!/usr/bin/env python3
"""Export only numeric feature matrices through a read-only archive connection.

Run against version-3 service.py. No DB file, raw fix, identity, credential or
model state is exported or changed. A single learned-surface snapshot and a
fixed observation window make the three variants exactly comparable.
"""
import argparse
import sqlite3
import sys
import time
import numpy as np
import service


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--since-ms',required=True,type=float)
    parser.add_argument('--until-ms',required=True,type=float)
    args=parser.parse_args()
    if args.until_ms <= args.since_ms:
        parser.error('until must follow since')
    def readonly():
        connection=sqlite3.connect(f'file:{service.DB}?mode=ro',uri=True,timeout=30)
        connection.execute('PRAGMA query_only=ON')
        return connection
    service.connect=readonly
    connection=readonly()
    cells=service.load_learned_cells(connection)
    connection.close()
    service.load_learned_cells=lambda _connection:cells
    result={}
    for label,clock,causal in [('v2','arrival',False),('clockOnly','observation',False),('v3','observation',True)]:
        started=time.time()
        X,y,n,timing=service.build_dataset(since_ms=args.since_ms,until_ms=args.until_ms,
            target_clock=clock,causal_corridor=causal,metadata=True)
        if X is None:
            raise ValueError(f'Insufficient dataset: {n}')
        result[label]=X
        if label=='v2': result.update(y=y,**timing)
        else:
            assert np.array_equal(result['y'],y)
            for name in ['targetMs','arrivalMs','issueMs']:
                assert np.array_equal(result[name],timing[name]),name
        print(label,n,round(time.time()-started,2),file=sys.stderr,flush=True)
    assert np.array_equal(result['clockOnly'][:,:11],result['v3'][:,:11],equal_nan=True)
    result['sinceMs']=np.asarray([args.since_ms])
    result['untilMs']=np.asarray([args.until_ms])
    np.savez_compressed(sys.stdout.buffer,**result)

if __name__=='__main__': main()
