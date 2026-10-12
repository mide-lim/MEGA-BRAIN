"""Run inside a disposable, loopback-only Paperclip fixture. No model credentials."""
import json, time, urllib.request
from pathlib import Path
BASE="http://127.0.0.1:3100/api/"
def api(path, body=None, method=None):
    request=urllib.request.Request(BASE+path, data=json.dumps(body).encode() if body is not None else None, method=method or ("POST" if body is not None else "GET"), headers={"Content-Type":"application/json","Origin":"http://127.0.0.1:3100"})
    with urllib.request.urlopen(request,timeout=15) as response:
        return json.load(response)
for attempt in range(120):
    try:
        api("health");break
    except Exception:
        time.sleep(1)
else:
    raise AssertionError("Fixture server did not become healthy")
company=api("companies",{"name":"Synthetic single-attempt test"})
cid=company["id"]
api("companies/"+cid,{"requireBoardApprovalForNewAgents":False},"PATCH")
heartbeat={"enabled":False,"intervalSec":0,"wakeOnDemand":False,"maxConcurrentRuns":1,"maxDailyRuns":10,"maxTurnContinuation":{"enabled":False,"maxAttempts":0}}
agent=api("companies/"+cid+"/agents",{
    "name":"Synthetic rejected pilot","adapterType":"codex_local",
    "adapterConfig":{"command":"/usr/local/bin/codex-pilot","engine":"cli","paperclipSkillProfile":"bounded-worker-v1","cwd":"/tmp/pilot-fixture","timeoutSec":30,"env":{"CODEX_HOME":{"type":"plain","value":"/tmp/pilot-fixture/codex-home"}}},
    "runtimeConfig":{"heartbeat":heartbeat},
})
aid=agent["id"]
issue=api("companies/"+cid+"/issues",{"title":"Synthetic admission rejection","description":"Exercise the rejected launcher only. No model.","status":"todo","assigneeAgentId":aid})
heartbeat["wakeOnDemand"]=True
api("agents/"+aid,{"runtimeConfig":{"heartbeat":heartbeat}},"PATCH")
wake=api("agents/"+aid+"/wakeup",{"source":"on_demand","triggerDetail":"manual","reason":"synthetic_admission_test","payload":{"issueId":issue["id"]},"forceFreshSession":True})
deadline=time.monotonic()+90
terminal=None
while time.monotonic()<deadline:
    runs=api("companies/"+cid+"/heartbeat-runs?agentId="+aid+"&limit=20")
    assert len(runs)<=1, "A successor run was created"
    if runs and runs[0]["status"] in ["failed","cancelled","timed_out","succeeded"]:
        terminal=runs[0];break
    time.sleep(1)
assert terminal is not None, "No terminal fixture run"
if terminal.get("errorCode")!="pilot_admission_rejected":
    print(api("heartbeat-runs/"+terminal["id"]+"/log").get("content","")[-4000:])
assert terminal["status"]=="failed", terminal["status"]
assert terminal["errorCode"]=="pilot_admission_rejected", (terminal.get("errorCode"), terminal.get("error"))
# Observe beyond the two upstream 30-second retry windows.
for second in range(75):
    runs=api("companies/"+cid+"/heartbeat-runs?agentId="+aid+"&limit=20")
    assert len(runs)==1, "Automatic successor run was created"
    time.sleep(1)
calls=Path("/tmp/pilot-attempts").read_text().splitlines()
assert calls==["exec"], calls
mcp=json.loads(Path("/tmp/mcp-probe-result.json").read_text())
assert mcp=={"cliParsedServers":2,"authenticatedToolLists":2,"deniedRequests":10,"modelCalls":0}
profile=json.loads(Path("/tmp/profile-probe-result.json").read_text())
assert profile["profile"]=="bounded-worker-v1" and profile["coreCharacters"]<7000
print(json.dumps({"profile":profile,"companyId":cid,"agentId":aid,"runs":1,"fakeLauncherCalls":1,"errorCode":terminal["errorCode"],"observationSeconds":75,"mcp":mcp}))
