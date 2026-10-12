"""Inspect actual CLI parsing and real fixture MCP guards; never invoke a model."""
import base64,json,os,subprocess,tomllib,urllib.request,urllib.error
from pathlib import Path
from urllib.parse import urlparse
config=tomllib.loads((Path(os.environ["CODEX_HOME"])/"config.toml").read_text())
names={"paperclip-projects":"projects","paperclip-connections":"connections"}
servers={}
for name,kind in names.items():
    server=config["mcp_servers"][name]
    assert "headers" not in server, "Obsolete MCP header field"
    header=server["http_headers"]["Authorization"]
    assert header.startswith("Bearer ")
    parsed=subprocess.run(["/usr/local/bin/codex","mcp","get",name,"--json"],capture_output=True,text=True,check=True)
    transport=json.loads(parsed.stdout)["transport"]
    assert transport["http_headers"]["Authorization"]==header, "CLI dropped Authorization"
    url=server["url"]; target=urlparse(url)
    assert target.scheme=="http" and target.hostname=="127.0.0.1" and target.port==3100
    assert target.path in ["/api/mcp/project-tools","/api/mcp/runtime-tools"]
    servers[kind]={"url":url,"authorization":header}
token=servers["projects"]["authorization"][7:]
part=token.split(".")[1]
claims=json.loads(base64.urlsafe_b64decode(part+"="*((-len(part))%4)))
env=dict(os.environ)
env["PAPERCLIP_AGENT_JWT_SECRET"]="synthetic-mcp-fixture-secret-only"
env["PAPERCLIP_HOME"]="/paperclip"
mint=subprocess.run(["node","--import","/app/server/node_modules/tsx/dist/loader.mjs","/tmp/mint-fixture-tokens.mjs"],input=json.dumps(claims),env=env,capture_output=True,text=True,check=True)
negative=json.loads(mint.stdout)
def rpc(url,authorization):
    headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream"}
    if authorization is not None:headers["Authorization"]=authorization
    req=urllib.request.Request(url,data=json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}).encode(),headers=headers,method="POST")
    try:
        with urllib.request.urlopen(req,timeout=10) as response:
            return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        return error.code,None
denials=0
for kind,server in servers.items():
    status,body=rpc(server["url"],server["authorization"])
    assert status==200 and isinstance(body.get("result",{}).get("tools"),list), "Authenticated fixture tools/list failed"
    other="connections" if kind=="projects" else "projects"
    for value in [None,"Bearer invalid-synthetic-token","Bearer "+negative["expired"][kind],"Bearer "+negative["wrongRun"][kind],servers[other]["authorization"]]:
        status,_=rpc(server["url"],value)
        assert status in [401,403,404], "Fixture accepted invalid authority"
        denials+=1
result={"cliParsedServers":2,"authenticatedToolLists":2,"deniedRequests":denials,"modelCalls":0}
Path("/tmp/mcp-probe-result.json").write_text(json.dumps(result))
print("PASS fixture MCP header parsing and authentication guards")
