import copy,importlib.util,pathlib,unittest
path=pathlib.Path(__file__).with_name('apply-reels-curation.py');spec=importlib.util.spec_from_file_location('curation_owner',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
H='a'*64
def package():
 current={'revision':7,'nodes':[{'id':'receitas','name':'Receitas','parentId':None,'manual':False}],'rules':[],'assignments':[],'appliedCommands':[],'pendingOperationId':None}
 after=copy.deepcopy(current);after['revision']=8;after['nodes'].append({'id':'ctx_one','name':'Receitas com Frango','parentId':'receitas','manual':False,'calibrationPlanHash':H});after['assignments']=[{'reelId':'reel01','categoryIds':['receitas','ctx_one'],'manual':False,'revision':8}];after['rules']=[{'id':'r','kind':'calibrated_ingredient_any','categoryId':'ctx_one','enabled':True,'scope':'finite_corpus_only','generalizationAllowed':False}];after['appliedCommands']=[{'id':H,'fingerprint':H}]
 cal={'planHash':H,'appliedOperationId':H,'newContentAutomatic':False,'processingStarted':False,'report':{'groups':[{'appliedCategoryId':'ctx_one','members':[{'id':'reel01','priorCategoryIds':['receitas']}]}]}}
 p={'schemaVersion':1,'kind':'reviewed_additive_curation_metadata','operationId':H,'sourceCommit':'b'*40,'planHash':H,'sourceAnalysisWrites':False,'newReels':False,'providers':False,'deletions':False,'groupIds':['ctx_one'],'affectedIds':['reel01'],'preconditions':{'taxonomyRevision':7,'sourceBindings':[{'reelId':'reel01','sourceUpdateTime':{'video':'2026-10-17T22:00:00Z'}}]},'writes':[{'path':module.PATHS[0],'data':after},{'path':module.PATHS[1],'data':cal}]}
 return current,p
class CurationOwnerGuards(unittest.TestCase):
 def test_exact_additive_package_is_accepted_without_cloud_or_execution(self):
  before,p=package();self.assertIs(module.validate_package(p),p);self.assertTrue(module.validate_additive(before,p));self.assertEqual(before['revision'],7)
 def test_no_provider_source_or_destructive_write_can_be_hidden(self):
  for key in ['newReels','providers','deletions','sourceAnalysisWrites']:
   before,p=package();p[key]=True
   with self.assertRaises(ValueError):module.validate_package(p)
  before,p=package();p['writes'][0]['path']='videos/reel01'
  with self.assertRaises(ValueError):module.validate_package(p)
 def test_unreviewed_member_and_more_than_three_groups_rejected(self):
  for mutate in [lambda p:p['affectedIds'].append('other01'),lambda p:p.update(groupIds=['a','b','c','d'])]:
   before,p=package();mutate(p)
   with self.assertRaises(ValueError):module.validate_package(p)
 def test_existing_and_manual_nodes_are_preserved(self):
  before,p=package();p['writes'][0]['data']['nodes'][0]['name']='Changed'
  with self.assertRaises(ValueError):module.validate_additive(before,p)
 def test_extra_category_or_unrelated_taxonomy_field_rejected(self):
  before,p=package();p['writes'][0]['data']['nodes'].append({'id':'hidden','parentId':None})
  with self.assertRaises(ValueError):module.validate_additive(before,p)
  before,p=package();p['writes'][0]['data']['unrelated']=True
  with self.assertRaises(ValueError):module.validate_additive(before,p)
 def test_assignment_cannot_remove_original_or_add_unreviewed_category(self):
  before,p=package();p['writes'][0]['data']['assignments'][0]['categoryIds']=['ctx_one']
  with self.assertRaises(ValueError):module.validate_additive(before,p)
  before,p=package();p['writes'][0]['data']['assignments'][0]['categoryIds'].append('hidden')
  with self.assertRaises(ValueError):module.validate_additive(before,p)
 def test_automatic_rule_cannot_be_generalized(self):
  before,p=package();p['writes'][0]['data']['rules'][0]['generalizationAllowed']=True
  with self.assertRaises(ValueError):module.validate_additive(before,p)
 def test_report_only_records_insufficiency_without_taxonomy_write(self):
  before,p=package();p['groupIds']=[];p['affectedIds']=[];p['writes']=p['writes'][1:];p['writes'][0]['data']['report']['groups']=[]
  self.assertIs(module.validate_package(p),p);self.assertTrue(module.validate_additive(before,p))
 def test_firestore_roundtrip_preserves_metrics_unknowns_and_source_refs(self):
  value={'unknown':None,'negative':False,'counts':[1,2],'metrics':{'precision':1.0,'source':'key@generation'}}
  self.assertEqual(module.decode(module.encode(value)),value)
if __name__=='__main__':unittest.main()
