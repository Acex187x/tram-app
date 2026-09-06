import json,unittest
from pathlib import Path
from service import pace_at,release_at
class LearnedTrustParity(unittest.TestCase):
 def test_shared_typescript_threshold_fallback_goldens(self):
  fixture=json.loads((Path(__file__).parent/'fixtures/learned-trust-parity.json').read_text())
  for case in fixture['cases']:
   with self.subTest(case=case['name']):
    cells={}
    for table,key,mean,weight,offset in case['rows']:cells.setdefault(table,{})[key]=(mean,weight,fixture['baseMs']+offset)
    at=fixture['baseMs']+case['ageMs']
    self.assertEqual(pace_at(cells,'shape','route',600,0,'weekend',at),case['pace'])
    self.assertEqual(release_at(cells,'stop',0,'weekend',at),case['release'])
if __name__=='__main__':unittest.main()
