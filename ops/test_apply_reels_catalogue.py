"""Central-CI tests only. Synthetic Firestore transactions; no credentials/network."""
import copy, importlib.util, json, pathlib, unittest
from unittest import mock
path=pathlib.Path(__file__).with_name('apply-reels-catalogue.py')
spec=importlib.util.spec_from_file_location('catalogue_owner',path)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
H='a'*64
VERSION='2026-10-18T00:00:00.000000Z'
def package(count=3,reviews=1):
 before={'revision':12,'nodes':[{'id':'receitas','name':'Receitas','parentId':None,'manual':False},{'id':'manual','name':'Manual intacto','parentId':'receitas','manual':True}],'assignments':[{'reelId':'other01','categoryIds':['manual'],'manual':True}],'rules':[{'id':'old-rule','enabled':False}],'appliedCommands':[{'id':'prior','fingerprint':'prior'}],'pendingOperationId':None}
 after=copy.deepcopy(before);after['revision']=13
 for value,label in [('single_recipe','Receita única'),('recipe_collection','Várias receitas')]:after['nodes'].append({'id':'ctx_format_'+value,'parentId':'receitas','name':label,'kind':'catalogue_format','formatValue':value,'manual':False})
 after['appliedCommands'].append({'id':H,'fingerprint':H,'kind':'contextual_catalogue_bootstrap'})
 bindings=[];contributions=[];review_writes=[];docs={}
 for i in range(count):
  id='reel'+str(i).zfill(5);identity={'kind':'native','analysisKey':'analysis/'+id+'.json','analysisGeneration':'1'}
  binding={'reelId':id,'sourceIdentity':identity,'sourceProofHash':H,'sourceVersions':{'video':VERSION}};bindings.append(binding)
  value={'schemaVersion':1,'kind':'contextual_contribution','policyVersion':m.POLICY,'status':'active','reelId':id,'sourceIdentity':identity,'sourceProofHash':H,'sourceVersions':binding['sourceVersions'],'entry':{'id':id,'sourceIdentity':identity,'sourceProofHash':H},'contentHash':H,'idempotencyKey':H,'processingStarted':False,'providerCalls':0}
  contributions.append({'path':'reels_index/contextual_'+id,'data':value})
  docs['videos/'+id]={'id':id,'analysis_key':identity['analysisKey'],'analysis_generation':'1','analysis':{'must_not_be_read':'raw-source'}}
  if i<reviews:
   review={'schemaVersion':1,'kind':'independent_format_review','reelId':id,'sourceIdentity':identity,'sourceProofHash':H,'sourceSnapshotHash':H,'reviewer':{'kind':'independent_source_review','identity':'fixture-reviewer'},'reviewedAt':VERSION}
   wrapper={'kind':'contextual_review','reelId':id,'reviewHash':m.digest(m.canonical(review).encode()),'review':review}
   review_writes.append({'path':'reels_index/contextual_review_'+id,'data':wrapper})
 manifest={'schemaVersion':1,'status':'active','policyVersion':m.POLICY,'operationId':H,'sourceObservationSHA256':H,'sourceHash':H,'inventoryIds':[b['reelId']for b in bindings],'inventoryCount':count,'evaluatedCount':count,'observedAt':VERSION,'activatedBy':'reviewed_bootstrap','incremental':{'enabled':True,'eventDriven':True,'noProviders':True}}
 plan={'schemaVersion':1,'kind':'saved_contextual_catalogue_bootstrap','operationId':H,'sourceCommit':'b'*40,'sourceObservationSHA256':H,'policyVersion':m.POLICY,'sourceBindings':bindings,'preconditions':{'taxonomyUpdateTime':VERSION,'taxonomyRevision':12,'catalogueAbsent':True},'contributionWrites':contributions,'reviewWrites':review_writes,'settingsWrites':[{'path':m.SETTINGS[0],'data':after},{'path':m.SETTINGS[1],'data':manifest}],'sourceAnalysisWrites':False,'providers':False,'deletions':False,'newReels':False,'approvedForApply':False}
 docs[m.SETTINGS[0]]=before
 for key in ['admission','automation']:docs['settings/'+key]={'enabled':False}
 for stage in ['acquisition','transcription','analysis']:docs['reels_controls/'+stage]={'paused':True,'active':[]}
 return before,plan,docs

