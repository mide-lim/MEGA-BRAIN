"""Exact reviewed, create-only saved catalogue bootstrap. No source/provider work.

Importing this module performs no I/O. Production execution is owner Cloud Shell
only; preparation and tests belong exclusively to GitHub Actions.
"""
import argparse, datetime, hashlib, json, pathlib, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from urllib import request as urlrequest, parse as urlparse, error as urlerror

PROJECT = 'megabrain-v0-1017370021431'
OWNER = 'midelim.dev@gmail.com'
POLICY = 'saved-publication-catalogue-v1'
ROOT = 'projects/'+PROJECT+'/databases/(default)/documents/'
BASE = 'https://firestore.googleapis.com/v1/'+ROOT.rstrip('/')
SETTINGS = ['settings/reels_v2_taxonomy','settings/reels_v2_contextual_catalogue']
CONTROLS = ['settings/admission','settings/automation']+['reels_controls/'+s for s in ['acquisition','transcription','analysis']]
HASH = re.compile(r'[a-f0-9]{64}')
ID = re.compile(r'[A-Za-z0-9_-]{5,32}')
MAX_BYTES = 24*1024*1024
MAX_TX_BYTES = 8*1024*1024
MAX_TX_SECONDS = 18
CHUNK_SIZE = 100
READ_BATCH_SIZE = 500
PROBE_WORKERS = 4

class GuardError(ValueError): pass
class AmbiguousCommit(RuntimeError): pass
def need(ok, message):
 if not ok: raise GuardError(message)
def digest(payload): return hashlib.sha256(payload).hexdigest()
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)
def same(a,b): return canonical(a)==canonical(b)
def valid_time(value):
 try: return isinstance(value,str) and datetime.datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is not None
 except (ValueError,TypeError): return False
def hash_ok(value): return isinstance(value,str) and HASH.fullmatch(value) is not None
def identity_ok(value):
 if not isinstance(value,dict): return False
 if value.get('kind')=='native': return isinstance(value.get('analysisKey'),str) and bool(value['analysisKey']) and str(value.get('analysisGeneration','')).isdigit()
 return value.get('kind')=='legacy_preserved' and hash_ok(value.get('recordHash')) and hash_ok(value.get('sourceSnapshotHash'))
def encode(value):
 if value is None:return {'nullValue':None}
 if type(value)is bool:return {'booleanValue':value}
 if type(value)is int:return {'integerValue':str(value)}
 if type(value)is float:return {'doubleValue':value}
 if isinstance(value,str):return {'stringValue':value}
 if isinstance(value,list):return {'arrayValue':{'values':[encode(x)for x in value]}}
 if isinstance(value,dict):return {'mapValue':{'fields':{k:encode(v)for k,v in value.items()}}}
 raise GuardError('UNSUPPORTED_METADATA_VALUE')
def decode(value):
 if 'mapValue'in value:return {k:decode(v)for k,v in value['mapValue'].get('fields',{}).items()}
 if 'arrayValue'in value:return [decode(v)for v in value['arrayValue'].get('values',[])]
 if 'integerValue'in value:return int(value['integerValue'])
 for key in ['stringValue','booleanValue','timestampValue','nullValue','doubleValue']:
  if key in value:return value[key]
 raise GuardError('UNSUPPORTED_FIRESTORE_VALUE')
