"""Create an isolated server/database test. Never mount runtime data or credentials."""
import argparse, json, pathlib, subprocess, uuid, time
parser=argparse.ArgumentParser()
parser.add_argument("--image",default="paperclip-control-candidate")
args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parent
name="pc-control-test-"+uuid.uuid4().hex[:12]
network=name+"-net";database=name+"-db";server=name+"-server"
created=[]
def command(*args, **kwargs):
    return subprocess.run(list(args),check=True,capture_output=True,text=True,**kwargs).stdout
try:
    command("docker","network","create","--internal",network);created.append(("network",network))
    command("docker","run","-d","--name",database,"--network",network,"--network-alias","db",
            "-e","POSTGRES_USER=fixture","-e","POSTGRES_PASSWORD=synthetic-test-only",
            "-e","POSTGRES_DB=fixture",
            "postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652")
    created.append(("container",database))
    for attempt in range(60):
        ready=subprocess.run(["docker","exec",database,"pg_isready","-U","fixture","-d","fixture"],capture_output=True)
        if ready.returncode==0: break
        time.sleep(1)
    else: raise AssertionError("Fixture PostgreSQL did not become ready")
    # No ports are published. Trusted mode is confined to loopback inside this container.
    command("docker","run","-d","--name",server,"--network",network,
            "-e","DATABASE_URL=postgres://fixture:synthetic-test-only@db:5432/fixture",
            "-e","HOST=127.0.0.1","-e","PORT=3100","-e","PAPERCLIP_HOME=/paperclip",
            "-e","PAPERCLIP_DEPLOYMENT_MODE=local_trusted","-e","PAPERCLIP_DEPLOYMENT_EXPOSURE=private",
            "-e","PAPERCLIP_MIGRATION_AUTO_APPLY=true","-e","SERVE_UI=false",
            "--mount","type=bind,src="+str(root/"fixture-codex-pilot")+",dst=/usr/local/bin/codex-pilot,readonly",
            "--mount","type=bind,src="+str(root/"test-server-http.py")+",dst=/tmp/test-server-http.py,readonly",
            args.image)
    created.append(("container",server))
    command("docker","exec",server,"mkdir","-p","/tmp/pilot-fixture")
    output=command("docker","exec",server,"python3","/tmp/test-server-http.py",timeout=240)
    record=json.loads(output.strip().splitlines()[-1])
    # Synthetic UUID only, validated before SQL interpolation.
    aid=str(uuid.UUID(record["agentId"]))
    sql="SELECT count(*) FROM agent_wakeup_requests WHERE agent_id='"+aid+"' AND status IN ('queued','deferred');"
    pending=command("docker","exec",database,"psql","-U","fixture","-d","fixture","-Atc",sql).strip()
    assert pending=="0", "A wake request remains queued: "+pending
    record["pendingWakeRequests"]=0
    print("PASS full server/database fixture: "+json.dumps(record))
except Exception:
    # This instance contains synthetic data only; tail helps CI diagnose startup failures.
    if ("container",server) in created:
        result=subprocess.run(["docker","logs","--tail","60",server],capture_output=True,text=True)
        print(result.stdout,result.stderr)
    raise
finally:
    for kind, resource in reversed(created):
        if kind=="container":
            subprocess.run(["docker","rm","-f","-v",resource],capture_output=True)
        else:
            subprocess.run(["docker","network","rm",resource],capture_output=True)
