#!/usr/bin/env python3
"""Paired, fleet-chronological ML clock experiment on derived numeric arrays.

Input has v2 (arrival/leaky), clockOnly (observation/leaky), v3 (observation/
causal) matrices with identical targets. Export uses a read-only live DB
connection; this evaluator never contacts production or writes model state.
"""
import argparse
import json
from pathlib import Path
import time
import joblib
import lightgbm as lgb
import numpy as np


def metrics(y, pred):
    err = pred-y
    return {'n':len(y), 'maeM':float(np.abs(err).mean()), 'biasM':float(err.mean()),
            'p50M':float(np.quantile(np.abs(err), .5)), 'p90M':float(np.quantile(np.abs(err), .9))}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('dataset')
    parser.add_argument('output')
    parser.add_argument('--holdout-hours',type=float,default=0)
    args=parser.parse_args()
    out=Path(args.output); out.mkdir(parents=True, exist_ok=True)
    data=np.load(args.dataset)
    X=data['v3']; y=data['y']; target=data['targetMs']; issued=data['issueMs']
    assert np.array_equal(data['clockOnly'][:,:11],X[:,:11],equal_nan=True), 'Unfrozen non-corridor features'
    assert np.all(target[1:] >= target[:-1])
    # Keep every equal-timestamp observation in one partition.
    cut=target[-1]-args.holdout_hours*3600000 if args.holdout_hours else target[int(len(y)*.8)]
    train=(target<cut) & (data['arrivalMs']<cut)
    test=(target>=cut) & (issued>=cut) & (issued<target)
    hour=(np.arctan2(X[:,3], X[:,4])/(2*np.pi)*24)%24
    weights=np.where(hour[train]<6, 3.0, 1.0)
    groups={'all':test, 'on_track':test & (X[:,1]==0), 'at_stop':test & (X[:,1]==1),
            'horizon_4_30':test & (X[:,0]<=30), 'horizon_30_60':test & (X[:,0]>30) & (X[:,0]<=60),
            'horizon_60_300':test & (X[:,0]>60), 'night_0_6':test & (hour<6)}
    age=(data['arrivalMs']-target)/1000
    report={'rows':len(y),'trainRows':int(train.sum()),'testRows':int(test.sum()),'trainLateLabelPurged':int(((target<cut)&~train).sum()),'testUnissuedPurged':int(((target>=cut)&~test).sum()),'nightHoldoutRows':int((test & (hour<6)).sum()),
            'trainFirstMs':float(target[0]),'cutMs':float(cut),'lastMs':float(target[-1]),
            'ingestLatencyS': {'mean':float(age.mean()),'p50':float(np.median(age)),
                               'p90':float(np.quantile(age,.9))},
            'causalCorridorDiffersFraction':float(np.mean(np.abs(data['clockOnly'][:,11]-X[:,11])>1e-6)),
            'limitations':['Current archived learned-surface aggregates, not historical snapshots.',
                            'Same-trip AVL position timestamps are the reference; no rider GPS.',
                            'Matched retrained baselines, not the current production model binary.'],
            'models':{}}
    for name in ['v2','clockOnly','v3']:
        started=time.time()
        model=lgb.LGBMRegressor(n_estimators=400,learning_rate=.05,num_leaves=63,
                               min_child_samples=30,n_jobs=2,verbose=-1,random_state=1)
        model.fit(data[name][train], y[train],sample_weight=weights)
        # Every model is asked for the SAME real observation-time horizon,
        # using only information available at issue time.
        pred=model.predict(X)
        result={'trainSeconds':time.time()-started,
                'observationTime':{g:metrics(y[mask],pred[mask]) for g,mask in groups.items() if mask.any()},
                'ownTrainingFeatureHoldout':metrics(y[test],model.predict(data[name][test]))}
        if name=='v3':
            joblib.dump(model, out/'gbdt.pkl')
            (out/'version.txt').write_text('3')
            model.booster_.save_model(str(out/'gbdt.txt'))
        report['models'][name]=result
        (out/'evaluation.json').write_text(json.dumps(report,indent=2))
        print(name,json.dumps(result['observationTime']['all']),flush=True)
    print(json.dumps(report,indent=2))

if __name__=='__main__': main()