def document_data(doc):return None if doc is None else {k:decode(v)for k,v in doc.get('fields',{}).items()}
def validate_plan(plan):
 need(isinstance(plan,dict)and plan.get('schemaVersion')==1 and plan.get('kind')=='saved_contextual_catalogue_bootstrap','PLAN_KIND')
 need(all(plan.get(k)is False for k in ['sourceAnalysisWrites','providers','deletions','newReels','approvedForApply']),'PLAN_SCOPE')
 need(hash_ok(plan.get('operationId'))and re.fullmatch(r'[a-f0-9]{40}',plan.get('sourceCommit',''))and hash_ok(plan.get('sourceObservationSHA256'))and plan.get('policyVersion')==POLICY,'PLAN_IDENTITY')
 bindings=plan.get('sourceBindings',[]); writes=plan.get('contributionWrites',[]); reviews=plan.get('reviewWrites',[])
 need(isinstance(bindings,list)and 0<len(bindings)<=2000 and isinstance(writes,list)and len(writes)==len(bindings)and isinstance(reviews,list)and len(reviews)<=len(bindings),'FINITE_COUNTS')
 bound={}
 for row in bindings:
  id=row.get('reelId',''); versions=row.get('sourceVersions',{})
  need(ID.fullmatch(id)and id not in bound and identity_ok(row.get('sourceIdentity'))and hash_ok(row.get('sourceProofHash')),'SOURCE_BINDING')
  need(isinstance(versions,dict)and set(versions)<= {'video','legacy'}and valid_time(versions.get('video'))and ('legacy'not in versions or versions['legacy']is None or valid_time(versions['legacy']))and (row['sourceIdentity']['kind']!='legacy_preserved'or valid_time(versions.get('legacy'))),'SOURCE_VERSIONS')
  bound[id]=row
 paths=set(); ids=set()
 for write in writes:
  value=write.get('data',{}); id=value.get('reelId',''); binding=bound.get(id)
  need(binding is not None and id not in ids and write.get('path')=='reels_index/contextual_'+id,'CONTRIBUTION_PATH')
  need(value.get('schemaVersion')==1 and value.get('kind')=='contextual_contribution'and value.get('status')=='active'and value.get('policyVersion')==POLICY and value.get('processingStarted')is False and value.get('providerCalls')==0,'CONTRIBUTION_SCOPE')
  need(same(value.get('sourceIdentity'),binding['sourceIdentity'])and value.get('sourceProofHash')==binding['sourceProofHash']and same(value.get('sourceVersions'),binding['sourceVersions']),'CONTRIBUTION_BINDING')
  entry=value.get('entry',{})
  need(entry.get('id')==id and same(entry.get('sourceIdentity'),binding['sourceIdentity'])and entry.get('sourceProofHash')==binding['sourceProofHash']and hash_ok(value.get('contentHash'))and hash_ok(value.get('idempotencyKey')),'CONTRIBUTION_PROOF')
  need(len(canonical(value).encode())<=900000,'DOCUMENT_TOO_LARGE')
  paths.add(write['path']);ids.add(id)
 seen_reviews=set()
 for write in reviews:
  wrapper=write.get('data',{});value=wrapper.get('review',{});id=wrapper.get('reelId','');binding=bound.get(id)
  need(wrapper.get('kind')=='contextual_review'and value.get('reelId')==id and hash_ok(wrapper.get('reviewHash'))and wrapper['reviewHash']==digest(canonical(value).encode()),'REVIEW_WRAPPER_HASH')
  need(binding is not None and id not in seen_reviews and write.get('path')=='reels_index/contextual_review_'+id,'REVIEW_PATH')
  need(value.get('schemaVersion')==1 and value.get('kind')=='independent_format_review'and same(value.get('sourceIdentity'),binding['sourceIdentity'])and value.get('sourceProofHash')==binding['sourceProofHash']and hash_ok(value.get('sourceSnapshotHash')),'REVIEW_BINDING')
  need(value.get('reviewer',{}).get('kind')in ['independent_source_review','human_source_review']and bool(value.get('reviewer',{}).get('identity'))and valid_time(value.get('reviewedAt')),'REVIEW_IDENTITY')
  need(len(canonical(value).encode())<=900000,'REVIEW_TOO_LARGE')
  need(write['path']not in paths,'DUPLICATE_PATH');paths.add(write['path']);seen_reviews.add(id)
 settings=plan.get('settingsWrites',[]); pre=plan.get('preconditions',{})
 need(isinstance(settings,list)and [w.get('path')for w in settings]==SETTINGS and valid_time(pre.get('taxonomyUpdateTime'))and type(pre.get('taxonomyRevision'))is int and pre.get('catalogueAbsent')is True,'SETTINGS_PRECONDITIONS')
 after,manifest=[w.get('data',{})for w in settings]
 need(after.get('revision')==pre['taxonomyRevision']+1,'TAXONOMY_REVISION')
 need(manifest.get('schemaVersion')==1 and manifest.get('status')=='active'and manifest.get('policyVersion')==POLICY and manifest.get('operationId')==plan['operationId']and manifest.get('sourceObservationSHA256')==plan['sourceObservationSHA256']and hash_ok(manifest.get('sourceHash')),'ACTIVE_MANIFEST_BINDING')
 need(set(manifest.get('inventoryIds',[]))==set(bound)and len(manifest.get('inventoryIds',[]))==len(bound)and manifest.get('inventoryCount')==len(bound)and manifest.get('evaluatedCount')==len(bound),'MANIFEST_INVENTORY')
 need(valid_time(manifest.get('observedAt'))and manifest.get('activatedBy')=='reviewed_bootstrap'and same(manifest.get('incremental'),{'enabled':True,'eventDriven':True,'noProviders':True}),'MANIFEST_SCOPE')
 need(any(command.get('id')==plan['operationId']and command.get('fingerprint')==plan['operationId']and command.get('kind')=='contextual_catalogue_bootstrap'for command in after.get('appliedCommands',[])),'OPERATION_RECEIPT')
 need(len(canonical(plan).encode())<=MAX_BYTES,'PLAN_TOO_LARGE')
 return plan
