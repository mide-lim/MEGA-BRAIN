import {uploadRuntime} from './stage-upload.mjs';
import {transcriptionRuntime} from './stage-transcription.mjs';
import {analysisRuntime} from './stage-analysis.mjs';
import {reelsGoogleRuntime} from './reels-google-runtime.mjs';
import {reelsProcessingEnabled} from './reels-runtime-policy.mjs';
const legacy={upload:uploadRuntime,transcription:transcriptionRuntime,analysis:analysisRuntime};
const stages={upload:'acquisition',transcription:'transcription',analysis:'analysis'};
// Existing Cloud Run arguments remain compatible. Selection is server-side only.
export function fixedStageRuntime(stage,config,preset,{legacyFactories=legacy,reelsFactory=reelsGoogleRuntime}={}){
 if(!Object.hasOwn(stages,stage))throw Error('Etapa fixa inválida.');
 reelsProcessingEnabled(config);
 if(config?.reels_runtime_version==='v2')return reelsFactory(config,preset,{stage:stages[stage]});
 return legacyFactories[stage](config,preset);
}