def doc(path,value,version=VERSION):return {'name':m.ROOT+path,'updateTime':version,'fields':{k:m.encode(v)for k,v in value.items()}}
class FakeClient:
 def __init__(self,values):
  self.docs={p:doc(p,v)for p,v in values.items()};self.transactions={};self.reads=[];self.commits=[];self.probes=0;self.sequence=0;self.on_begin=None;self.on_commit=None;self.lose_response=False;self.external_open=False
 def probe_closed(self):
  self.probes+=1
  if self.external_open:raise m.GuardError('QUEUE_OCCUPIED')
 def begin(self):
  self.sequence+=1;tx='tx'+str(self.sequence)
  if self.on_begin:self.on_begin(self,tx)
  self.transactions[tx]={'snapshot':copy.deepcopy(self.docs),'read':set()};return tx
 def rollback(self,tx):self.transactions.pop(tx,None)
 def read(self,paths,tx=None,mask=None):
  self.reads.append({'paths':list(paths),'tx':tx,'mask':mask});state=self.transactions.get(tx)if tx else None;source=state['snapshot']if state else self.docs;out={}
  for path in paths:
   if state:state['read'].add(path)
   value=copy.deepcopy(source.get(path))
   if value is not None and mask:
    fields=value['fields'];value['fields']={key:val for key,val in fields.items()if key in mask or any(field.startswith(key+'.')for field in mask)}
   out[path]=value
  return out
 def commit(self,tx,writes):
  state=self.transactions[tx]
  if self.on_commit:self.on_commit(self,tx,writes)
  for path in state['read']:
   current=self.docs.get(path);old=state['snapshot'].get(path)
   if (current or{}).get('updateTime')!=(old or{}).get('updateTime'):raise RuntimeError('transaction conflict')
  for write in writes:
   existing=self.docs.get(write['path'])
   if 'updateTime'in write:
    if not existing or existing['updateTime']!=write['updateTime']:raise RuntimeError('precondition')
   elif existing is not None:raise RuntimeError('exists')
  for write in writes:self.docs[write['path']]=doc(write['path'],copy.deepcopy(write['data']),'2026-10-18T00:01:'+str(self.sequence).zfill(2)+'.000000Z')
  self.commits.append(copy.deepcopy(writes));self.transactions.pop(tx,None)
  if self.lose_response:self.lose_response=False;raise RuntimeError('response lost')
 def change_source(self,id):
  value=m.document_data(self.docs['videos/'+id]);value['analysis_generation']='2';self.docs['videos/'+id]=doc('videos/'+id,value,'2026-10-18T00:02:00.000000Z')

class FakeClock:
 def __init__(self):self.now=0.0
 def monotonic(self):return self.now
 def advance(self,seconds):self.now+=seconds
class ScheduledProbePool:
 """Deterministic network-wave model, without sleeping or actual threads."""
 def __init__(self,clock,max_workers):self.clock=clock;self.max_workers=max_workers
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def map(self,fn,values):
  lanes=[self.clock.now]*self.max_workers;results=[]
  for value in values:
   lane=min(range(len(lanes)),key=lanes.__getitem__);self.clock.now=lanes[lane]
   results.append(fn(value));lanes[lane]=self.clock.now
  self.clock.now=max(lanes);return iter(results)
class LatencyClient(FakeClient):
 def __init__(self,values,clock):
  super().__init__(values);self.clock=clock;self.http=[];self.open_service=None
 def probe_closed(self):
  super().probe_closed();return m.GoogleClient.probe_closed(self)
 def _request(self,method,url,payload=None,params=None):
  self.clock.advance(1.1);self.http.append({'method':method,'url':url})
  if '/tasks'in url:return {}
  if 'cloudtasks.googleapis.com'in url:return {'state':'PAUSED'}
  name=url.rsplit('/',1)[-1]
  return {'reconciling':False,'terminalCondition':{'state':'CONDITION_SUCCEEDED'},'template':{'containers':[{'env':[{'name':'MEGABRAIN_REELS_CLOSED_RELEASE','value':'open'if name==self.open_service else'v2'}]}]}}
 def begin(self):self.clock.advance(0.05);return super().begin()
 def read(self,paths,tx=None,mask=None):self.clock.advance(0.45);return super().read(paths,tx,mask)
 def commit(self,tx,writes):self.clock.advance(0.1);return super().commit(tx,writes)
