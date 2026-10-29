"""Root-owned, finite CLI bridge to the existing Hermes; no service or scheduler."""
import argparse, datetime as dt, fcntl, hashlib, json, os, re, sqlite3, stat, subprocess, sys
from pathlib import Path
from role_policy import OFFLINE_MODELS
BASE = Path('/srv/vps-mcp/workspace/megabrain-restructure')
ROOT = BASE / 'operations/hermes-migration'
DB = ROOT / 'dispatch.sqlite3'
USER_REQUEST = 'fb97f74ca49dd860dcaed12899a5e87399f3cc85e0df79c67d2113a3f1aac1e0'
REQUIRED = {'schema_version','task_id','project_id','objective','scope','allowed_operations',
    'prohibited_operations','context_refs','acceptance_criteria','resource_policy',
    'approval_requirements','output_contract','evidence_requirements','expires_at','authorization_ref'}
ALLOWED = {'synthetic_implementation','offline_tests','hermes_delegation','memory_handoff'}
OFFLINE_WORKSPACE=BASE/'work/hermes-migration-sprint2e'
OFFLINE_ALLOWED={'offline_repository_maintenance','offline_tests','hermes_delegation','memory_handoff'}

def is_review_only(task):
    """Only the exact reserved context reference opts into read-only review."""
    return 'review-only:true' in task.get('context_refs', [])

def workspace_mode(task, profile):
    return 'rw' if profile == 'developer' and not is_review_only(task) else 'ro'

def trusted_contract_stat(st):
    return (stat.S_ISREG(st.st_mode) and st.st_uid == 0
            and stat.S_IMODE(st.st_mode) == 0o600 and st.st_nlink == 1)

def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def digest(data): return hashlib.sha256(data).hexdigest()
def validate(task):
    if not isinstance(task,dict) or set(task)!=REQUIRED: raise ValueError('Contract fields rejected')
    if task['schema_version']!='megabrain.prompt-master.v1': raise ValueError('Version rejected')
    if not re.fullmatch(r'MB-[A-Z0-9-]{8,90}',task['task_id']): raise ValueError('Task id rejected')
    if task['project_id']!='reels': raise ValueError('Project not activated')
    if task['authorization_ref']!=USER_REQUEST: raise ValueError('Authorization absent')
    if dt.datetime.fromisoformat(task['expires_at'])<=dt.datetime.now(dt.timezone.utc):
        raise ValueError('Expired contract')
    synthetic=task['scope']=={'workspace':str(ROOT/'synthetic-workspace'),'data':'synthetic-only'}
    offline=task['scope']=={'workspace':str(OFFLINE_WORKSPACE),'data':'offline-code-only'}
    if not synthetic and not offline:raise ValueError('Scope rejected')
    if not isinstance(task['context_refs'],list) or not all(isinstance(r,str) for r in task['context_refs']):
        raise ValueError('Context references rejected')
    if is_review_only(task) and not offline:raise ValueError('Review-only requires offline scope')
    if set(task['allowed_operations'])!=(ALLOWED if synthetic else OFFLINE_ALLOWED):
        raise ValueError('Operation outside migration grant')
    if not {'real_media','google','paid_api','deploy','iam','background_services'}<=set(task['prohibited_operations']):
        raise ValueError('Required prohibitions absent')
    budget=task['resource_policy'].get('max_model_calls')
    if type(budget) is not int or budget not in ((16,) if synthetic else (32,48)):
        raise ValueError('Call budget rejected')
    if task['resource_policy']!={'model':'gpt-6-luna' if synthetic else OFFLINE_MODELS,'provider':'openai-codex',
        'max_model_calls':budget,'deadline_seconds':240 if synthetic else 600,
        'max_spawn_depth':2,'concurrency':1,'paid_fallback':False}:
        raise ValueError('Resource policy rejected')
    for k in ['objective','acceptance_criteria','context_refs','approval_requirements',
              'output_contract','evidence_requirements']:
        if not task[k]: raise ValueError('Empty '+k)
    if len(json.dumps(task))>16000: raise ValueError('Oversized contract')
    return task

def connect():
    db=sqlite3.connect(DB,isolation_level=None)
    db.execute('pragma journal_mode=WAL');db.execute('pragma synchronous=FULL')
    db.execute('create table if not exists tasks (id text primary key, sha text not null, status text not null, session text, updated text not null)')
    db.execute('create table if not exists events (id integer primary key, task text, stamp text, kind text, data text)')
    return db
