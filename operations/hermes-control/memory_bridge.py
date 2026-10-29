"""Scoped existing ai-memory MCP transport; no LLM, server or credential copies."""
import json, os, sqlite3, subprocess, time, uuid
from pathlib import Path
BASE=Path('/srv/vps-mcp/workspace/megabrain-restructure')
PROJECT=BASE/'pilot-projects/reels'

def call(name,arguments):
    assert name in {'memory_handoff_begin','memory_handoff_list','memory_handoff_accept','memory_query'}
    assert arguments.get('workspace') in {'synthetic','megabrain'}
    assert arguments.get('project') in {'reels','reels-other'}
    requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{
        'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'megabrain-hermes-control','version':'1'}}},
        {'jsonrpc':'2.0','method':'notifications/initialized'},
        {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':name,'arguments':arguments}}]
    r=subprocess.run([str(BASE/'runtime/ai-memory/isolated-ai-memory'),'mcp-bridge',
        '--no-session-id','--server-url','http://127.0.0.1:49374/mcp'],
        input='\n'.join(map(json.dumps,requests))+'\n',capture_output=True,text=True,timeout=20,
        env={'PATH':'/usr/local/bin:/usr/bin:/bin'})
    assert r.returncode==0,'MCP transport failed'
    replies={v['id']:v for v in map(json.loads,r.stdout.splitlines()) if 'id' in v}
    assert 'error' not in replies[2], 'MCP protocol error'
    result=replies[2]['result'];assert not result.get('isError'),'MCP tool error'
    return result

def wait_finalized(session_id,cwd=PROJECT,timeout=8):
    key=uuid.uuid5(uuid.NAMESPACE_OID,session_id).bytes;deadline=time.monotonic()+timeout
    while True:
        with sqlite3.connect('file:'+str(BASE/'runtime/ai-memory/data/db/memory.sqlite')+'?mode=ro',uri=True) as db:
            row=db.execute('select cwd,ended_at,ended_observation_count from sessions where id=?',(key,)).fetchone()
            count=db.execute("select count(*) from observations where session_id=? and kind='session-end'",(key,)).fetchone()[0]
        if row is not None:
            assert Path(row[0]).samefile(cwd),'Finalization project directory mismatch'
            if row[1] is not None and count>0:
                return {'session_id':session_id,'cwd':row[0],'ended_at':row[1],
                    'ended_observation_count':row[2],'session_end_observations':count}
        if time.monotonic()>=deadline:raise TimeoutError('Exact session finalization not persisted')
        time.sleep(.1)
