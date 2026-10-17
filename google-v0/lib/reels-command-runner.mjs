import {fail} from './reels-runtime.mjs';
export class ReelsCommandRunner {
 constructor({service,dispatcher,pageSize=25,enabled=false}){
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw Error('Página de controle inválida.');
  Object.assign(this,{service,dispatcher,pageSize});this.enabled=enabled===true;
 }
 async run({operationId,sequence=0}){
  if(!this.enabled)throw fail('PROCESSING_DISABLED','Processamento desabilitado.',423);
  const before=(await this.service.operation(operationId)).operation;
  if(!Number.isSafeInteger(sequence)||sequence<0||sequence>(before.cursor??0))throw fail('INVALID_CURSOR','Controle fora do cursor persistido.',409);
  // Old task redelivery may advance the current page. No promise survives HTTP.
  const {operation}=await this.service.drain({operationId,pageSize:this.pageSize});
  if(operation.status!=='completed'){
   const receipt=await this.dispatcher.enqueueControl(operation);
   if(receipt.status!=='sent')throw fail('COMMAND_DISPATCH_UNCONFIRMED','Continuação requer retomada.',503);
  }
  return {status:operation.status,operationId:operation.id,cursor:operation.cursor,progress:operation.progress};
 }
}
