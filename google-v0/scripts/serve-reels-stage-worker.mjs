import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {reelsGoogleRuntime} from '../lib/reels-google-runtime.mjs';
import {workerHTTP} from '../lib/worker-http.mjs';
const stage=process.argv[2];if(process.argv.length!==3||!['acquisition','transcription','analysis'].includes(stage))throw Error('Etapa fixa obrigatória.');
const path=process.env.MEGABRAIN_V0_WORKER_CONFIG;if(!path||!isAbsolute(path))throw Error('Configuração própria obrigatória.');
const config=JSON.parse(await readFile(path,'utf8'));const preset=JSON.parse(await readFile(new URL('../config/analysis-preset.json',import.meta.url),'utf8'));
const server=workerHTTP(reelsGoogleRuntime(config,preset,{stage}));const port=Number(process.env.PORT??8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Porta inválida.');server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.listen(port,'0.0.0.0');for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close());
