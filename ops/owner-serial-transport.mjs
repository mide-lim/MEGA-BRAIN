import {GoogleREST} from '../google-v0/lib/google-rest.mjs';

// Explicit owner-only Node --import preload. The seven reviewed sources remain
// byte-identical; this changes transport concurrency only, never requests,
// provider policy, transactions, guards, persistence or retries.
const marker=Symbol.for('megabrain.owner.serial-google-request.v1');
export function installOwnerSerialTransport(){
 const prototype=GoogleREST.prototype;
 if(Object.hasOwn(prototype,marker))return false;
 const descriptor=Object.getOwnPropertyDescriptor(prototype,'request');
 if(typeof descriptor?.value!=='function')throw Error('Reviewed GoogleREST request method is unavailable.');
 const original=descriptor.value;
 let tail=Promise.resolve();
 function request(...args){
  const receiver=this;
  // GoogleREST.request resolves after response.json()/body consumption. Await
  // that complete promise, not just fetch headers, across every API instance.
  const result=tail.then(()=>Reflect.apply(original,receiver,args));
  // Preserve the exact caller rejection, free the queue, and NEVER retry.
  tail=result.then(()=>undefined,()=>undefined);
  return result;
 }
 Object.defineProperty(prototype,'request',{...descriptor,value:request});
 Object.defineProperty(prototype,marker,{value:true});
 return true;
}
installOwnerSerialTransport();
