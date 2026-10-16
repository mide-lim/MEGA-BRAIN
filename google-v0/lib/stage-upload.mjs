import {workerRuntime} from './worker-runtime.mjs';

export function uploadRuntime(config,preset,{withHandler=true}={}){
  return workerRuntime(config,preset,{withHandler,stage:'upload'});
}
