import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {fixedStageRuntime} from '../lib/fixed-stage-runtime.mjs';
import {workerHTTP} from '../lib/worker-http.mjs';

const stages=['upload','transcription','analysis'];
const stage=process.argv[2];
if(process.argv.length!==3||!stages.includes(stage))throw Error('Uma etapa fixa obrigatória: upload, transcription ou analysis.');
const path=process.env.MEGABRAIN_V0_WORKER_CONFIG;
if(!path||!isAbsolute(path))throw Error('Configuração própria em caminho absoluto obrigatória.');
const config=JSON.parse(await readFile(path,'utf8'));
const preset=JSON.parse(await readFile(new URL('../config/analysis-preset.json',import.meta.url),'utf8'));
const port=Number(process.env.PORT??8080);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Porta inválida.');
const server=workerHTTP(fixedStageRuntime(stage,config,preset));
server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
server.listen(port,'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close());