def staged_recovery_fixture():
 _,plan,values=package(499,8)
 # The saved499 inventory includes198 legacy primary sources:697 exact versions.
 for binding in plan['sourceBindings'][-198:]:
  id=binding['reelId'];identity={'kind':'legacy_preserved','recordHash':H,'sourceSnapshotHash':H}
  binding['sourceIdentity']=identity;binding['sourceVersions']['legacy']=VERSION
  contribution=next(w['data']for w in plan['contributionWrites']if w['data']['reelId']==id)
  contribution['sourceIdentity']=identity;contribution['entry']['sourceIdentity']=identity
  values['reels_legacy_content/'+id]={'provenance':{'recordHash':H,'sourceSnapshotHash':H}}
 for write in plan['contributionWrites']+plan['reviewWrites']:values[write['path']]=copy.deepcopy(write['data'])
 return plan,values

class CatalogueOwnerGuards(unittest.TestCase):
 def test_large_bootstrap_exceeds_500_total_but_chunks_then_atomic_settings(self):
  before,plan,values=package(499,8);client=FakeClient(values)
  result=m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(result['status'],'applied_verified');self.assertEqual(result['stagedDocuments'],507)
  self.assertEqual(len(result['chunks']),5);self.assertTrue(all(c['contributions']<=100 for c in result['chunks']))
  self.assertEqual([w['path']for w in client.commits[-1]],m.SETTINGS)
  self.assertTrue(all(w['path'].startswith('reels_index/')for commit in client.commits[:-1]for w in commit))
  self.assertTrue(all('exists'in w and w['exists']is False for commit in client.commits[:-1]for w in commit))
  self.assertEqual(m.document_data(client.docs[m.SETTINGS[1]])['inventoryCount'],499)
  self.assertEqual(m.document_data(client.docs[m.SETTINGS[0]])['assignments'],before['assignments'])
  source_reads=[r for r in client.reads if any(p.startswith('videos/')for p in r['paths'])]
  self.assertTrue(source_reads);self.assertTrue(all(r['tx']and r['mask']and 'analysis'not in r['mask']for r in source_reads))
  self.assertTrue(any(r['tx']=='tx7'for r in source_reads),'Final transaction must reread the entire source cohort')
 def test_dry_run_never_writes_and_discloses_staged_missing(self):
  _,plan,values=package(101,2);client=FakeClient(values);result=m.CatalogueBootstrap(plan,client).run()
  self.assertEqual(result['status'],'dry_run_passed');self.assertEqual(result['writes'],0);self.assertEqual(client.commits,[]);self.assertNotIn(m.SETTINGS[1],client.docs)
  self.assertEqual(result['missingDocuments'],103)
 def test_partial_staging_is_invisible_if_any_global_source_changed_before_activation(self):
  _,plan,values=package(201,2);client=FakeClient(values)
  client.on_begin=lambda c,tx:c.change_source('reel00000')if tx=='tx5'else None
  with self.assertRaisesRegex(m.GuardError,'SAVED_SOURCE_CHANGED'):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(len(client.commits),3);self.assertNotIn(m.SETTINGS[1],client.docs);self.assertEqual(m.document_data(client.docs[m.SETTINGS[0]])['revision'],12)
 def test_other_active_operation_aborts_before_any_chunk(self):
  _,plan,values=package();values[m.SETTINGS[1]]={**plan['settingsWrites'][1]['data'],'operationId':'c'*64};client=FakeClient(values)
  with self.assertRaisesRegex(m.GuardError,'CATALOGUE_ALREADY_EXISTS_OR_CHANGED'):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[])
 def test_exact_already_active_is_idempotent_only_after_all_documents_and_sources_verified(self):
  _,plan,values=package()
  for write in plan['contributionWrites']+plan['reviewWrites']+plan['settingsWrites']:values[write['path']]=copy.deepcopy(write['data'])
  client=FakeClient(values);result=m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(result['status'],'already_applied_verified');self.assertEqual(client.commits,[])
  client.change_source('reel00000')
  with self.assertRaisesRegex(m.GuardError,'SAVED_SOURCE_CHANGED'):m.CatalogueBootstrap(plan,client,True).run()
 def test_existing_identical_staged_docs_can_resume_but_newer_or_manual_document_cannot_be_overwritten(self):
  _,plan,values=package();first=plan['contributionWrites'][0];values[first['path']]=copy.deepcopy(first['data']);client=FakeClient(values)
  result=m.CatalogueBootstrap(plan,client,True).run();self.assertEqual(result['status'],'applied_verified');self.assertEqual(result['writes'],5)
  _,plan,values=package();values[first['path']]={**first['data'],'manual':True};client=FakeClient(values)
  with self.assertRaisesRegex(m.GuardError,'EXISTING_DERIVED_DOCUMENT_DIFFERS'):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[])
 def test_review_replacement_or_source_version_change_stops_create_only_transaction(self):
  _,plan,values=package();review=plan['reviewWrites'][0];values[review['path']]={**review['data'],'revoked':True};client=FakeClient(values)
  with self.assertRaisesRegex(m.GuardError,'EXISTING_DERIVED_DOCUMENT_DIFFERS'):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[])
 def test_epoch_opened_between_chunks_stops_without_deactivating_or_overwriting(self):
  _,plan,values=package(101,0);client=FakeClient(values)
  def open_epoch(c,tx):
   if tx=='tx3':c.docs[m.SETTINGS[1]]=doc(m.SETTINGS[1],{'status':'active','operationId':'c'*64})
  client.on_begin=open_epoch
  with self.assertRaises(m.GuardError):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(len(client.commits),1);self.assertEqual(m.document_data(client.docs[m.SETTINGS[1]])['operationId'],'c'*64)
 def test_ambiguous_commit_is_read_back_once_never_blindly_retried(self):
  _,plan,values=package();client=FakeClient(values);client.lose_response=True
  result=m.CatalogueBootstrap(plan,client,True).run();self.assertEqual(result['status'],'applied_verified');self.assertEqual(result['chunks'][0]['status'],'reconciled_exact_readback');self.assertEqual(len(client.commits),2)
  _,plan,values=package();client=FakeClient(values)
  client.on_commit=lambda *args:(_ for _ in ()).throw(RuntimeError('unproven'))
  with self.assertRaises(m.AmbiguousCommit):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[]);self.assertNotIn(m.SETTINGS[1],client.docs)
 def test_controls_or_external_queues_open_refuse_writes(self):
  for path,change in [('settings/admission',{'enabled':True}),('settings/automation',{'enabled':True}),('reels_controls/analysis',{'paused':True,'active':['occupied']})]:
   _,plan,values=package();values[path]=change;client=FakeClient(values)
   with self.assertRaises(m.GuardError):m.CatalogueBootstrap(plan,client,True).run()
   self.assertEqual(client.commits,[])
  _,plan,values=package();client=FakeClient(values);client.external_open=True
  with self.assertRaises(m.GuardError):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[])
 def test_atomic_source_cas_change_during_commit_leaves_manifest_absent(self):
  _,plan,values=package();client=FakeClient(values)
  client.on_commit=lambda c,tx,writes:c.change_source('reel00000')
  with self.assertRaises(m.AmbiguousCommit):m.CatalogueBootstrap(plan,client,True).run()
  self.assertNotIn(m.SETTINGS[1],client.docs)
 def test_no_source_write_provider_delete_or_unsealed_review_hidden_in_plan(self):
  for field in ['sourceAnalysisWrites','providers','deletions','newReels','approvedForApply']:
   _,plan,_=package();plan[field]=True
   with self.assertRaises(m.GuardError):m.validate_plan(plan)
  _,plan,_=package();plan['contributionWrites'][0]['path']='videos/reel00000'
  with self.assertRaises(m.GuardError):m.validate_plan(plan)
  _,plan,_=package();plan['reviewWrites'][0]['data']['review']['sourceProofHash']='c'*64
  with self.assertRaises(m.GuardError):m.validate_plan(plan)
 def test_taxonomy_preserves_manual_old_rules_assignments_and_history(self):
  for mutate in [lambda a:a['nodes'][0].update(name='changed'),lambda a:a['assignments'].clear(),lambda a:a['rules'].clear(),lambda a:a['appliedCommands'].pop(0),lambda a:a['nodes'].append({'id':'per-video-node'})]:
   before,plan,_=package();after=plan['settingsWrites'][0]['data'];mutate(after)
   with self.assertRaises(m.GuardError):m.validate_taxonomy(before,after,H)
 def test_exact_plan_and_script_review_binding_required(self):
  _,plan,_=package();payload=m.canonical(plan).encode();script=b'exact-owner-script'
  review={'decision':'approved_exact_catalogue_bootstrap','planSHA256':m.digest(payload),'scriptSHA256':m.digest(script),'sourceCommit':plan['sourceCommit'],'independentReviewSHA256':H,'project':m.PROJECT,'owner':m.OWNER,'settingsPaths':m.SETTINGS}
  self.assertTrue(m.validate_review(review,plan,payload,script))
  for key in ['planSHA256','scriptSHA256','sourceCommit','owner','settingsPaths']:
   bad=copy.deepcopy(review);bad[key]='different'
   with self.assertRaises(m.GuardError):m.validate_review(bad,plan,payload,script)
 def test_owner_capture_does_not_print_token_or_read_adc(self):
  outputs=[m.OWNER+'\n','(unset)\n','private-access-token\n']
  with mock.patch.object(m.subprocess,'run',side_effect=[mock.Mock(stdout=value)for value in outputs])as calls:
   self.assertEqual(m.owner_token(),'private-access-token');self.assertEqual(calls.call_count,3)
   self.assertIn('--account='+m.OWNER,calls.call_args_list[-1].args[0])
  with mock.patch.object(m.subprocess,'run',return_value=mock.Mock(stdout='wrong@example.org')):
   with self.assertRaises(m.GuardError):m.owner_token()
 def test_rest_uses_supported_transactions_not_nonexistent_write_verify(self):
  _,plan,_=package(1,0);calls=[]
  class Response:
   def __init__(self,value):self.value=value
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,*args):return json.dumps(self.value).encode()
  def respond(request,timeout):
   body=json.loads(request.data);calls.append((request.full_url,body))
   if request.full_url.endswith(':beginTransaction'):return Response({'transaction':'secret-tx'})
   if request.full_url.endswith(':batchGet'):return Response([{'missing':body['documents'][0]}])
   return Response({})
  with mock.patch.object(m.urlrequest,'urlopen',side_effect=respond):
   client=m.GoogleClient('private-token');tx=client.begin();self.assertEqual(client.read(['videos/reel00000'],tx,['id']),{'videos/reel00000':None});client.commit(tx,[{**plan['contributionWrites'][0],'exists':False}]);client.rollback(tx)
  self.assertEqual(calls[0][1],{'options':{'readWrite':{}}});self.assertEqual(calls[1][1]['transaction'],'secret-tx');self.assertEqual(calls[1][1]['mask'],{'fieldPaths':['id']});self.assertEqual(calls[2][1]['transaction'],'secret-tx');self.assertNotIn('verify',calls[2][1]['writes'][0]);self.assertEqual(calls[2][1]['writes'][0]['currentDocument'],{'exists':False})
 def test_final_verification_rejects_missing_or_modified_staged_metadata(self):
  for remove in [True,False]:
   _,plan,values=package();client=FakeClient(values)
   def damage(c,tx):
    if tx=='tx3':
     path=plan['contributionWrites'][0]['path']
     if remove:c.docs.pop(path,None)
     else:
      value=m.document_data(c.docs[path]);value['manual']=True;c.docs[path]=doc(path,value,'2026-10-18T00:03:00.000000Z')
   client.on_begin=damage
   with self.assertRaises(m.GuardError):m.CatalogueBootstrap(plan,client,True).run()
   self.assertEqual(len(client.commits),1);self.assertNotIn(m.SETTINGS[1],client.docs)
 def test_unreadable_commit_result_is_uncertain_and_never_retried(self):
  _,plan,values=package();client=FakeClient(values);original_read=client.read
  def read(paths,tx=None,mask=None):
   if tx is None:raise RuntimeError('readback unavailable')
   return original_read(paths,tx,mask)
  client.read=read;client.on_commit=lambda *args:(_ for _ in ()).throw(RuntimeError('commit unavailable'))
  with self.assertRaises(m.AmbiguousCommit):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[]);self.assertNotIn(m.SETTINGS[1],client.docs)
 def test_read_and_lock_deadline_budgets_abort_without_writes(self):
  _,plan,values=package();client=FakeClient(values)
  with mock.patch.object(m,'MAX_TX_BYTES',1):
   with self.assertRaisesRegex(m.GuardError,'TRANSACTION_READ_BUDGET'):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[])
  _,plan,values=package();client=FakeClient(values)
  with mock.patch.object(m,'MAX_TX_SECONDS',-1):
   with self.assertRaisesRegex(m.GuardError,'TRANSACTION_TIME_BUDGET'):m.CatalogueBootstrap(plan,client,True).run()
  self.assertEqual(client.commits,[])
 def test_realistic_sequential_probe_latency_stops_before_activation_send(self):
  plan,values=staged_recovery_fixture();clock=FakeClock();client=LatencyClient(values,clock);runner=m.CatalogueBootstrap(plan,client,True)
  with mock.patch.object(m.time,'monotonic',clock.monotonic),mock.patch.object(m,'READ_BATCH_SIZE',100),mock.patch.object(m,'PROBE_WORKERS',1),mock.patch.object(m,'ThreadPoolExecutor',side_effect=lambda max_workers:ScheduledProbePool(clock,max_workers)):
   with self.assertRaisesRegex(m.GuardError,'TRANSACTION_TIME_BUDGET'):runner.run()
  self.assertTrue(runner.activationPrepared);self.assertFalse(runner.activationCommitSent);self.assertFalse(runner.activationAttempted);self.assertFalse(runner.activationVerified);self.assertEqual(client.commits,[]);self.assertNotIn(m.SETTINGS[1],client.docs)
  self.assertGreater(runner.timings[-1]['elapsedSeconds'],18);self.assertEqual(runner.timings[-1]['precommitProbeSeconds'],13.2);self.assertEqual(m.failure_status(m.GuardError('TRANSACTION_TIME_BUDGET'),runner),'activation_precommit_guarded_stop')
 def test_bounded_parallel_probes_and_500_reads_recover507_with_only_settings_commit(self):
  plan,values=staged_recovery_fixture();clock=FakeClock();client=LatencyClient(values,clock);runner=m.CatalogueBootstrap(plan,client,True);before={p:copy.deepcopy(v)for p,v in client.docs.items()if p.startswith('reels_index/')}
  with mock.patch.object(m.time,'monotonic',clock.monotonic),mock.patch.object(m,'ThreadPoolExecutor',side_effect=lambda max_workers:ScheduledProbePool(clock,max_workers))as pools:
   result=runner.run()
  self.assertEqual(m.MAX_TX_SECONDS,18);self.assertEqual(m.MAX_TX_BYTES,8*1024*1024);self.assertEqual(m.READ_BATCH_SIZE,500);self.assertEqual(m.CHUNK_SIZE,100);self.assertEqual(m.PROBE_WORKERS,4)
  self.assertEqual(result['status'],'applied_verified');self.assertEqual(result['writes'],2);self.assertEqual(len(client.commits),1);self.assertEqual([w['path']for w in client.commits[0]],m.SETTINGS)
  self.assertTrue(all(chunk['newDocuments']==0 and chunk['status']=='identical_existing'for chunk in result['chunks']));self.assertEqual({p:v for p,v in client.docs.items()if p.startswith('reels_index/')},before)
  final_reads=[r for r in client.reads if r['tx']=='tx7'];self.assertEqual(sum(len(r['paths'])for r in final_reads if r['paths'][0].startswith(('videos/','reels_legacy_content/'))),697);self.assertEqual(sum(len(r['paths'])for r in final_reads if r['paths'][0].startswith('reels_index/')),507);self.assertTrue(all(len(r['paths'])<=500 for r in client.reads));self.assertEqual(len(final_reads),6)
  self.assertEqual(runner.timings[-1]['precommitProbeSeconds'],3.3);self.assertLess(runner.timings[-1]['elapsedSeconds'],18);self.assertEqual(runner.timings[-1]['readRequests'],6);self.assertLess(runner.timings[-1]['readBytes'],8*1024*1024);self.assertTrue(runner.activationCommitSent);self.assertTrue(runner.activationVerified);self.assertTrue(all(call.kwargs=={'max_workers':4}for call in pools.call_args_list))
 def test_precommit_pool_guard_failure_propagates_without_sending_commit(self):
  plan,values=staged_recovery_fixture();clock=FakeClock();client=LatencyClient(values,clock);runner=m.CatalogueBootstrap(plan,client,True);original_probe=client.probe_closed
  def probe():
   if runner.activationPrepared:client.open_service='megabrain-v0-analysis'
   return original_probe()
  client.probe_closed=probe
  with mock.patch.object(m.time,'monotonic',clock.monotonic),mock.patch.object(m,'ThreadPoolExecutor',side_effect=lambda max_workers:ScheduledProbePool(clock,max_workers)):
   with self.assertRaisesRegex(m.GuardError,'SERVICE_NOT_CLOSED'):runner.run()
  self.assertFalse(runner.activationCommitSent);self.assertFalse(runner.activationAttempted);self.assertEqual(client.commits,[]);self.assertNotIn(m.SETTINGS[1],client.docs)
 def test_sent_activation_with_unproven_ack_stays_uncertain_without_retry(self):
  _,plan,values=package()
  for write in plan['contributionWrites']+plan['reviewWrites']:values[write['path']]=copy.deepcopy(write['data'])
  client=FakeClient(values);runner=m.CatalogueBootstrap(plan,client,True)
  client.on_commit=lambda *args:(_ for _ in ()).throw(RuntimeError('ack unavailable'))
  with self.assertRaises(m.AmbiguousCommit):runner.run()
  self.assertTrue(runner.activationPrepared);self.assertTrue(runner.activationCommitSent);self.assertTrue(runner.activationAttempted);self.assertFalse(runner.activationVerified);self.assertEqual(client.commits,[]);self.assertNotIn(m.SETTINGS[1],client.docs);self.assertEqual(m.failure_status(m.AmbiguousCommit('COMMIT_NOT_PROVEN_DO_NOT_RETRY'),runner),'commit_uncertain_stop')
 def test_recovery_staged507_rechecks_source_taxonomy_and_other_manifest(self):
  for mismatch in ['source','taxonomy','manifest']:
   plan,values=staged_recovery_fixture();client=FakeClient(values)
   if mismatch=='source':client.change_source('reel00000')
   elif mismatch=='taxonomy':client.docs[m.SETTINGS[0]]=doc(m.SETTINGS[0],values[m.SETTINGS[0]],'2026-10-18T00:03:00.000000Z')
   else:client.docs[m.SETTINGS[1]]=doc(m.SETTINGS[1],{**plan['settingsWrites'][1]['data'],'operationId':'c'*64})
   with self.assertRaises(m.GuardError):m.CatalogueBootstrap(plan,client,True).run()
   self.assertEqual(client.commits,[])
 def test_probe_pool_is_bounded_and_only_reads_allowlisted_metadata(self):
  clock=FakeClock();client=LatencyClient({},clock)
  with mock.patch.object(m,'ThreadPoolExecutor',side_effect=lambda max_workers:ScheduledProbePool(clock,max_workers))as pools:client.probe_closed()
  self.assertEqual(len(client.http),12);self.assertTrue(all(row['method']=='GET'for row in client.http));self.assertEqual(len({row['url']for row in client.http}),12);self.assertEqual(pools.call_args.kwargs,{'max_workers':4});self.assertAlmostEqual(clock.now,3.3)
 def test_firestore_roundtrip_preserves_unknowns_not_fake_zeroes(self):
  value={'unknown':None,'count':499,'supported':False,'metrics':[1.0,0.2],'source':{'key':'source@generation'}}
  self.assertEqual(m.decode(m.encode(value)),value)

if __name__=='__main__':unittest.main()
