// Disposable fixture only: tokens are synthetic and never leave this process pipe.
import {createLocalAgentJwt} from '/app/server/src/agent-auth-jwt.ts';
import {createRuntimeToolsToken} from '/app/server/src/runtime-tools-token.ts';
import {randomUUID} from 'node:crypto';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const claims=JSON.parse(input);
const mint=(runId)=>({
 projects:createLocalAgentJwt(claims.sub,claims.company_id,'codex_local',runId,claims.responsible_user_id),
 connections:createRuntimeToolsToken({agentId:claims.sub,companyId:claims.company_id,runId,responsibleUserId:claims.responsible_user_id}).token,
});
const now=Date.now;
let expired;
try { Date.now=()=>now()-73*3600*1000; expired=mint(claims.run_id); }
finally { Date.now=now; }
console.log(JSON.stringify({expired,wrongRun:mint(randomUUID())}));