def validate_taxonomy(before,after,operation):
 need(isinstance(before,dict)and not before.get('pendingOperationId'),'TAXONOMY_BUSY')
 need(set(after)==set(before),'TAXONOMY_KEYS')
 for key in before:
  if key not in ['revision','nodes','appliedCommands']:need(same(before[key],after[key]),'EDITORIAL_OR_RULE_CHANGED')
 old={n['id']:n for n in before.get('nodes',[])};new={n['id']:n for n in after.get('nodes',[])}
 need(len(old)==len(before.get('nodes',[]))and len(new)==len(after.get('nodes',[]))and set(old)<=set(new),'TAXONOMY_NODES')
 for id,value in old.items():need(same(value,new[id]),'EXISTING_NODE_CHANGED')
 allowed={'ctx_format_single_recipe':('single_recipe','Receita única'),'ctx_format_recipe_collection':('recipe_collection','Várias receitas')}
 need(set(new)-set(old)==set(allowed),'EXACT_TWO_FORMAT_NODES_REQUIRED')
 for id in set(new)-set(old):
  need(id in allowed,'UNEXPECTED_CATEGORY'); node=new[id]; value,label=allowed[id]
  need(node.get('parentId')=='receitas'and node.get('manual')is False and node.get('kind')=='catalogue_format'and node.get('formatValue')==value and node.get('name')==label,'FORMAT_NODE')
 previous=before.get('appliedCommands',[]);commands=after.get('appliedCommands',[])
 need(len(commands)==len(previous)+1 and same(commands[:len(previous)],previous)and commands[-1].get('id')==operation and commands[-1].get('fingerprint')==operation and commands[-1].get('kind')=='contextual_catalogue_bootstrap','HISTORY_CHANGED')
 return True
def validate_review(review,plan,plan_bytes,script_bytes):
 need(review.get('decision')=='approved_exact_catalogue_bootstrap'and review.get('planSHA256')==digest(plan_bytes)and review.get('scriptSHA256')==digest(script_bytes)and review.get('sourceCommit')==plan['sourceCommit']and hash_ok(review.get('independentReviewSHA256')),'EXACT_REVIEW_REQUIRED')
 need(review.get('project')==PROJECT and review.get('owner')==OWNER and review.get('settingsPaths')==SETTINGS,'REVIEW_SCOPE')
 return True
def batches(rows,size=CHUNK_SIZE):
 for offset in range(0,len(rows),size):yield rows[offset:offset+size]
def source_paths(bindings):
 result=[]
 for binding in bindings:
  result.append('videos/'+binding['reelId'])
  if binding['sourceVersions'].get('legacy'):result.append('reels_legacy_content/'+binding['reelId'])
 return result