def event(db,tid,kind,data):
    db.execute('insert into events(task,stamp,kind,data) values(?,?,?,?)',(tid,now(),kind,json.dumps(data)))
def load_trusted(path,expected):
    root=(ROOT/'inbox').resolve(); path=Path(path)
    if path.parent.resolve()!=root or path.is_symlink(): raise ValueError('Untrusted inbox')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        st=os.fstat(fd)
        if not trusted_contract_stat(st):
            raise ValueError('Untrusted contract ownership/mode')
        data=os.read(fd,17000)
    finally: os.close(fd)
    if digest(data)!=expected: raise ValueError('Integrity mismatch')
    return validate(json.loads(data))

def child_iterations(task):
    if task['scope']['data']=='offline-code-only':
        return 18 if task['resource_policy']['max_model_calls']==48 else 12
    return 6

def configure_scope(task):
    """Controller-only translation of admitted scope to kernel-enforced profile mounts."""
    import yaml
    workspace=Path(task['scope']['workspace'])
    offline=task['scope']['data']=='offline-code-only'
    if offline:
        import subprocess
        baseline=subprocess.check_output(['git','rev-parse','HEAD'],cwd=workspace,text=True).strip()
        if baseline!='4b16ee0f5ffd8016f3c6eef9143fda54926109cb':
            raise ValueError('Offline workspace baseline diverged; requires a new reviewed contract')
        pins=[r.split(':',1)[1] for r in task['context_refs'] if isinstance(r,str) and r.startswith('worktree-sha256:')]
        if len(pins)!=1 or pins[0]!=tree_digest(workspace):raise ValueError('Offline worktree integrity mismatch')
    home=BASE/'runtime/hermes-home'
    for name,path in [('central',home),('reels-pilot',home/'profiles/reels-pilot'),
                      ('developer',home/'profiles/developer'),('validator',home/'profiles/validator')]:
        f=path/'config.yaml';config=yaml.safe_load(f.read_text())
        model_role='reels' if name=='reels-pilot' else name
        config['model']={'default':OFFLINE_MODELS[model_role] if offline else 'gpt-6-luna','provider':'openai-codex'}
        terminal=config['terminal'];mode=workspace_mode(task,name)
        volumes=[v for v in terminal['docker_volumes'] if not v.endswith(':/workspace:rw')
            and not v.endswith(':/workspace:ro') and ':/dependencies:' not in v and ':/reference:' not in v]
        volumes.append(str(workspace)+':/workspace:'+mode)
        if offline:
            dependencies=home/'installs/dfc19c9b24c092bc/environments/0f4c31471a144c42942ac2afdfba37b6/venv/lib/python3.14/site-packages'
            if not dependencies.is_dir():raise ValueError('Reviewed dependency environment missing')
            volumes.extend([str(dependencies)+':/dependencies:ro',str(ROOT/'handoff-reference')+':/reference:ro'])
            terminal['docker_env']['PYTHONPATH']='/dependencies:/workspace'
        else:terminal['docker_env'].pop('PYTHONPATH',None)
        terminal['docker_volumes']=volumes
        if offline:
            config['delegation']['oneshot_max_children']=4
        config['delegation']['max_iterations']=child_iterations(task)
        config['delegation']['child_timeout_seconds']=420 if offline else 150
        config['agent']['run_budget_seconds']=590 if offline else 230
        assert terminal['backend']=='docker' and terminal['docker_network'] is False
        assert not terminal['docker_forward_env'] and not config['fallback_providers']
        assert config.get('approvals',{}).get('single_query_mode')!='approve'
        f.write_text(yaml.safe_dump(config,sort_keys=False))
    marker=BASE/'pilot-projects/reels/.ai-memory.toml'
    marker.write_text('workspace = '+json.dumps('megabrain' if offline else 'synthetic')+'\nproject = "reels"\n')

def tree_digest(workspace):
    import subprocess
    names=subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=workspace).split(b'\0')
    rows=[]
    for raw in sorted(set(filter(None,names))):
        rel=raw.decode();path=workspace/rel
        if path.is_symlink() or not path.resolve().is_relative_to(workspace.resolve()):
            raise ValueError('Symlink or escaped worktree path rejected')
        rows.append([rel,digest(path.read_bytes()) if path.exists() else 'deleted'])
    return digest(json.dumps(rows,separators=(',',':')).encode())

