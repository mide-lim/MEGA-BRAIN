"""Apply only an exact reviewed additive curation package. No provider or Reel work."""
import argparse,datetime,hashlib,json,pathlib,re,sys
PROJECT='megabrain-v0-1017370021431'
ROOT='projects/'+PROJECT+'/databases/(default)/documents/'
HASH=re.compile(r'[a-f0-9]{64}')
PATHS=['settings/reels_v2_taxonomy','settings/reels_v2_contextual_calibration']
def digest(payload):return hashlib.sha256(payload).hexdigest()
def validate_package(p):
 if p.get('schemaVersion')!=1 or p.get('kind')!='reviewed_additive_curation_metadata' or p.get('sourceAnalysisWrites')is not False or any(p.get(k)is not False for k in ['newReels','providers','deletions']) or not HASH.fullmatch(p.get('planHash',''))or p.get('operationId')!=p['planHash']:raise ValueError('Package scope differs.')
 if [w.get('path')for w in p.get('writes',[])]!=(PATHS if p.get('groupIds')else PATHS[1:]) or not 0<=len(p.get('groupIds',[]))<=3 or not 0<=len(p.get('affectedIds',[]))<=40 or len(set(p['affectedIds']))!=len(p['affectedIds']):raise ValueError('Only bounded two-document category metadata is allowed.')
 before=p['preconditions'];cal=p['writes'][-1]['data'];tax=p['writes'][0]['data']if p.get('groupIds')else None
 if (tax is not None and tax.get('revision')!=before['taxonomyRevision']+1) or cal.get('planHash')!=p['planHash']or cal.get('appliedOperationId')!=p['operationId']or cal.get('newContentAutomatic')is not False or cal.get('processingStarted')is not False:raise ValueError('Metadata identities differ.')
 if tax is not None and not any(x.get('id')==p['operationId'] and x.get('fingerprint')==p['planHash']for x in tax.get('appliedCommands',[])):raise ValueError('Durable taxonomy operation receipt is missing.')
 if not re.fullmatch(r'[a-f0-9]{40}',p.get('sourceCommit','')):raise ValueError('Committed operation source required.')
 ids={b.get('reelId')for b in before.get('sourceBindings',[])}
 if not set(p['affectedIds'])<=ids:raise ValueError('Member lacks source version binding.')
 for b in before['sourceBindings']:
  if not re.fullmatch(r'[A-Za-z0-9_-]{5,32}',b.get('reelId',''))or not b.get('sourceUpdateTime',{}).get('video'):raise ValueError('Bound saved publication version required.')
 return p
def encode(v):
 if v is None:return {'nullValue':None}
 if type(v)is bool:return {'booleanValue':v}
 if type(v)is int:return {'integerValue':str(v)}
 if type(v)is float:return {'doubleValue':v}
 if isinstance(v,str):return {'stringValue':v}
 if isinstance(v,list):return {'arrayValue':{'values':[encode(x)for x in v]}}
 if isinstance(v,dict):return {'mapValue':{'fields':{k:encode(x)for k,x in v.items()}}}
 raise ValueError('Unsupported metadata value.')
def decode(v):
 if 'mapValue'in v:return {k:decode(x)for k,x in v['mapValue'].get('fields',{}).items()}
 if 'arrayValue'in v:return [decode(x)for x in v['arrayValue'].get('values',[])]
 if 'integerValue'in v:return int(v['integerValue'])
 for k in ['stringValue','booleanValue','timestampValue','nullValue','doubleValue']:
  if k in v:return v[k]
 raise ValueError('Unsupported Firestore value.')