def verify_sources(documents,bindings):
 for binding in bindings:
  id=binding['reelId'];video=documents.get('videos/'+id)
  need(video is not None and video.get('updateTime')==binding['sourceVersions']['video'],'SAVED_SOURCE_CHANGED')
  value=document_data(video); identity=binding['sourceIdentity']
  if identity['kind']=='native':
   need(value.get('analysis_key')==identity['analysisKey']and str(value.get('analysis_generation'))==str(identity['analysisGeneration']),'PUBLICATION_IDENTITY_CHANGED')
  if binding['sourceVersions'].get('legacy'):
   legacy=documents.get('reels_legacy_content/'+id);need(legacy is not None and legacy.get('updateTime')==binding['sourceVersions']['legacy'],'LEGACY_SOURCE_CHANGED')
   if identity['kind']=='legacy_preserved':
    provenance=document_data(legacy).get('provenance',{})
    need(provenance.get('recordHash')==identity['recordHash']and provenance.get('sourceSnapshotHash')==identity['sourceSnapshotHash'],'LEGACY_IDENTITY_CHANGED')
def verify_closed_documents(documents):
 for key in ['settings/admission','settings/automation']:need(document_data(documents.get(key))is not None and document_data(documents[key]).get('enabled')is False,'PRODUCER_OPEN')
 for stage in ['acquisition','transcription','analysis']:
  value=document_data(documents.get('reels_controls/'+stage))
  need(value is not None and value.get('paused')is True and not value.get('active',[]),'CONTROL_OPEN_OR_OCCUPIED')

