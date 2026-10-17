import {hash,canonical,nowISO,fail,key,identifier,ensure,cas,event} from './reels-runtime.mjs';
import {queueOutbox} from './reels-runtime.mjs';
import {projectReel,stageName} from './reels-model.mjs';
import {executionId,STAGES} from './reels-pipeline.mjs';
const processingTypes=new Set(['start','retry','complement']);
const retryStage=video=>stageName(video?.reels_v2?.stage??video?.error?.stage??video?.stage);
const retryable=video=>{const item=projectReel(video),error=video.reels_v2?.error??video.error;return item.status==='failed'&&item.error?.uncertain!==true&&error?.retryable!==false&&(error?.retryable===true||video.failure_confirmed===true)&&!!retryStage(video);};
export class ReelsService {
 constructor({repository,processingEnabled=false,clock=Date.now,onQueued,onCommandQueued}){this.onCommandQueued=onCommandQueued;this.onQueued=onQueued;this.repository=repository;this.store=repository.store;this.processingEnabled=processingEnabled===true;this.clock=clock;}
 async preview(selection,type='start'){if(!processingTypes.has(type))throw fail('INVALID_COMMAND','Tipo de prévia inválido.');const selected=await this.select(selection,type);const id=hash({type:'preview',commandType:type,...selected});await ensure(this.store,'reels_commands/'+id,{id,type:'preview',commandType:type,status:'preview',...selected,createdAt:nowISO(this.clock)});return {...selected,selectionToken:id};}
 async command(input,actor='authorized-user'){
  key(input.idempotencyKey);const type=input.type;if(!['start','retry','complement','pause','resume','capacity'].includes(type))throw fail('INVALID_COMMAND','Comando inválido.');
  if(processingTypes.has(type)&&!this.processingEnabled)throw fail('PROCESSING_DISABLED','Processamento real desabilitado nesta entrega.',423);
  const stage=input.stage??null;if(type==='start'&&stage&&stage!=='acquisition'||type==='complement'&&stage&&stage!=='analysis')throw fail('INVALID_STAGE','Etapa incompatível com o comando.');if(stage!==null&&!STAGES.includes(stage))throw fail('INVALID_STAGE','Etapa inválida.');
  if(type==='capacity'&&(!stage||!Number.isSafeInteger(input.concurrency)||input.concurrency<1||input.concurrency>1000))throw fail('INVALID_CAPACITY','Capacidade inválida.');
  const id=hash({actor,key:input.idempotencyKey}),path='reels_commands/'+id;
  const fingerprint=hash({type,selection:input.selection??null,selectionToken:input.selectionToken??null,stage,concurrency:input.concurrency??null});
  let saved=await this.store.get(path);
  if(saved&&saved.data.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já usada com outro comando.',409);
  if(!saved){
   let selection={ids:[],eligible:0,total:0,excluded:[]},stagePlan={};
   if(processingTypes.has(type)){if(input.selectionToken){identifier(input.selectionToken);const preview=await this.store.get('reels_commands/'+input.selectionToken);if(preview?.data.type!=='preview'||preview.data.commandType!==type)throw fail('INVALID_SELECTION','Prévia não encontrada.',404);selection=await this.select({ids:preview.data.ids},type);selection.excluded=[...(preview.data.excluded??[]),...selection.excluded];selection.total=preview.data.total;}else selection=await this.select(input.selection,type);}
   if(processingTypes.has(type))for(const reelId of selection.ids){
    const failedStage=type==='retry'?retryStage(await this.repository.raw(reelId)):null;
    if(type==='retry'&&stage&&stage!==failedStage)throw fail('INVALID_STAGE','Retry deve preservar a etapa da falha comprovada.');
    Object.defineProperty(stagePlan,reelId,{enumerable:true,value:type==='retry'?failedStage:stage??(type==='complement'?'analysis':'acquisition')});
   }
   saved=await ensure(this.store,path,{id,fingerprint,type,actor,status:'pending',selected:selection.ids??[],stagePlan,accepted:[],excluded:selection.excluded??[],cursor:0,progress:{total:selection.total??0,processed:0,accepted:0,excluded:selection.excluded?.length??0},createdAt:nowISO(this.clock),stage,concurrency:input.concurrency??null});
   if(saved.data.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já usada com outro comando.',409);
  }
  if(saved.data.status==='completed')return {operation:saved.data};
  if(processingTypes.has(type)){
   // HTTP acceptance persists membership and a durable control task only.
   // Admission is performed by bounded, authenticated control deliveries.
   try{
    if(typeof this.onCommandQueued!=='function')throw Error('Controle indisponível.');
    const receipt=await this.onCommandQueued(saved.data);
    if(receipt?.status!=='sent')throw Error('Entrega não confirmada.');
   }catch{throw Object.assign(fail('COMMAND_DISPATCH_UNCONFIRMED','Comando salvo; entrega requer retomada.',503),{operationId:id});}
   return {operation:saved.data};
  }else{
   for(const target of stage?[stage]:STAGES){const controlPath='reels_controls/'+target;await ensure(this.store,controlPath,{id:target,paused:false,desiredConcurrency:1,effectiveConcurrency:0,appliedCommands:[]});
    await cas(this.store,controlPath,data=>data.appliedCommands.includes(id)?null:{...(type==='capacity'?{desiredConcurrency:input.concurrency}:{paused:type==='pause'}),appliedCommands:[...data.appliedCommands,id],observedAt:nowISO(this.clock)});
   }
  }
  await event(this.store,{id:hash(id+':completed'),operationId:id,type:'command_completed',message:'Comando persistido.',reelId:null,stage},this.clock);
  saved=await cas(this.store,path,data=>data.status==='completed'?null:{status:'completed',completedAt:nowISO(this.clock)});
  return {operation:saved.data};
 }
 async drain({operationId,pageSize=25}){
  if(!this.processingEnabled)throw fail('PROCESSING_DISABLED','Processamento desabilitado.',423);
  if(typeof this.onQueued!=='function')throw fail('DISPATCH_UNAVAILABLE','Despacho indisponível.',503);
  identifier(operationId);if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw fail('INVALID_PAGE','Página de admissão inválida.');
  const path='reels_commands/'+operationId;let saved=await this.store.get(path);
  if(!saved||!processingTypes.has(saved.data.type))throw fail('NOT_FOUND','Comando de processamento ausente.',404);
  if(saved.data.status==='completed')return {operation:saved.data};
  const id=operationId,type=saved.data.type,selected=saved.data.selected??[],cursor=saved.data.cursor??0;
  const accepted=[],excluded=[];
   for(const reelId of selected.slice(cursor,cursor+pageSize)){
    const reel=await this.repository.raw(reelId);if(!reel){excluded.push({id:reelId,reason:'not_found'});continue;}if(reel.import_hold?.active===true){excluded.push({id:reelId,reason:'migration_hold'});continue;}
    const selectedStage=saved.data.stagePlan?.[reelId]??saved.data.stage??(type==='complement'?'analysis':type==='retry'?(reel.reels_v2?.stage??reel.stage??'acquisition'):'acquisition');
    if(!STAGES.includes(selectedStage)){excluded.push({id:reelId,reason:'invalid_stage'});continue;}
    const jobId=executionId(id,reelId,selectedStage),jobPath='reels_executions/'+jobId;
    let queued=await this.store.get(jobPath);
    if(!queued){
     let admitted=false;await cas(this.store,'videos/'+reelId,async video=>{admitted=false;const current=video.reels_v2??{},item=projectReel(video);
      if(item.importHeld)return null;
      if(current.operationId===id){admitted=true;return null;}
      {const eligible=type==='start'?item.status==='registered':type==='retry'?retryable(video)&&retryStage(video)===selectedStage&&await this.retryProof(video):item.publication.available&&item.status==='completed';if(!eligible)return null;}
      admitted=true;return {reels_v2:{...current,status:'queued',stage:selectedStage,operationId:id,executionId:jobId,updatedAt:nowISO(this.clock)}};});
     if(!admitted){excluded.push({id:reelId,reason:'concurrent_admission_or_not_eligible'});continue;}
     queued=await ensure(this.store,jobPath,{id:jobId,operationId:id,reelId,stage:selectedStage,status:'queued',attempt:1,predecessorId:null,createdAt:nowISO(this.clock)});
     await this.repository.refresh?.(reelId);
    }
    accepted.push(reelId);if(queued.data.status==='queued')await queueOutbox(this.store,queued.data,{onQueued:this.onQueued,clock:this.clock});
   }
  const nextCursor=Math.min(selected.length,cursor+pageSize);
  saved=await cas(this.store,path,data=>{
   if((data.cursor??0)!==cursor||data.status==='completed')return null;
   const acceptedIds=[...new Set([...(data.accepted??[]),...accepted])];
   const exclusions=[...new Map([...(data.excluded??[]),...excluded].map(row=>[row.id,row])).values()];
   return {status:nextCursor===selected.length?'completed':'running',cursor:nextCursor,accepted:acceptedIds,excluded:exclusions,
    progress:{total:data.progress?.total??selected.length,processed:nextCursor+Math.max(0,(data.progress?.total??selected.length)-selected.length),accepted:acceptedIds.length,excluded:exclusions.length},
    ...(nextCursor===selected.length?{completedAt:nowISO(this.clock)}:{})};
  });
  if(saved.data.status==='completed')await event(this.store,{id:hash(id+':completed'),operationId:id,type:'command_completed',message:'Admissão do comando concluída.',reelId:null,stage:saved.data.stage},this.clock);
  return {operation:saved.data};
 }
 async retryProof(video){
  const id=video.reels_v2?.executionId,operationId=video.reels_v2?.operationId;if(!id||!operationId)return false;
  const execution=(await this.store.get('reels_executions/'+id))?.data;
  return !!execution&&execution.id===id&&id===executionId(operationId,video.id,retryStage(video))&&execution.operationId===operationId&&execution.reelId===video.id&&execution.stage===retryStage(video)&&execution.status==='failed'&&typeof execution.owner==='string'&&execution.owner.length>0&&execution.error?.retryable===true&&execution.error?.uncertain!==true&&stageName(execution.error?.stage)===execution.stage&&!execution.rawResult;
 }
 async select(selection,type='start'){
  if(type==='start'){if(Array.isArray(selection?.ids)&&selection.ids.length===0)return {ids:[],eligible:0,total:0,excluded:[]};return this.repository.select(selection);}
  if(!['retry','complement'].includes(type))throw fail('INVALID_COMMAND','Comando inválido.');
  if(!selection||(!Array.isArray(selection.ids)&&selection.all!==true))throw fail('INVALID_SELECTION','Seleção inválida.');
  let ids;if(selection.all===true){ids=[];let cursor;do{const page=await this.repository.list({...selection.filters,workspace:'all',limit:100,cursor});ids.push(...page.items.map(i=>i.id));cursor=page.nextCursor;}while(cursor);}else ids=[...new Set(selection.ids.map(id=>identifier(id)))];
  const accepted=[],excluded=[];for(const id of ids){const raw=await this.repository.raw(id),item=raw?projectReel(raw):null;const allowed=item&&!item.importHeld&&(type==='retry'?retryable(raw)&&await this.retryProof(raw):item.publication.available&&item.status==='completed');if(allowed)accepted.push(id);else excluded.push({id,reason:item?.status==='uncertain'?'requires_reconciliation':item?'not_eligible':'not_found'});}
  return {ids:accepted,eligible:accepted.length,total:ids.length,excluded};
 }
 async operation(id){identifier(id);const saved=await this.store.get('reels_commands/'+id);if(!saved||saved.data.type==='preview')throw fail('NOT_FOUND','Comando não encontrado.',404);return {operation:saved.data};}
}