def execute(path,expected):
    task=load_trusted(path,expected);tid=task['task_id']
    with (ROOT/'profile-execution.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with connect() as db:
            db.execute('begin immediate')
            if db.execute('select 1 from tasks where id=?',(tid,)).fetchone():
                db.rollback();raise ValueError('Duplicate task; never automatically replay')
            db.execute('insert into tasks values(?,?,?,?,?)',(tid,expected,'accepted',None,now()))
            event(db,tid,'accepted',{'sha256':expected,'authority':'root-owned Desktop Commander inbox'})
            db.commit()
            run=ROOT/'runs'/tid
            try:
                run.mkdir(mode=0o700)
                (run/'contract.json').write_text(json.dumps(task,indent=2)+'\n')
                active=ROOT/'active-contract';active.mkdir(mode=0o700,exist_ok=True)
                pending=active/'prompt-master.tmp'
                pending.write_text(json.dumps(task,indent=2)+'\n');pending.replace(active/'prompt-master.json')
                db.execute('begin immediate')
                db.execute('update tasks set status=?,updated=? where id=?',('running',now(),tid))
                event(db,tid,'running',{});db.commit()
                env={k:os.environ[k] for k in ['PATH','LANG','LC_ALL','TZ'] if k in os.environ}
                env.update(HERMES_HOME=str(BASE/'runtime/hermes-home'),
                    HERMES_RUNTIME_DIR=str(BASE/'runtime/hermes-tools'),HERMES_SINGLE_QUERY_SESSION='1')
                python=BASE/'runtime/python/cpython-3.14-linux-x86_64-gnu/bin/python3'
                configure_scope(task)
                with (run/'runtime.log').open('w') as log:
                    result=subprocess.run([str(python),str(Path(__file__).resolve().with_name('hermes_runtime.py')),str(run)],
                        env=env,stdout=log,stderr=subprocess.STDOUT,timeout=task['resource_policy']['deadline_seconds']+30)
                receipt=json.loads((run/'receipt.json').read_text())
                status='completed' if result.returncode==0 and receipt.get('passed') else 'unknown'
                db.execute('begin immediate')
                db.execute('update tasks set status=?,session=?,updated=? where id=?',
                    (status,receipt.get('session_id'),now(),tid))
                event(db,tid,status,{'exit':result.returncode,'receipt':str(run/'receipt.json')})
                db.commit()
            except BaseException as exc:
                db.rollback();db.execute('begin immediate')
                status='unknown';db.execute('update tasks set status=?,updated=? where id=?',(status,now(),tid))
                event(db,tid,'interrupted',{'error_type':type(exc).__name__,'no_replay':True})
                db.commit()
                raise
            print(json.dumps({'task_id':tid,'status':status,'receipt':str(run/'receipt.json')}))
            return 0 if status=='completed' else 2

def retrieve(task_id, result=False):
    if not re.fullmatch(r'MB-[A-Z0-9-]{8,90}',task_id):raise ValueError('Task id rejected')
    with sqlite3.connect(DB.resolve().as_uri()+'?mode=ro',uri=True) as db:
        row=db.execute('select id,sha,status,session,updated from tasks where id=?',(task_id,)).fetchone()
        if row is None:raise ValueError('Unknown task')
        answer=dict(zip(('task_id','sha256','status','session_id','updated'),row))
        answer['events']=[{'stamp':stamp,'kind':kind,'data':json.loads(data)} for stamp,kind,data in
            db.execute('select stamp,kind,data from events where task=? order by id',(task_id,))]
    if result:
        path=ROOT/'runs'/task_id/'receipt.json'
        answer['receipt']=json.loads(path.read_text()) if path.is_file() else None
    return answer

def main():
    os.umask(0o077)
    p=argparse.ArgumentParser();sp=p.add_subparsers(dest='action',required=True)
    s=sp.add_parser('run');s.add_argument('path');s.add_argument('--sha256',required=True)
    s=sp.add_parser('status');s.add_argument('task_id')
    s=sp.add_parser('result');s.add_argument('task_id')
    a=p.parse_args()
    if a.action=='run':return execute(a.path,a.sha256)
    print(json.dumps(retrieve(a.task_id,result=a.action=='result')))
    return 0

if __name__=='__main__':raise SystemExit(main())
