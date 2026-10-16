import {workerRuntime} from './worker-runtime.mjs';

// The role is supplied by the entrypoint, never by a delivered task.
export function transcriptionRuntime(config,preset,{withHandler=true}={}){
  return workerRuntime(config,preset,{withHandler,stage:'transcription'});
}
