import {workerRuntime} from './worker-runtime.mjs';

// The executable chooses this role; task payloads cannot select another stage.
export function analysisRuntime(config,preset,{withHandler=true}={}){
  return workerRuntime(config,preset,{withHandler,stage:'analysis'});
}
