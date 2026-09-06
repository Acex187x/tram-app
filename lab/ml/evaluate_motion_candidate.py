#!/usr/bin/env python3
"""Matched chronological v3 vs causal per-trip/phase feature experiment."""
import json,sys,time
from pathlib import Path
import numpy as np
import lightgbm as lgb
import joblib
from evaluate_clock_candidate import metrics

def run(dataset,output):
 out=Path(output);out.mkdir(parents=True,exist_ok=True)
 d=np.load(dataset);X=d['motion'];y=d['y'];t=d['targetMs'];issue=d['issueMs'];arr=d['arrivalMs']
 assert np.array_equal(X[:,:13],d['v3']);assert np.isfinite(X).all();assert np.isfinite(y).all()
 cut=t[-1]-24*3600000;train=(t<cut)&(arr<cut);test=(t>=cut)&(issue>=cut)&(issue<t)
 hour=np.arctan2(X[:,3],X[:,4])/(2*np.pi)*24%24
 groups={'all':test,'raw_on_track':test&(X[:,1]==0),'raw_at_stop':test&(X[:,1]==1),'night_0_6':test&(hour<6),
 'approach_station_zone':test&(X[:,1]==1)&(X[:,18]==1)&(X[:,17]>45)&(X[:,17]<=150),
 'near_platform_station_zone':test&(X[:,1]==1)&(X[:,18]==1)&(abs(X[:,17])<=15),
 'trusted_fast_trip':test&(X[:,14]>=1)&(X[:,16]>1.1),'trusted_slow_trip':test&(X[:,14]>=1)&(X[:,16]<.9),
 'motion_unknown':test&(X[:,14]<.25),'horizon_under30':test&(X[:,0]<30),'horizon30_60':test&(X[:,0]>=30)&(X[:,0]<60),'horizon60plus':test&(X[:,0]>=60)}
 report={'rows':len(y),'trainRows':int(train.sum()),'testRows':int(test.sum()),'cutMs':float(cut),'nightRows':int(groups['night_0_6'].sum()),'models':{},
 'limitations':['Numerical observation-time AVL reference, not rider GPS.','Current learned-surface aggregates reused for historical rows.','Raw at_stop denotes station/arrival-announcement zone, not measured stationary state.','Matched retrained v3 baseline; published candidate artifact is not retrained during this test.','Pace records strictly same-trip, same-leg, both on_track; later receipts unavailable.']}
 preds={}
 for name,ncols in [('v3',13),('motionOnly',17),('motionPhase',20)]:
  start=time.time();m=lgb.LGBMRegressor(n_estimators=400,learning_rate=.05,num_leaves=63,min_child_samples=30,n_jobs=2,verbose=-1,random_state=1)
  m.fit(X[train,:ncols],y[train],sample_weight=np.where(hour[train]<6,3.,1.));p=m.predict(X[:,:ncols]);preds[name]=p
  r={'seconds':time.time()-start,'groups':{}}
  for g,mask in groups.items():
   if not mask.any():continue
   err=p[mask]-y[mask];r['groups'][g]={**metrics(y[mask],p[mask]),'p99M':float(np.quantile(abs(err),.99)),'ahead30Fraction':float(np.mean(err>30)),'behind30Fraction':float(np.mean(err< -30))}
  if name!='v3':
   old=preds['v3']-y;err=p-y
   r['paired']= {'newAhead30':int((test&(old<=30)&(err>30)).sum()),'resolvedAhead30':int((test&(old>30)&(err<=30)).sum()),'improvedAbs30':int((test&(abs(old)-abs(err)>30)).sum()),'regressedAbs30':int((test&(abs(err)-abs(old)>30)).sum())}
  r['featureImportance']=m.feature_importances_.tolist();report['models'][name]=r
  joblib.dump(m,out/(name+'.pkl'));m.booster_.save_model(str(out/(name+'.txt')))
  (out/'evaluation.json').write_text(json.dumps(report,indent=2))
  print(name,r['groups']['all'],r.get('paired'),flush=True)
 np.savez_compressed(out/'predictions.npz',**preds,test=test)
if __name__=='__main__':run(*sys.argv[1:3])
