import importlib.util,json,os,threading,unittest,urllib.request,urllib.error
from pathlib import Path
import numpy as np
class Predictor:
    def predict(self,X):return np.sum(X,axis=1)
class ServingContract(unittest.TestCase):
    def setUp(self):
        self.old=os.environ.get('ML_FEATURE_VERSION');os.environ['ML_FEATURE_VERSION']='4'
        spec=importlib.util.spec_from_file_location('versioned_service',Path(__file__).with_name('service.py'))
        self.service=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.service)
        self.service.state.update(gbdt=Predictor(),mlp=None,ready=True)
        self.server=self.service.ThreadingHTTPServer(('127.0.0.1',0),self.service.Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
        if self.old is None:os.environ.pop('ML_FEATURE_VERSION',None)
        else:os.environ['ML_FEATURE_VERSION']=self.old
    def post(self,body):
        req=urllib.request.Request('http://127.0.0.1:'+str(self.server.server_port)+'/predict',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req)as r:return r.status,json.load(r)
        except urllib.error.HTTPError as r:return r.code,json.load(r)
    def test_versioned_twenty_column_inference_keeps_absent_shadow_unknown(self):
        code,body=self.post({'version':4,'rows':[[1]*20]});self.assertEqual(code,200);self.assertEqual(body['gbdt'],[20]);self.assertEqual(body['mlp'],[None]);self.assertEqual(len(self.service.FEATURES),20)
    def test_legacy_version_is_rejected_by_v4(self):self.assertEqual(self.post({'version':3,'rows':[[1]*13]})[0],409)
    def test_malformed_feature_width_and_nonfinite_rejected(self):
        for row in [[1]*13,[float('nan')]*20,['bad']*20]:self.assertEqual(self.post({'version':4,'rows':[row]})[0],400)
if __name__=='__main__':unittest.main()
