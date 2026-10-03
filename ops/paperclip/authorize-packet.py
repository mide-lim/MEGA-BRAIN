#!/usr/bin/env python3
"""Issue a bounded worker permit after conventional checks; never starts an agent."""
import argparse, json, pathlib, subprocess, hashlib, time, os, sys, fcntl
from admin_api import api
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--packet',type=pathlib.Path,required=True)
parser.add_argument('--role',choices=['worker','fix'],required=True)
parser.add_argument('--dry-run',action='store_true')
args=parser.parse_args()
repo=pathlib.Path('/srv/paperclip/workspaces/MEGA-BRAIN').resolve()
packetfile=args.packet.resolve()
if not packetfile.is_relative_to(repo/'tasks') or packetfile.suffix!='.json':
    raise SystemExit('Packet must be under the MEGA-BRAIN tasks directory')
result=subprocess.run(['python3','/opt/paperclip/packet-preflight.py','--root',str(repo),'--packet',str(packetfile)])
if result.returncode: raise SystemExit('Preflight failed; no authorization created')
raw=packetfile.read_bytes();packet=json.loads(raw)
if packet['execution_budget'][args.role+'_runs']<1:
    raise SystemExit('Packet has no budget for the selected model role; no authorization created')
if args.role=='fix' and packet['review']['status']!='changes_requested':
    raise SystemExit('Fix requires a recorded request for changes')
ids=json.loads(pathlib.Path('/opt/paperclip/pilot.json').read_text())
issue=api('issues/'+packet['paperclip_issue_id'])
if issue.get('projectId')!=ids['projectId'] or issue.get('identifier')!=packet['id']:
    raise SystemExit('Task identity/project mismatch')
if issue.get('status') not in ['backlog','todo','in_progress']:
    raise SystemExit('Task must be explicitly opened for execution')
agent=api('agents/'+ids['agentId'])
if agent.get('status')!='paused': raise SystemExit('Worker must be paused before authorization')
head=subprocess.run(['docker','exec','--user','1000:1000','--workdir','/workspaces/MEGA-BRAIN','paperclip-paperclip-1','git','rev-parse','HEAD'],check=True,capture_output=True,text=True).stdout.strip()
if head!=packet['base_commit']: raise SystemExit('Checkout must match packet base commit')
state_root=pathlib.Path('/srv/paperclip/data/pilot')
with open(state_root/'launch.lock','a') as lock:
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('Another execution is running')
    now=time.time();statefile=state_root/'launches.json';history=json.loads(statefile.read_text()) if statefile.exists() else []
    recent=[stamp for stamp in history if now-stamp<86400]
    if len(recent)>=2 or (recent and now-max(recent)<3600):raise SystemExit('Global execution limit reached')
    ledgerfile=state_root/'packet-launches.json';ledger=json.loads(ledgerfile.read_text()) if ledgerfile.exists() else []
    count=sum(1 for item in ledger if item.get('issueId')==packet['paperclip_issue_id'] and item.get('role')==args.role)
    if count>=packet['execution_budget'][args.role+'_runs']:raise SystemExit('Task role budget exhausted')
    if args.dry_run:print('Preflight passed; dry run; no permit created');raise SystemExit(0)
    permit=state_root/'allow-once'
    permission={'issueId':packet['paperclip_issue_id'],'role':args.role,'packetPath':'/workspaces/MEGA-BRAIN/'+str(packetfile.relative_to(repo)),'packetSha256':hashlib.sha256(raw).hexdigest(),'expiresAt':now+900}
    fd=os.open(permit,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as output:json.dump(permission,output)
    os.chown(permit,1000,1000)
    print('One-shot ' +args.role+ ' permit issued for '+packet['id']+'; expires in 15 minutes; agent remains paused')
