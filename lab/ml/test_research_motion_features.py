import unittest
from types import SimpleNamespace
import pandas as pd
from zoneinfo import ZoneInfo
from research_motion_features import add_motion_history,motion_at

class MotionHistoryTest(unittest.TestCase):
 def frame(self,rows):
  defaults=dict(key='v',tripId='trip',routeId='L1',statePos='on_track',nextStopId='next',lat=50.,lng=14.,delayS=0)
  return pd.DataFrame([{**defaults,**r} for r in rows])
 def run_history(self,df):
  return add_motion_history(df,{'trip':('shape',2000,[(0,'start'),(500,'current'),(1000,'next')])},{},lambda *_:8.,ZoneInfo('Europe/Prague'))
 def test_only_received_preceding_motion_is_available(self):
  df=self.run_history(self.frame([
   dict(obsAtMs=100000,seenAtMs=105000,shapeDistM=100),
   dict(obsAtMs=130000,seenAtMs=170000,shapeDistM=400),
   dict(obsAtMs=150000,seenAtMs=155000,shapeDistM=500),
  ]))
  self.assertEqual(df.loc[0,'motionWeight'],0)
  #150s anchor receives before130s stale fix; its history uses100→150,
  #never the unreceived130s fix. Later oldfix must not rewind state.
  self.assertAlmostEqual(df.loc[2,'motionPace'],8)
  self.assertEqual(df.loc[1,'motionFresh'],0)
  self.assertAlmostEqual(df.loc[1,'motionPace'],8)
 def test_current_run_pace_is_retained_but_resets_at_trip_change(self):
  df=self.run_history(self.frame([
   dict(obsAtMs=100000,seenAtMs=105000,shapeDistM=100),
   dict(obsAtMs=130000,seenAtMs=135000,shapeDistM=400),
   dict(obsAtMs=160000,seenAtMs=165000,shapeDistM=600,nextStopId='later'),
   dict(obsAtMs=190000,seenAtMs=195000,shapeDistM=0,tripId='new'),
  ]))
  self.assertAlmostEqual(df.loc[1,'motionPace'],10)
  self.assertAlmostEqual(df.loc[2,'motionPace'],10)
  self.assertEqual(df.loc[3,'motionWeight'],0)
  p=SimpleNamespace(**df.iloc[1].to_dict());near=motion_at(p,140000);far=motion_at(p,400000)
  self.assertGreater(near[1],far[1]);self.assertGreater(near[3],1)
 def test_at_stop_is_not_itself_stationary_evidence(self):
  df=self.run_history(self.frame([
   dict(obsAtMs=100000,seenAtMs=105000,shapeDistM=400,statePos='at_stop'),
   dict(obsAtMs=120000,seenAtMs=125000,shapeDistM=480,statePos='at_stop',lng=14.001),
   dict(obsAtMs=140000,seenAtMs=145000,shapeDistM=481,statePos='at_stop',lng=14.001),
  ]))
  self.assertEqual(df.loc[1,'stationaryEvidence'],0)
  self.assertEqual(df.loc[2,'stationaryEvidence'],20)
  self.assertEqual(df.loc[0,'currentOffset'],100)
  self.assertTrue((df['motionWeight']==0).all())
if __name__=='__main__':unittest.main()
