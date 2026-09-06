"""Version-4 causal motion-feature extraction, shared by research and training.

Histories advance in receipt order, never from the target pair. Per-trip state
resets on a changed trip and ignores older same-trip observations. No raw rows
are exported; the result is numerical features aligned with the source frame.
"""
import math
import numpy as np

MOTION_FEATURES=['lastLegPace','motionTrust','motionAgeS','tripPaceRatio',
                 'currentPlatformOffsetM','platformKnown','stationaryEvidenceS']
MOTION_HL_MS=180000.0

def add_motion_history(fixes, geoms, cells, pace_at, prague):
    out=np.zeros((len(fixes),9),dtype=np.float64)
    states={}
    platforms={}
    for trip,(shape,total,stops) in geoms.items():
        ids={}
        for i,(_s,sid) in enumerate(stops):ids.setdefault(sid,[]).append(i)
        platforms[trip]={sid:stops[idx[0]-1][0] for sid,idx in ids.items() if len(idx)==1 and idx[0]>0}
    for p in fixes.sort_values('seenAtMs',kind='stable').itertuples():
        old=states.get(p.key)
        if not old or old['trip']!=p.tripId:
            old={'trip':p.tripId,'prev':None,'pace':0.,'weight':0.,'ratio':1.,'at':0.,'standing':None}
            states[p.key]=old
        prev=old['prev']
        fresh=prev is None or p.obsAtMs>prev.obsAtMs
        if fresh:
            if prev is not None:
                dt=(p.obsAtMs-prev.obsAtMs)/1000.;ds=p.shapeDistM-prev.shapeDistM
                same_leg=p.nextStopId is not None and p.nextStopId==prev.nextStopId
                if 5<=dt<=120 and same_leg and p.statePos=='on_track' and prev.statePos=='on_track' and ds>=15 and .5<=ds/dt<=22:
                    geo=geoms.get(p.tripId)
                    if geo:
                        ctx=__import__('datetime').datetime.fromtimestamp(p.obsAtMs/1000.,prague)
                        expected=pace_at(cells,geo[0],p.routeId,prev.shapeDistM+ds/2,ctx.hour//4,'weekend' if ctx.weekday()>=5 else 'weekday',p.obsAtMs)
                        decay=.5**(max(0,p.obsAtMs-old['at'])/MOTION_HL_MS) if old['at'] else 0.
                        weight=old['weight']*decay
                        old['pace']=(old['pace']*weight+ds/dt)/(weight+1)
                        old['ratio']=(old['ratio']*weight+min(2,max(.4,(ds/dt)/max(.5,expected))))/(weight+1)
                        old['weight']=weight+1;old['at']=p.obsAtMs
                gps=6371000*math.hypot(math.radians(p.lng-prev.lng)*math.cos(math.radians((p.lat+prev.lat)/2)),math.radians(p.lat-prev.lat))
                if 5<=dt<=120 and same_leg and p.statePos=='at_stop' and prev.statePos=='at_stop' and abs(ds)<=8 and gps<=12:
                    if old['standing'] is None:old['standing']=prev.obsAtMs
                else:old['standing']=None
            old['prev']=p
        current=platforms.get(p.tripId,{}).get(p.nextStopId)
        known=current is not None
        standing=min(120,max(0,(p.obsAtMs-old['standing'])/1000)) if old['standing'] is not None else 0.
        # Store observation epoch to decay trust at each requested horizon.
        out[p.Index]=[old['pace'],old['weight'],old['at'],old['ratio'],
                      min(200,max(-200,current-p.shapeDistM)) if known else 0.,float(known),standing,
                      p.obsAtMs,float(fresh)]
    for i,name in enumerate(['motionPace','motionWeight','motionAt','motionRatio','currentOffset','platformKnown','stationaryEvidence','motionAnchor','motionFresh']):fixes[name]=out[:,i]
    return fixes

def motion_at(p,t_eval_ms):
    age=max(0,(t_eval_ms-p.motionAt)/1000) if p.motionAt else 300.
    weight=p.motionWeight*.5**(max(0,t_eval_ms-p.motionAt)/MOTION_HL_MS) if p.motionAt else 0.
    ratio=(1+p.motionRatio*weight)/(1+weight)
    return [p.motionPace if weight>=.25 else 0.,min(5,weight),min(300,age),
            min(1.6,max(.5,ratio)),p.currentOffset,p.platformKnown,p.stationaryEvidence]