def data(doc):return {k:decode(v)for k,v in doc.get('fields',{}).items()}
def validate_additive(current,p):
 if not p.get('groupIds'):return True
 after=p['writes'][0]['data'];affected=set(p['affectedIds']);groups=set(p['groupIds'])
 for key,value in current.items():
  if key not in ['nodes','assignments','rules','revision','appliedCommands'] and after.get(key)!=value:raise ValueError('Unrelated taxonomy property changed.')
 oldnodes={n['id']:n for n in current.get('nodes',[])};newnodes={n['id']:n for n in after.get('nodes',[])}
 if set(newnodes)-set(oldnodes)!=groups-set(oldnodes):raise ValueError('Unexpected new category.')
 if set(after)-set(current):raise ValueError('Unexpected taxonomy property.')
 for id,node in oldnodes.items():
  if id not in newnodes or (id not in groups and newnodes[id]!=node):raise ValueError('Existing editorial node changed.')
 for node in current.get('nodes',[]):
  if node.get('manual') and newnodes[node['id']]!=node:raise ValueError('Manual node changed.')
 outside=lambda rows:[a for a in rows if a.get('reelId')not in affected]
 if outside(after.get('assignments',[]))!=outside(current.get('assignments',[])):raise ValueError('Assignment outside the finite reviewed cohort changed.')
 previous=current.get('appliedCommands',[]);commands=after.get('appliedCommands',[])
 if commands[:len(previous)]!=previous or len(commands)!=len(previous)+1 or commands[-1].get('id')!=p['operationId']:raise ValueError('Prior operation history changed.')
 for assignment in current.get('assignments',[]):
  if assignment.get('manual') or assignment.get('reelId')not in affected:
   if assignment not in after.get('assignments',[]):raise ValueError('Existing editorial assignment changed.')
 for rule in current.get('rules',[]):
  if rule not in after.get('rules',[]):raise ValueError('Existing rule changed.')
 for reelId in affected:
  memberships=[g for g in p['writes'][-1]['data']['report']['groups']if g.get('appliedCategoryId')in groups and any(m.get('id')==reelId for m in g.get('members',[]))]
  prior=set(c for g in memberships for m in g.get('members',[])if m.get('id')==reelId for c in m.get('priorCategoryIds',[]))
  expected=prior|{g['appliedCategoryId']for g in memberships}
  actual=[a for a in after.get('assignments',[])if a.get('reelId')==reelId]
  if len(actual)!=1 or actual[0].get('manual')is not False or set(actual[0].get('categoryIds',[]))!=expected:raise ValueError('Assignment is not exactly additive reviewed membership.')
  for a in current.get('assignments',[]):
   if a.get('reelId')==reelId and not set(a.get('categoryIds',[]))<=expected:raise ValueError('Existing category removed.')
 for rule in after.get('rules',[]):
  if rule not in current.get('rules',[]) and (rule.get('kind')!='calibrated_ingredient_any' or rule.get('categoryId')not in groups or rule.get('enabled')is not True or rule.get('scope')!='finite_corpus_only' or rule.get('generalizationAllowed')is not False):raise ValueError('Unbounded automatic rule.')
 for rule in after.get('rules',[]):
  if rule in current.get('rules',[]):continue
  report=[g for g in p['writes'][-1]['data']['report']['groups']if g.get('appliedCategoryId')==rule.get('categoryId')]
  expected=[{'id':m['id'],'sourceIdentity':m['sourceIdentity'],'publicationProofHash':m['publicationProofHash']}for g in report for m in g.get('members',[])]
  if len(report)!=1 or rule.get('calibrationPlanHash')!=p['planHash']or rule.get('members')!=expected or set(rule.get('memberIds',[]))!={m['id']for m in expected}:raise ValueError('Rule is not bound to exact audited source proofs.')
  for member in expected:
   assignment=next(a for a in after['assignments']if a.get('reelId')==member['id'])
   if rule['id']not in assignment.get('ruleIds',[])or assignment.get('calibrationPlanHash')!=p['planHash']:raise ValueError('Assignment lacks exact finite rule binding.')
 for id in groups:
  node=newnodes.get(id)
  if not node or node.get('manual')is not False or node.get('calibrationPlanHash')!=p['planHash']or node.get('parentId')!='receitas':raise ValueError('Group is not finite recipe curation.')
 return True
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--package',required=True);parser.add_argument('--package-sha256',required=True);parser.add_argument('--approval');parser.add_argument('--receipt',required=True);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 payload=pathlib.Path(args.package).read_bytes()
 if len(payload)>2*1024*1024 or digest(payload)!=args.package_sha256:raise ValueError('Exact package SHA256 required.')
 p=validate_package(json.loads(payload));receipt=pathlib.Path(args.receipt)
 if receipt.exists():raise ValueError('A new immutable receipt path is required.')
 if args.apply:
  approval=json.loads(pathlib.Path(args.approval).read_text())if args.approval else {}
  if approval.get('packageSHA256')!=args.package_sha256 or approval.get('scriptSHA256')!=digest(pathlib.Path(__file__).read_bytes())or approval.get('sourceCommit')!=p['sourceCommit']or not HASH.fullmatch(approval.get('independentReviewSHA256',''))or approval.get('paths')!=PATHS:raise ValueError('Independent exact-package approval is required.')
 sys.path.insert(0,'/opt/megabrain-v0-builds/release-20261004-pilot/scripts')
 from megabrain_google_auth import load_scoped_adc
 import google.auth
 from google.auth.transport.requests import AuthorizedSession
 credentials,_=google.auth.load_credentials_from_dict(load_scoped_adc('deploy'if args.apply else'read'),scopes=['https://www.googleapis.com/auth/cloud-platform'])
 session=AuthorizedSession(credentials,max_refresh_attempts=0);base='https://firestore.googleapis.com/v1/'+ROOT.rstrip('/')
 def get(url,params=None,missing=False):
  response=session.get(url,params=params,timeout=30)
  if missing and response.status_code==404:return None
  response.raise_for_status();return response.json()
 def closed():
  for key in ['admission','automation']:
   if data(get(base+'/settings/'+key,{'mask.fieldPaths':'enabled'})).get('enabled')is not False:raise ValueError('Producer is not closed.')
  for stage in ['acquisition','transcription','analysis']:
   control=data(get(base+'/reels_controls/'+stage, [('mask.fieldPaths','paused'),('mask.fieldPaths','active')]))
   if control.get('paused')is not True or control.get('active',[]):raise ValueError('Stage is not paused and empty.')
  for stage in ['acquisition','transcription','analysis','processing']:
   url='https://cloudtasks.googleapis.com/v2/projects/'+PROJECT+'/locations/us-central1/queues/v0-'+stage
   if get(url,{'fields':'state'}).get('state')!='PAUSED':raise ValueError('Queue is not paused.')
   tasks=get(url+'/tasks',{'pageSize':1,'fields':'tasks.name,nextPageToken'})
   if tasks.get('tasks')or tasks.get('nextPageToken'):raise ValueError('Queue is occupied.')
  for service in ['web','acquisition','transcription','analysis']:
   v=get('https://run.googleapis.com/v2/projects/'+PROJECT+'/locations/us-central1/services/megabrain-v0-'+service,{'fields':'template.containers.env,terminalCondition.state,reconciling'})
   if v.get('reconciling')or v.get('terminalCondition',{}).get('state')!='CONDITION_SUCCEEDED'or not any(e.get('name')=='MEGABRAIN_REELS_CLOSED_RELEASE'and e.get('value')=='v2'for e in v['template']['containers'][0].get('env',[])):raise ValueError('Service release is not closed.')
 closed();taxdoc=get(base+'/'+PATHS[0]);caldoc=get(base+'/'+PATHS[1],missing=True)
 if caldoc and data(caldoc).get('appliedOperationId')==p['operationId'] and (not p.get('groupIds')or any(x.get('id')==p['operationId']for x in data(taxdoc).get('appliedCommands',[]))):
  outcome={'status':'already_applied','operationId':p['operationId'],'writes':0}
 else:
  if caldoc is not None or taxdoc.get('updateTime')!=p['preconditions']['taxonomyUpdateTime']or data(taxdoc).get('revision')!=p['preconditions']['taxonomyRevision']:raise ValueError('Taxonomy or calibration changed; re-review required.')
  validate_additive(data(taxdoc),p)
  for b in p['preconditions']['sourceBindings']:
   doc=get(base+'/videos/'+b['reelId'],{'mask.fieldPaths':'id'})
   if doc.get('updateTime')!=b['sourceUpdateTime']['video']:raise ValueError('Saved source changed; re-review required.')
   if b['sourceUpdateTime'].get('legacy'):
    doc=get(base+'/reels_legacy_content/'+b['reelId'],{'mask.fieldPaths':'reelId'})
    if doc.get('updateTime')!=b['sourceUpdateTime']['legacy']:raise ValueError('Preserved source changed.')
  outcome={'status':'dry_run_passed','operationId':p['operationId'],'writes':0}
  if args.apply:
   closed()
   writes=[{'update':{'name':ROOT+w['path'],'fields':{k:encode(v)for k,v in w['data'].items()}},'currentDocument':{'updateTime':taxdoc['updateTime']}if w['path']==PATHS[0] else{'exists':False}}for i,w in enumerate(p['writes'])]
   try:
    response=session.post(base+':commit',json={'writes':writes},timeout=45);response.raise_for_status()
   except Exception:
    # No automatic retry of an ambiguous atomic commit. Read-back is the only
    # permitted next operation; a mismatch remains uncertain for the operator.
    pass
   after=[get(base+'/'+w['path'],missing=True)for w in p['writes']]
   if any(doc is None or data(doc)!=p['writes'][i]['data']for i,doc in enumerate(after)):raise RuntimeError('Commit not proven; do not blindly retry. Reconcile exact operation metadata.')
   closed();outcome={'status':'applied_verified','operationId':p['operationId'],'writes':len(p['writes']),'updateTimes':[doc['updateTime']for doc in after]}
 outcome.update({'sourceCommit':p['sourceCommit'],'packageSHA256':args.package_sha256,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'providers':0,'newReels':0,'deletions':0,'sourceAnalysisWrites':0,'queuesModified':0,'IAMOperations':0,'processingEnabled':False})
 with receipt.open('x')as handle:json.dump(outcome,handle,ensure_ascii=False,indent=2)
 print(json.dumps(outcome,ensure_ascii=False))
if __name__=='__main__':main()