class CatalogueBootstrap:
 """All staged documents remain invisible until the final active manifest."""
 def __init__(self,plan,client,apply=False):
  self.plan=validate_plan(plan);self.client=client;self.apply=apply;self.chunks=[];self.started=None;self.read_bytes=0
  self.activationPrepared=False;self.activationAttempted=False;self.activationCommitSent=False;self.activationVerified=False
  self.timings=[];self.current_timing=None;self.read_requests=0
  self.expected={w['path']:w['data']for w in plan['contributionWrites']+plan['reviewWrites']}
  self.settings={w['path']:w['data']for w in plan['settingsWrites']}
 def _read(self,paths,transaction=None,mask=None):
  out={}
  for chunk in batches(list(paths),READ_BATCH_SIZE):
   rows=self.client.read(chunk,transaction,mask);need(set(rows)==set(chunk),'INCOMPLETE_BATCH_READ')
   self.read_bytes+=len(canonical(rows).encode())
   if transaction:self.read_requests+=1;self._record_timing()
   need(self.read_bytes<=MAX_TX_BYTES,'TRANSACTION_READ_BUDGET')
   out.update(rows)
  return out
 def _record_timing(self):
  if self.current_timing is not None:
   self.current_timing.update({'elapsedSeconds':round(time.monotonic()-self.started,3),'readRequests':self.read_requests,'readBytes':self.read_bytes})
 def _start(self):
  before=time.monotonic();self.client.probe_closed();self.started=time.monotonic();self.read_bytes=0;self.read_requests=0
  self.current_timing={'ordinal':len(self.timings)+1,'preflightSeconds':round(self.started-before,3),'precommitProbeSeconds':None,'commitSent':False}
  self.timings.append(self.current_timing);return self.client.begin()
 def _deadline(self):
  self._record_timing();need(time.monotonic()-self.started<MAX_TX_SECONDS,'TRANSACTION_TIME_BUDGET')
 def _state(self,tx,allow_active=False):
  settings=self._read(SETTINGS,tx);controls=self._read(CONTROLS,tx,['enabled','paused','active']);verify_closed_documents(controls)
  tax=settings[SETTINGS[0]];manifest=settings[SETTINGS[1]]
  need(tax is not None,'TAXONOMY_MISSING')
  if manifest is not None:
   need(allow_active and same(document_data(manifest),self.settings[SETTINGS[1]])and same(document_data(tax),self.settings[SETTINGS[0]]),'CATALOGUE_ALREADY_EXISTS_OR_CHANGED')
   return settings,True
  pre=self.plan['preconditions']
  need(tax.get('updateTime')==pre['taxonomyUpdateTime']and document_data(tax).get('revision')==pre['taxonomyRevision'],'TAXONOMY_CHANGED')
  validate_taxonomy(document_data(tax),self.settings[SETTINGS[0]],self.plan['operationId'])
  return settings,False
 def _sources(self,tx,bindings):
  docs=self._read(source_paths(bindings),tx,['id','reelId','analysis_key','analysis_generation','provenance.recordHash','provenance.sourceSnapshotHash'])
  verify_sources(docs,bindings)
 def _commit(self,tx,writes,activation=False):
  before=time.monotonic()
  try:self.client.probe_closed()
  finally:
   self.current_timing['precommitProbeSeconds']=round(time.monotonic()-before,3);self._record_timing()
  # All bounded probes must have completed successfully; never move this guard
  # before them. A stop here has not sent a Firestore commit request.
  self._deadline()
  self.current_timing['commitSent']=True
  if activation:self.activationAttempted=True;self.activationCommitSent=True
  try:self.client.commit(tx,writes);self._record_timing();return 'committed'
  except Exception:
   # Never repeat an ambiguous commit. Only exact strong read-back can prove it.
   try:
    self.read_bytes=0;actual=self._read([w['path']for w in writes])
    if all(actual[w['path']]is not None and same(document_data(actual[w['path']]),w['data'])for w in writes):return 'reconciled_exact_readback'
   except Exception:pass
   raise AmbiguousCommit('COMMIT_NOT_PROVEN_DO_NOT_RETRY') from None
 def _verify_staged(self,tx,require_all):
  actual=self._read(self.expected,tx);missing=[]
  for path,expected in self.expected.items():
   if actual[path]is None:missing.append(path)
   else:need(same(document_data(actual[path]),expected),'EXISTING_DERIVED_DOCUMENT_DIFFERS')
  need(not require_all or not missing,'STAGED_DOCUMENT_MISSING')
  return missing
 def run(self):
  # First establish whether this exact operation is already active. A different
  # active manifest is never overwritten, and no blind repair follows uncertainty.
  tx=self._start()
  try:
   _,active=self._state(tx,True)
   if active:
    self._sources(tx,self.plan['sourceBindings']);self._verify_staged(tx,True);self._deadline();self.client.rollback(tx);self.client.probe_closed()
    return {'status':'already_applied_verified','stagedDocuments':len(self.expected),'writes':0,'chunks':[]}
   self.client.rollback(tx)
  except Exception:self.client.rollback(tx);raise
  reviews={w['data']['reelId']:w for w in self.plan['reviewWrites']};bindings={b['reelId']:b for b in self.plan['sourceBindings']}
  for number,group in enumerate(batches(self.plan['contributionWrites']),1):
   writes=group+[reviews[w['data']['reelId']]for w in group if w['data']['reelId']in reviews];tx=self._start()
   try:
    self._state(tx);self._sources(tx,[bindings[w['data']['reelId']]for w in group])
    current=self._read([w['path']for w in writes],tx);pending=[]
    for write in writes:
     old=current[write['path']]
     if old is None:pending.append({**write,'exists':False})
     else:need(same(document_data(old),write['data']),'EXISTING_DERIVED_DOCUMENT_DIFFERS')
    self._deadline()
    if self.apply and pending:status=self._commit(tx,pending)
    else:self.client.rollback(tx);status='identical_existing'if not pending else'dry_run_only'
    self.chunks.append({'chunk':number,'contributions':len(group),'reviews':len(writes)-len(group),'newDocuments':len(pending),'status':status})
   except Exception:self.client.rollback(tx);raise
  tx=self._start()
  try:
   state,_=self._state(tx);self._sources(tx,self.plan['sourceBindings'])
   missing=self._verify_staged(tx,self.apply);self._deadline()
   if not self.apply:
    self.client.rollback(tx);return {'status':'dry_run_passed','stagedDocuments':len(self.expected)-len(missing),'missingDocuments':len(missing),'writes':0,'chunks':self.chunks}
   writes=[{'path':SETTINGS[0],'data':self.settings[SETTINGS[0]],'updateTime':state[SETTINGS[0]]['updateTime']},{'path':SETTINGS[1],'data':self.settings[SETTINGS[1]],'exists':False}]
   self.activationPrepared=True;status=self._commit(tx,writes,activation=True)
   self.read_bytes=0;after=self._read(SETTINGS);need(all(after[p]is not None and same(document_data(after[p]),v)for p,v in self.settings.items()),'ACTIVATION_NOT_PROVEN')
   self.activationVerified=True;self.client.probe_closed()
   return {'status':'applied_verified','activationCommit':status,'stagedDocuments':len(self.expected),'writes':sum(c['newDocuments']for c in self.chunks)+2,'chunks':self.chunks}
  except Exception:self.client.rollback(tx);raise

