import {publicationAvailable,initialReelsTaxonomy,projectReel,categoryNavigation} from './reels-model.mjs';
import {hash,nowISO,fail,key,identifier,ensure,cas} from './reels-runtime.mjs';
import {evidenceWindow} from './reels-speech-evidence.mjs';
import {preservedContentAvailable} from './reels-preserved-content.mjs';
const statePath='settings/reels_v2_taxonomy';
const recurrenceVersion=1;
const normalize=value=>value.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
// This consumes structured published evidence. It never counts words, ingredient
// lists or procedure steps as preparations, and never enriches an old analysis.
export function recipeRecurrence(raw,minConfidence=0.8){
 const context=raw?.analysis?.knowledge?.context;if(context&&context!=='recipe')return {state:'notApplicable',reason:'OTHER_KNOWLEDGE_CONTEXT'};
 const signal=raw?.analysis?.taxonomySignals;
 if(!signal)return {state:'missing',reason:'STRUCTURED_EVIDENCE_MISSING'};
 const invalid=reason=>({state:'invalid',reason});
 if(signal.version!==1||signal.complete!==true||typeof signal.parentCategoryId!=='string'||!Number.isFinite(signal.confidence)||signal.confidence<minConfidence||signal.confidence>1)return invalid('INCOMPLETE_OR_UNSUPPORTED_SIGNAL');
 if(!Array.isArray(signal.units)||!signal.units.length||signal.units.length>64||typeof raw.transcript!=='string'||!Number.isFinite(raw.duration_seconds)||raw.duration_seconds<=0)return invalid('SOURCE_OR_UNITS_MISSING');
 if(!Array.isArray(raw.transcript_words)||!raw.transcript_words.length)return invalid('TEMPORAL_PROOF_UNAVAILABLE');
 const ids=new Set(),titles=new Set(),spans=[],excerpts=new Set();
 for(const unit of signal.units){
  if(unit?.kind!=='recipe'||typeof unit.id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(unit.id)||ids.has(unit.id)||typeof unit.title!=='string'||!unit.title.trim()||unit.title.length>160||titles.has(normalize(unit.title))||!Array.isArray(unit.evidence)||!unit.evidence.length||unit.evidence.length>8)return invalid('UNITS_NOT_INDEPENDENT_RECIPES');
  ids.add(unit.id);titles.add(normalize(unit.title));
  const own=[];
  for(const proof of unit.evidence){
   if(proof?.source!=='transcript'||!Number.isFinite(proof.start_seconds)||!Number.isFinite(proof.end_seconds)||proof.start_seconds<0||proof.end_seconds<=proof.start_seconds||proof.end_seconds>raw.duration_seconds||typeof proof.excerpt!=='string'||!proof.excerpt.trim()||proof.excerpt.length>2000||!raw.transcript.includes(proof.excerpt))return invalid('SOURCE_EVIDENCE_INVALID');
   if(!evidenceWindow(raw,proof))return invalid('TEMPORAL_PROOF_INVALID');
   if(excerpts.has(proof.excerpt)||spans.some(p=>proof.start_seconds<p.end_seconds&&proof.end_seconds>p.start_seconds))return invalid('UNITS_SHARE_EVIDENCE');
   own.push(proof);
  }
  // Evidence spans may overlap inside one preparation, never across units.
  for(const proof of own){spans.push(proof);excerpts.add(proof.excerpt);}
 }
 const value=ids.size===1?'single_recipe':'recipe_collection';
 return {state:'supported',temporalVerified:true,parentCategoryId:signal.parentCategoryId,value,label:value==='single_recipe'?'Receita única':'Lista de receitas',unitIds:[...ids],confidence:signal.confidence};
}
export class ReelsTaxonomy {
 constructor({repository,clock=Date.now}){this.repository=repository;this.store=repository.store;this.clock=clock;}
 async state(){for(let attempt=0;attempt<8;attempt++){const saved=await this.store.get(statePath);if(!saved){await ensure(this.store,statePath,initialReelsTaxonomy(await this.published()));continue;}if(!saved.data.pendingOperationId)return {...saved,data:categoryNavigation(await this.published(),saved.data).taxonomy};await this.finishManualOperation(saved.data.pendingOperationId);}throw fail('TAXONOMY_BUSY','Categorias em atualização; retome a operação preservada.',503);}
 async published(){const items=[];let cursor;do{const page=await this.repository.list({limit:100,cursor,workspace:'all'});items.push(...page.items.filter(i=>i.publication?.available));cursor=page.nextCursor;}while(cursor);return items;}
 async mutate(input){
  if(input.action==='discover')return this.discover({...input,automatic:false});
  key(input.idempotencyKey);const actions=['create','rename','move','merge','reclassify','segment'];if(!actions.includes(input.action))throw fail('INVALID_ACTION','Ação inválida.');
  const saved=await this.state(),state=saved.data,operationId=hash({taxonomy:input.idempotencyKey}),fingerprint=hash({...input,preview:undefined,previewToken:undefined,confirmed:undefined});
  const receiptPath='reels_command_items/taxonomy_'+operationId,receipt=await this.store.get(receiptPath);
  if(receipt){if(receipt.data.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já utilizada.',409);if(receipt.data.status==='applying'||receipt.data.status==='completed'){await this.finishManualOperation(operationId);return {revision:(await this.store.get(statePath)).data.revision,operationId,duplicate:true};}}
  const prior=state.appliedCommands.find(x=>x.id===operationId);if(prior){if(prior.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já utilizada.',409);await this.applyAssignments(state);return {revision:state.revision,operationId,duplicate:true};}
  if(!Number.isSafeInteger(input.revision)||input.revision!==state.revision)throw fail('REVISION_CONFLICT','Categorias mudaram. Atualize a prévia.',409);
  let nodes=structuredClone(state.nodes),assignments=structuredClone(state.assignments??[]),rules=structuredClone(state.rules??[]);const items=await this.published();
  const find=id=>{identifier(id);const node=nodes.find(n=>n.id===id);if(!node)throw fail('CATEGORY_NOT_FOUND','Categoria não encontrada.',404);return node;};
  const name=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>120)throw fail('INVALID_NAME','Nome inválido.');return value.trim();};
  const parent=id=>id===null||id===undefined?null:find(id).id;let affected=[];
  if(input.action==='create'){const parentId=parent(input.parentId),label=name(input.name);if(nodes.some(n=>n.parentId===parentId&&n.name.normalize('NFKC').toLowerCase()===label.normalize('NFKC').toLowerCase()))throw fail('DUPLICATE_CATEGORY','Categoria já existe.',409);nodes.push({id:hash(operationId).slice(0,32),name:label,parentId,manual:true,evidenceCount:0});}
  if(input.action==='rename'){const node=find(input.id);node.name=name(input.name);node.manual=true;}
  if(input.action==='move'){const node=find(input.id),parentId=parent(input.parentId);let cursor=parentId;while(cursor){if(cursor===node.id)throw fail('CATEGORY_CYCLE','Movimento cria ciclo.',409);cursor=find(cursor).parentId;}node.parentId=parentId;node.manual=true;rules=rules.map(r=>r.kind==='structured_recurrence'&&r.categoryId===node.id?{...r,enabled:false,disabledReason:'MANUAL_MOVE'}:r);const members=new Map(items.map(i=>[i.id,i]));for(const row of await this.signalIndex())if(row.published)members.set(row.reelId,{id:row.reelId,categoryIds:[...new Set([...row.categoryIds,...(row.assignment?.categoryIds??[])])]});affected=[...members.values()].filter(i=>i.categoryIds.includes(node.id)).map(i=>i.id);}
  if(input.action==='merge'){const source=find(input.id),target=find(input.targetId);if(source.id===target.id)throw fail('INVALID_MERGE','Categorias iguais.');
   let cursor=target.parentId;while(cursor){if(cursor===source.id)throw fail('CATEGORY_CYCLE','União cria ciclo.',409);cursor=find(cursor).parentId;}
   const candidates=new Map(items.map(i=>[i.id,i]));for(const row of await this.signalIndex())if(row.published)candidates.set(row.reelId,{id:row.reelId,categoryIds:[...new Set([...row.categoryIds,...(row.assignment?.categoryIds??[])])]});
   affected=[...candidates.values()].filter(i=>i.categoryIds.includes(source.id)).map(i=>i.id);nodes=nodes.filter(n=>n.id!==source.id).map(n=>n.parentId===source.id?{...n,parentId:target.id}:n);rules=rules.map(r=>r.kind==='structured_recurrence'&&r.categoryId===source.id?{...r,enabled:false,disabledReason:'MANUAL_MERGE'}:r);
   for(const item of [...candidates.values()].filter(i=>affected.includes(i.id))){const categories=[...new Set(item.categoryIds.map(id=>id===source.id?target.id:id))];assignments=assignments.filter(a=>a.reelId!==item.id);assignments.push({reelId:item.id,categoryIds:categories,manual:true,revision:state.revision+1});}
  }
  if(input.action==='reclassify'){if(!Array.isArray(input.reelIds)||!input.reelIds.length||input.reelIds.length>10000||!Array.isArray(input.categoryIds)||input.categoryIds.length>100)throw fail('INVALID_SELECTION','Seleção inválida.');const categories=[...new Set(input.categoryIds.map(id=>find(id).id))];affected=[...new Set(input.reelIds.map(id=>identifier(id)))];if(affected.some(id=>!items.some(i=>i.id===id)))throw fail('NOT_PUBLISHED','Somente resultados publicados podem ser classificados.',409);assignments=assignments.filter(a=>!affected.includes(a.reelId));assignments.push(...affected.map(reelId=>({reelId,categoryIds:categories,manual:true,revision:state.revision+1})));}
  if(input.action==='segment'){
   const node=find(input.id),minSupport=input.minSupport??3,minRatio=input.minRatio??0.8;if(!Number.isSafeInteger(minSupport)||minSupport<2||minSupport>10000||typeof minRatio!=='number'||minRatio<0.5||minRatio>1)throw fail('INVALID_RULE','Parâmetros inválidos.');
   const evidence=[];for(const item of items){const raw=await this.repository.raw(item.id);if(raw?.taxonomy_override?.manual===true||assignments.some(a=>a.reelId===item.id&&a.manual))continue;const proofs=raw?.analysis?.evidence?.categories??[];const proof=proofs.find(p=>p.categoryId===node.id&&typeof p.source==='string'&&p.source&&p.confidence>=minRatio);if(proof)evidence.push(item.id);}
   if(evidence.length>=minSupport){affected=[...new Set(evidence)];const ruleId=hash({categoryId:node.id,minSupport,minRatio,version:1});if(!rules.some(r=>r.id===ruleId))rules.push({id:ruleId,version:1,categoryId:node.id,minSupport,minRatio,support:affected,createdAt:nowISO(this.clock)});for(const reelId of affected){const item=items.find(i=>i.id===reelId);assignments=assignments.filter(a=>a.reelId!==reelId);assignments.push({reelId,categoryIds:[...new Set([...item.categoryIds,node.id])],manual:false,revision:state.revision+1});}node.evidenceCount=affected.length;}
  }
  // A sibling duplicate can also be introduced by renaming or moving.
  const siblingKeys=new Set();for(const node of nodes){const k=JSON.stringify([node.parentId,node.name.normalize('NFKC').toLowerCase()]);if(siblingKeys.has(k))throw fail('DUPLICATE_CATEGORY','Categoria duplicada.',409);siblingKeys.add(k);}
  const previewToken=hash({fingerprint,revision:state.revision,affected}),preview={action:input.action,affected:affected.length,ids:affected,requiresReview:affected.length>1,revision:state.revision};
  if(input.preview===true)return {preview,previewToken};
  if(affected.length>1&&(input.confirmed!==true||input.previewToken!==previewToken))throw fail('PREVIEW_REQUIRED','Revise a prévia antes de aplicar a mudança ampla.',409);
  await ensure(this.store,receiptPath,{id:operationId,kind:'taxonomy_manual',status:'pending',fingerprint,createdAt:nowISO(this.clock)});
  for(const assignment of assignments)await ensure(this.store,'reels_command_items/taxonomy_assignment_'+hash({operationId,reelId:assignment.reelId}),{kind:'taxonomy_manual_assignment',operationId,status:'pending',assignment});
  const updated=await this.store.patch(statePath,{revision:state.revision+1,nodes,assignments:[],rules,pendingOperationId:operationId,observedAt:nowISO(this.clock)},{updateTime:saved.updateTime});
  await this.finishManualOperation(operationId);return {revision:updated.data.revision,operationId,affected:affected.length};
 }
 async finishManualOperation(operationId){
  const receiptPath='reels_command_items/taxonomy_'+operationId,receipt=await this.store.get(receiptPath);if(!receipt)throw fail('OUTBOX_MISSING','Operação de categorias requer conciliação.',503);
  const state=await this.store.get(statePath);if(state.data.pendingOperationId!==operationId&&receipt.data.status!=='applying'&&receipt.data.status!=='completed')return;
  if(receipt.data.status!=='completed'){
   await cas(this.store,receiptPath,()=>({status:'applying'}));
   if(receipt.data.kind==='taxonomy_discovery'){const indexed=await this.signalIndex();await this.applyDiscoveredAssignments(indexed.filter(r=>r.assignment?.operationId===operationId).map(r=>r.assignment),{refresh:receipt.data.automatic!==true});}
   else{let cursor;do{const page=await this.store.query('reels_command_items',{filters:[{field:'operationId',op:'eq',value:operationId}],select:['kind','operationId','status','assignment'],limit:500,cursor});
     for(const record of page.records){if(record.data.kind!=='taxonomy_manual_assignment'||record.data.status==='completed')continue;await this.applyAssignments({assignments:[record.data.assignment]});await cas(this.store,record.path,()=>({status:'completed'}));}cursor=page.nextCursor;
    }while(cursor);}
   await cas(this.store,receiptPath,()=>({status:'completed',completedAt:nowISO(this.clock)}));
  }
  await cas(this.store,statePath,data=>data.pendingOperationId===operationId?{pendingOperationId:null}:null);
 }
 async coverage(){const saved=await this.store.get(statePath);return saved?.data.discovery??{version:recurrenceVersion,observedAt:null,coverage:null,status:'not_evaluated',note:'Recorrências ainda não avaliadas. Dados antigos exigem complemento solicitado quando faltarem evidências estruturadas.'};}
 async indexPublication(raw,reelId,minConfidence){
  const item=raw?projectReel(raw):null,proof=item?.publication.available?recipeRecurrence(raw,0.5):{state:'missing',reason:'PUBLICATION_UNAVAILABLE'};
  const data={kind:'taxonomy_signal',version:recurrenceVersion,reelId,published:item?.publication.available??false,categoryIds:item?.categoryIds??[],manual:raw?.taxonomy_override?.manual===true,proof,analysisKey:raw?.analysis_key??null,analysisGeneration:raw?.analysis_generation??null,observedAt:nowISO(this.clock)};
  if(proof.state==='supported'){const proofHash=hash({temporalEvidenceVersion:1,reelId,analysisKey:data.analysisKey,analysisGeneration:data.analysisGeneration,unitIds:proof.unitIds});await ensure(this.store,'reels_index/taxonomy_proof_'+proofHash,{kind:'taxonomy_evidence',proofHash,reelId,analysisKey:data.analysisKey,analysisGeneration:data.analysisGeneration,proof,observedAt:data.observedAt});}
  const path='reels_index/taxonomy_'+reelId;await ensure(this.store,path,data);await cas(this.store,path,()=>data);return data;
 }
 async signalIndex(){
  const records=[];let cursor;
  do{const page=await this.store.query('reels_index',{filters:[{field:'kind',op:'eq',value:'taxonomy_signal'}],select:['kind','version','reelId','published','categoryIds','manual','proof','analysisKey','analysisGeneration','observedAt','assignment'],limit:500,cursor});records.push(...page.records.map(r=>r.data));cursor=page.nextCursor;}while(cursor);
  return records;
 }
 async applyDiscoveredAssignments(assignments,{refresh=false}={}){
  for(const assignment of assignments){
   if(assignment.manual===true)continue;
   let applied;try{applied=await cas(this.store,'videos/'+assignment.reelId,async video=>{
    if(!publicationAvailable(video)||(video.taxonomy_override?.revision??-1)>assignment.revision||video.taxonomy_override?.manual===true||video.analysis_key!==assignment.analysisKey||video.analysis_generation!==assignment.analysisGeneration)return null;
    const current=(await this.store.get(statePath)).data,c=assignment.classification;
    if(current.pendingOperationId&&current.pendingOperationId!==assignment.operationId)throw fail('TAXONOMY_BUSY','Categorias em atualização; retome a atribuição preservada.',503);
    if(c){if(c.targetCategoryId&&(!current.nodes.some(n=>n.id===c.targetCategoryId&&n.parentId===c.parentCategoryId)||!current.rules.some(r=>r.id===c.ruleId&&r.enabled!==false&&r.categoryId===c.targetCategoryId)))return null;
     if((c.supersededRuleIds??[]).some(id=>!current.rules.some(r=>r.id===id&&r.enabled!==false)))return null;}
    return {categoryIds:assignment.categoryIds,taxonomy_override:{manual:false,revision:assignment.revision}};
   });}catch(error){if(error.status===404)continue;throw error;}
   const path='reels_index/taxonomy_'+assignment.reelId;if(await this.store.get(path))await cas(this.store,path,row=>({categoryIds:projectReel(applied.data).categoryIds,manual:applied.data.taxonomy_override?.manual===true,...(row.assignment?.operationId===assignment.operationId?{assignment:null}:{})}));
   if(refresh)await this.repository.refresh?.(assignment.reelId);
  }
 }
 async discover(input={},indexPrepared=false,retry=0){
  const automatic=input.automatic===true,minSupport=input.minSupport??3,minConfidence=input.minRatio??0.8;
  if(!Number.isSafeInteger(minSupport)||minSupport<2||minSupport>10000||!Number.isFinite(minConfidence)||minConfidence<0.5||minConfidence>1)throw fail('INVALID_RULE','Parâmetros inválidos.');
  if(automatic&&(! /^[a-f0-9]{64}$/.test(input.sourceExecutionId??'')||typeof input.sourceReelId!=='string'))throw fail('INVALID_EXECUTION','Publicação de origem obrigatória.');
  if(automatic)identifier(input.sourceReelId);
  if(!automatic)key(input.idempotencyKey);
  if(input.id!==undefined&&input.id!==null)identifier(input.id);
  const operationId=hash(automatic?{taxonomyDiscovery:input.sourceExecutionId}:{taxonomy:input.idempotencyKey});
  const backfillLimit=input.backfillLimit??500;if(!Number.isSafeInteger(backfillLimit)||backfillLimit<1||backfillLimit>500)throw fail('INVALID_LIMIT','Backfill limitado a500publicações por operação.');
  if(input.backfillCursor!==undefined)identifier(input.backfillCursor);
  const fingerprint=hash({action:'discover',automatic,parentId:input.id??null,minSupport,minConfidence,version:recurrenceVersion,sourceReelId:input.sourceReelId??null,backfillLimit,backfillCursor:input.backfillCursor??null});
  const receiptPath='reels_command_items/taxonomy_'+operationId;
  const saved=await this.state(),state=saved.data,receipt=automatic?await ensure(this.store,receiptPath,{id:operationId,kind:'taxonomy_discovery',automatic,status:'pending',fingerprint,createdAt:nowISO(this.clock)}):await this.store.get(receiptPath);
  const prior=receipt&&['applying','completed'].includes(receipt.data.status)?receipt.data:(!automatic?(state.appliedCommands??[]).find(x=>x.id===operationId):null);
  if(receipt&&receipt.data.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já utilizada.',409);
  if(prior){if(prior.fingerprint!==fingerprint)throw fail('IDEMPOTENCY_CONFLICT','Chave já utilizada.',409);if(receipt)await this.finishManualOperation(operationId);return {operationId,revision:state.revision,duplicate:true,...await this.coverage()};}
  if(!automatic&&input.revision!==state.revision)throw fail('REVISION_CONFLICT','Categorias mudaram. Atualize a prévia.',409);
  let nodes=structuredClone(state.nodes),rules=structuredClone(state.rules??[]),assignments=structuredClone(state.assignments??[]);
  if(input.id&&!nodes.some(n=>n.id===input.id))throw fail('CATEGORY_NOT_FOUND','Categoria não encontrada.',404);
  let totalPublished=null,pendingBackfill=null,nextBackfillCursor=null;
  if(automatic){if(!indexPrepared)await this.indexPublication(await this.repository.raw(input.sourceReelId),input.sourceReelId,minConfidence);}
  else{
   const published=(await this.published()).filter(i=>!input.id||i.categoryIds.includes(input.id)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);totalPublished=published.length;
   const remaining=published.filter(i=>!input.backfillCursor||i.id>input.backfillCursor),batch=remaining.slice(0,backfillLimit);
   // Explicit preview may prepare a derived index, but never changes categories,
   // dispatches work or calls providers. The fixed preview still gates writes.
   for(const item of batch)await this.indexPublication(await this.repository.raw(item.id),item.id,minConfidence);
   pendingBackfill=Math.max(0,remaining.length-batch.length);nextBackfillCursor=pendingBackfill?batch.at(-1)?.id??null:null;
  }
  const indexed=await this.signalIndex(),groups=new Map(),coverage={published:indexed.filter(i=>i.published).length,totalPublished,pendingBackfill,nextBackfillCursor,considered:0,supported:0,missing:0,invalid:0,notApplicable:0,manual:0,complementRequired:[],source:'validated-publication-index'};
  for(const row of indexed){
   if(!row.published)continue;const item={id:row.reelId,categoryIds:row.categoryIds};
   if(input.id&&!item.categoryIds.includes(input.id))continue;coverage.considered++;
   if(row.manual===true||assignments.some(a=>a.reelId===item.id&&a.manual)){coverage.manual++;continue;}
   const proof=row.proof;
   if(proof.state!=='supported'){coverage[proof.state]++;if(proof.state!=='notApplicable')coverage.complementRequired.push({id:item.id,reason:proof.reason});continue;}
   if(proof.temporalVerified!==true){coverage.invalid++;coverage.complementRequired.push({id:item.id,reason:'TEMPORAL_PROOF_UNAVAILABLE'});continue;}
   if(proof.confidence<minConfidence){coverage.invalid++;coverage.complementRequired.push({id:item.id,reason:'CONFIDENCE_BELOW_POLICY'});continue;}
   if(!nodes.some(n=>n.id===proof.parentCategoryId)||!item.categoryIds.includes(proof.parentCategoryId)||input.id&&proof.parentCategoryId!==input.id){coverage.invalid++;coverage.complementRequired.push({id:item.id,reason:'PARENT_NOT_PUBLISHED'});continue;}
   coverage.supported++;
   const signature=hash({version:recurrenceVersion,parentId:proof.parentCategoryId,dimension:'recipe_structure',value:proof.value});
   if(!groups.has(signature))groups.set(signature,{signature,parentId:proof.parentCategoryId,value:proof.value,label:proof.label,support:new Map()});
   groups.get(signature).support.set(item.id,{item,proof,analysisKey:row.analysisKey,analysisGeneration:row.analysisGeneration});
  }
  const affected=new Set(),proposals=[],suppressed=[],newAssignments=[];
  // Existing categories remain usable below the creation threshold, while their
  // evidence counters reflect this observation instead of the former cohort.
  rules=rules.map(rule=>{if(rule.kind!=='structured_recurrence'||rule.enabled===false)return rule;
   const group=[...groups.values()].find(g=>g.parentId===rule.parentCategoryId&&g.value===rule.value),support=group?[...group.support.keys()].sort():[];
   const evidence=support.map(reelId=>{const entry=group.support.get(reelId);return {reelId,proofHash:hash({temporalEvidenceVersion:1,reelId,analysisKey:entry.analysisKey,analysisGeneration:entry.analysisGeneration,unitIds:entry.proof.unitIds})};});
   const node=nodes.find(n=>n.id===rule.categoryId);if(node){node.evidenceCount=support.length;node.evidenceObservedAt=nowISO(this.clock);}
   return {...rule,support,evidence,meetsMinimum:support.length>=(rule.minSupport??minSupport),evidenceStatus:'current',observedAt:nowISO(this.clock)};
  });
  // A new supported publication may invalidate its former automatic format
  // before the new format itself reaches the minimum population threshold.
  for(const group of groups.values()){
   const superseded=rules.filter(r=>r.kind==='structured_recurrence'&&r.dimension==='recipe_structure'&&r.parentCategoryId===group.parentId&&r.value!==group.value&&r.enabled!==false);
   const oldIds=new Set(superseded.map(r=>r.categoryId));
   for(const entry of group.support.values())if(entry.item.categoryIds.some(id=>oldIds.has(id))){affected.add(entry.item.id);newAssignments.push({operationId,reelId:entry.item.id,categoryIds:entry.item.categoryIds.filter(id=>!oldIds.has(id)),manual:false,revision:state.revision+1,analysisKey:entry.analysisKey,analysisGeneration:entry.analysisGeneration,classification:{parentCategoryId:group.parentId,value:group.value,targetCategoryId:null,supersededRuleIds:superseded.map(r=>r.id)}});}
  }
  for(const group of groups.values()){
   if(group.support.size<minSupport)continue;
   const ruleId=hash({recurrence:group.signature}),existingRule=rules.find(r=>r.id===ruleId);
   if(existingRule?.enabled===false){suppressed.push({signature:group.signature,reason:existingRule.disabledReason});continue;}
   const deterministicId='auto_'+group.signature.slice(0,32);
   let node=nodes.find(n=>n.id===(existingRule?.categoryId??deterministicId));
   if(node&&node.parentId!==group.parentId){suppressed.push({signature:group.signature,reason:'MANUAL_NODE_PARENT'});continue;}
   if(!node)node=nodes.find(n=>n.parentId===group.parentId&&normalize(n.name)===normalize(group.label));
   if(!node){node={id:deterministicId,parentId:group.parentId,name:group.label,manual:false,evidenceCount:group.support.size};nodes.push(node);}
   else node.evidenceCount=group.support.size;
   const support=[...group.support.keys()].sort();
   const evidence=support.map(reelId=>{const entry=group.support.get(reelId);return {reelId,proofHash:hash({temporalEvidenceVersion:1,reelId,analysisKey:entry.analysisKey,analysisGeneration:entry.analysisGeneration,unitIds:entry.proof.unitIds})};});
   const rule={id:ruleId,kind:'structured_recurrence',version:recurrenceVersion,enabled:true,parentCategoryId:group.parentId,categoryId:node.id,dimension:'recipe_structure',value:group.value,minSupport,minConfidence,support,evidence,meetsMinimum:true,evidenceStatus:'current',evidenceSource:'analysis.taxonomySignals',createdAt:existingRule?.createdAt??nowISO(this.clock),observedAt:nowISO(this.clock)};
   rules=rules.filter(r=>r.id!==ruleId);rules.push(rule);
   for(const {item}of group.support.values()){
    if(item.categoryIds.includes(node.id))continue;affected.add(item.id);
    const previous=newAssignments.find(a=>a.reelId===item.id)??assignments.find(a=>a.reelId===item.id),entry=group.support.get(item.id);
    const next={operationId,reelId:item.id,categoryIds:[...new Set([...(previous?.categoryIds??item.categoryIds),node.id])],manual:false,revision:state.revision+1,analysisKey:entry.analysisKey,analysisGeneration:entry.analysisGeneration,classification:{parentCategoryId:group.parentId,value:group.value,targetCategoryId:node.id,ruleId,supersededRuleIds:previous?.classification?.supersededRuleIds??[]}};
    const position=newAssignments.findIndex(a=>a.reelId===item.id);if(position>=0)newAssignments[position]=next;else newAssignments.push(next);
   }
   proposals.push({id:node.id,parentId:node.parentId,name:node.name,support:support.length,signature:group.signature});
  }
  const ids=[...affected].sort(),discovery={version:recurrenceVersion,status:'evaluated',observedAt:nowISO(this.clock),coverage,minSupport,minConfidence,proposals,suppressed,note:'Somente evidências estruturadas publicadas. Complemento é solicitado pela web; esta avaliação não chama modelos.'};
  const previewToken=hash({fingerprint,revision:state.revision,ids,proposals,coverage}),preview={action:'discover',affected:ids.length,ids,requiresReview:ids.length>1,revision:state.revision,proposals,coverage,suppressed};
  if(input.preview===true)return {preview,previewToken};
  if(!automatic&&ids.length>1&&(input.confirmed!==true||input.previewToken!==previewToken))throw fail('PREVIEW_REQUIRED','Revise a prévia antes de aplicar a mudança ampla.',409);
  if(!automatic)await ensure(this.store,receiptPath,{id:operationId,kind:'taxonomy_discovery',automatic,status:'pending',fingerprint,createdAt:nowISO(this.clock)});
  // Derived per-Reel outbox entries avoid a growing assignment array in the
  // settings document. They are applied only after the revision CAS succeeds.
  for(const assignment of newAssignments)await cas(this.store,'reels_index/taxonomy_'+assignment.reelId,()=>({assignment}));
  let updated;try{updated=await this.store.patch(statePath,{revision:state.revision+1,nodes,rules,discovery,pendingOperationId:operationId,observedAt:nowISO(this.clock)},{updateTime:saved.updateTime});}catch(error){if(error.status!==412)throw error;if(automatic&&retry<3)return this.discover(input,true,retry+1);throw fail('REVISION_CONFLICT','Categorias mudaram. Atualize a prévia.',409);}
  await this.finishManualOperation(operationId);
  return {operationId,revision:updated.data.revision,affected:ids.length,...discovery};
 }
 async applyAssignments(state){for(const assignment of state.assignments??[]){
  const manual=assignment.manual===true,raw=await this.repository.raw(assignment.reelId);
  if(!raw){if(manual)throw fail('CLASSIFICATION_SOURCE_CHANGED','O acervo mudou; a classificação permanece pendente de conferência.',409);continue;}
  if(!manual&&!publicationAvailable(raw))continue;
  const applied=await cas(this.store,'videos/'+assignment.reelId,async video=>{
   if(!publicationAvailable(video)){
    if(!manual)return null;
    const preserved=(await this.store.get('reels_legacy_content/'+assignment.reelId))?.data;
    // This authorizes a manual metadata edit in the web archive only. It does
    // not publish an old analysis, clear a hold, or alter processing state.
    if(!preservedContentAvailable(preserved,assignment.reelId))throw fail('CLASSIFICATION_SOURCE_CHANGED','O acervo mudou; a classificação permanece pendente de conferência.',409);
   }
   if((video.taxonomy_override?.revision??-1)>assignment.revision){
    if(manual&&(video.taxonomy_override?.manual!==true||hash(video.categoryIds??[])!==hash(assignment.categoryIds)))throw fail('CLASSIFICATION_REVISION_CONFLICT','Uma classificação mais recente foi preservada. Confira a operação pendente.',409);
    return null;
   }
   if(!manual&&video.taxonomy_override?.manual===true)return null;
   return {categoryIds:assignment.categoryIds,taxonomy_override:{manual:assignment.manual,revision:assignment.revision}};
  });
  if(publicationAvailable(applied.data))await this.indexPublication(applied.data,assignment.reelId,0.5);
  await this.repository.refresh?.(assignment.reelId);
 }}
}
