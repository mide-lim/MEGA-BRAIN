"""CI-only rehearsal of the real saved metadata plan. No network or credentials."""
import argparse,copy,hashlib,importlib.util,json,os,pathlib
def main():
 if os.environ.get('GITHUB_ACTIONS')!='true':raise SystemExit('Central GitHub Actions required.')
 a=argparse.ArgumentParser();a.add_argument('--input',required=True);a.add_argument('--plan',required=True);a.add_argument('--output',required=True);a.add_argument('--store',required=True);args=a.parse_args()
 here=pathlib.Path(__file__).parent
 spec=importlib.util.spec_from_file_location('catalogue_simulation_guards',here/'test_apply_reels_catalogue.py');tests=importlib.util.module_from_spec(spec);spec.loader.exec_module(tests);m=tests.m
 source=json.loads(pathlib.Path(args.input).read_text());o=source['observation'];plan=json.loads(pathlib.Path(args.plan).read_text())
 values={r['path']:r['data'] for r in o['records']};values[m.SETTINGS[0]]=o['taxonomy']['data']
 for name in ['admission','automation']:values['settings/'+name]={'enabled':False}
 for stage in ['acquisition','transcription','analysis']:values['reels_controls/'+stage]={'paused':True,'active':[]}
 client=tests.FakeClient(values)
 for row in o['records']:client.docs[row['path']]['updateTime']=row['updateTime']
 client.docs[m.SETTINGS[0]]['updateTime']=o['taxonomy']['updateTime']
 originals={path:copy.deepcopy(doc)for path,doc in client.docs.items()if path.startswith(('videos/','reels_legacy_content/'))}
 class MeasuredOwner(m.CatalogueBootstrap):
  def __init__(self,*args,**kwargs):super().__init__(*args,**kwargs);self.maximum_read_bytes=0
  def _read(self,*args,**kwargs):
   result=super()._read(*args,**kwargs);self.maximum_read_bytes=max(self.maximum_read_bytes,self.read_bytes);return result
 runner=MeasuredOwner(plan,client,True);result=runner.run()
 if result['status']!='applied_verified' or result['stagedDocuments']!=len(plan['contributionWrites'])+len(plan['reviewWrites']):raise RuntimeError('Real saved-plan simulation incomplete.')
 if any(client.docs[path]!=doc for path,doc in originals.items()):raise RuntimeError('Simulation modified original saved source.')
 if any(not(w['path'].startswith('reels_index/')or w['path']in m.SETTINGS)for commit in client.commits for w in commit):raise RuntimeError('Out-of-scope simulated write.')
 wire_bytes=[len(m.canonical({'writes':[{'update':{'name':m.ROOT+w['path'],'fields':{k:m.encode(v)for k,v in w['data'].items()}}}for w in commit]}).encode())for commit in client.commits]
 if max(wire_bytes)>m.MAX_TX_BYTES:raise RuntimeError('Real plan wire write exceeds operator budget.')
 rows=[{'path':p,'data':m.document_data(doc),'updateTime':doc['updateTime']}for p,doc in client.docs.items()]
 pathlib.Path(args.store).write_text(json.dumps({'schemaVersion':1,'records':rows},ensure_ascii=False)+'\n')
 receipt={'schemaVersion':1,'kind':'ci_saved_plan_operator_simulation_not_production','sourceCommit':os.environ['GITHUB_SHA'],'sourceObservationSHA256':source['sourceObservationSHA256'],'planSHA256':hashlib.sha256(pathlib.Path(args.plan).read_bytes()).hexdigest(),'result':result,'sourceDocumentsPreserved':len(originals),'sourceWrites':0,'newReels':0,'providers':0,'maximumTransactionReadBytes':runner.maximum_read_bytes,'maximumCommitWireBytes':max(wire_bytes),'operatorReadBudgetBytes':m.MAX_TX_BYTES,'transactions':len(client.commits),'usesFirestoreWireEncodedSizes':True,'timingIsSyntheticNotProductionLatency':True}
 pathlib.Path(args.output).write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({k:receipt[k]for k in ['maximumTransactionReadBytes','maximumCommitWireBytes','sourceDocumentsPreserved','sourceWrites','providers']}))
if __name__=='__main__':main()