class GoogleClient:
 def __init__(self,token):self.token=token
 def _request(self,method,url,payload=None,params=None):
  need(urlparse.urlsplit(url).hostname in ['firestore.googleapis.com','run.googleapis.com','cloudtasks.googleapis.com'],'GOOGLE_ENDPOINT_NOT_ALLOWED')
  if params:url+='?'+urlparse.urlencode(params,doseq=True)
  body=None if payload is None else canonical(payload).encode()
  request=urlrequest.Request(url,data=body,method=method,headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
  try:
   with urlrequest.urlopen(request,timeout=15)as response:raw=response.read(MAX_TX_BYTES+1)
  except urlerror.HTTPError as error:raise GuardError('GOOGLE_HTTP_'+str(error.code)) from None
  except Exception:raise GuardError('GOOGLE_REQUEST_UNCERTAIN') from None
  need(len(raw)<=MAX_TX_BYTES,'GOOGLE_RESPONSE_TOO_LARGE')
  try:return json.loads(raw)
  except ValueError:
   # batchGet may be newline-delimited JSON rather than an array.
   decoder=json.JSONDecoder();text=raw.decode();out=[]
   while text.strip():
    text=text.lstrip();value,end=decoder.raw_decode(text);out.append(value);text=text[end:]
   return out
 def begin(self):
  result=self._request('POST',BASE+':beginTransaction',{'options':{'readWrite':{}}})
  need(isinstance(result.get('transaction'),str),'TRANSACTION_MISSING');return result['transaction']
 def rollback(self,tx):
  try:self._request('POST',BASE+':rollback',{'transaction':tx})
  except Exception:pass
 def read(self,paths,tx=None,mask=None):
  payload={'documents':[ROOT+p for p in paths]}
  if tx:payload['transaction']=tx
  if mask:payload['mask']={'fieldPaths':mask}
  response=self._request('POST',BASE+':batchGet',payload);response=response if isinstance(response,list)else[response];out={}
  for row in response:
   name=row.get('found',{}).get('name')or row.get('missing')
   need(isinstance(name,str)and name.startswith(ROOT)and name[len(ROOT):]in paths and name[len(ROOT):]not in out,'UNEXPECTED_BATCH_DOCUMENT')
   out[name[len(ROOT):]]=row.get('found')
  return out
 def commit(self,tx,writes):
  body=[]
  for write in writes:
   condition={'updateTime':write['updateTime']}if'updateTime'in write else{'exists':False}
   body.append({'update':{'name':ROOT+write['path'],'fields':{k:encode(v)for k,v in write['data'].items()}},'currentDocument':condition})
  need(len(body)<=202,'WRITE_BUDGET')
  self._request('POST',BASE+':commit',{'transaction':tx,'writes':body})
 def probe_closed(self):
  # Each urllib call owns its Request/connection; this client holds only an
  # immutable token. No shared HTTP session, cookies or mutable response cache.
  targets=[('queue',s)for s in ['acquisition','transcription','analysis','processing']]+[('service',s)for s in ['web','acquisition','transcription','analysis']]
  def probe(target):
   kind,name=target
   if kind=='queue':
    url='https://cloudtasks.googleapis.com/v2/projects/'+PROJECT+'/locations/us-central1/queues/v0-'+name
    queue=self._request('GET',url,params={'fields':'state'})
    need(queue.get('state')=='PAUSED','QUEUE_NOT_PAUSED')
    tasks=self._request('GET',url+'/tasks',params={'pageSize':1,'responseView':'BASIC','fields':'tasks.name,nextPageToken'})
    need(not tasks.get('tasks')and not tasks.get('nextPageToken'),'QUEUE_OCCUPIED')
   else:
    url='https://run.googleapis.com/v2/projects/'+PROJECT+'/locations/us-central1/services/megabrain-v0-'+name
    view=self._request('GET',url,params={'fields':'template.containers.env,terminalCondition.state,reconciling'})
    need(not view.get('reconciling')and view.get('terminalCondition',{}).get('state')=='CONDITION_SUCCEEDED'and any(e.get('name')=='MEGABRAIN_REELS_CLOSED_RELEASE'and e.get('value')=='v2'for e in view.get('template',{}).get('containers',[{}])[0].get('env',[])),'SERVICE_NOT_CLOSED')
  with ThreadPoolExecutor(max_workers=PROBE_WORKERS)as pool:
   # Consume every result: a failed guard never becomes a successful preflight.
   for result in pool.map(probe,targets):pass

def owner_token():
 def capture(args):
  try:
   result=subprocess.run(['gcloud']+args,capture_output=True,text=True,check=True,timeout=30)
   return result.stdout.strip()
  except Exception:raise GuardError('OWNER_CLOUD_SHELL_AUTH_REQUIRED') from None
 account=capture(['auth','list','--filter=status:ACTIVE','--format=value(account)'])
 need(account==OWNER,'WRONG_ACTIVE_OWNER')
 impersonation=capture(['config','get-value','auth/impersonate_service_account'])
 need(impersonation in ['', '(unset)'],'IMPERSONATION_NOT_ALLOWED')
 token=capture(['auth','print-access-token','--account='+OWNER])
 need(bool(token)and '\n'not in token,'OWNER_TOKEN_UNAVAILABLE')
 return token

def failure_status(error,runner):
 if runner and runner.activationVerified:return 'activation_verified_runtime_guard_changed'
 if isinstance(error,AmbiguousCommit)or runner and runner.activationCommitSent:return 'commit_uncertain_stop'
 if runner and runner.activationPrepared:return 'activation_precommit_guarded_stop'
 return 'guarded_stop'

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--plan',required=True);parser.add_argument('--review',required=True);parser.add_argument('--result',required=True);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 output=pathlib.Path(args.result);need(not output.exists(),'NEW_RESULT_PATH_REQUIRED')
 result={'owner':OWNER,'applyRequested':args.apply,'providers':0,'newReels':0,'deletions':0,'sourceAnalysisWrites':0,'queuesModified':0,'IAMOperations':0,'processingEnabled':False}
 runner=None;failed=False
 try:
  payload=pathlib.Path(args.plan).read_bytes();need(len(payload)<=MAX_BYTES,'PLAN_TOO_LARGE')
  plan=validate_plan(json.loads(payload));review=json.loads(pathlib.Path(args.review).read_text());script=pathlib.Path(__file__).read_bytes();validate_review(review,plan,payload,script)
  result.update({'operationId':plan['operationId'],'sourceCommit':plan['sourceCommit'],'planSHA256':digest(payload),'scriptSHA256':digest(script),'sourceObservationSHA256':plan['sourceObservationSHA256']})
  runner=CatalogueBootstrap(plan,GoogleClient(owner_token()),args.apply);result.update(runner.run())
 except Exception as error:
  failed=True
  status=failure_status(error,runner)
  result.update({'status':status,'activationAttempted':runner.activationAttempted if runner else False,'activationVerified':runner.activationVerified if runner else False,'errorType':type(error).__name__,'reason':str(error)if isinstance(error,(GuardError,AmbiguousCommit))else'UNEXPECTED_ERROR_NO_RETRY','chunks':runner.chunks if runner else[]})
 if runner:result.update({'activationPrepared':runner.activationPrepared,'activationAttempted':runner.activationAttempted,'activationCommitSent':runner.activationCommitSent,'activationVerified':runner.activationVerified,'transactionTimings':runner.timings})
 result['observedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with output.open('x',encoding='utf8')as handle:json.dump(result,handle,ensure_ascii=False,indent=2)
 output.chmod(0o600);print(canonical(result))
 if failed:raise SystemExit(1)
if __name__=='__main__':main()
