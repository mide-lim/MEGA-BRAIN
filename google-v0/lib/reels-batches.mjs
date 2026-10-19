import {fail,identifier,nowISO} from './reels-runtime.mjs';
import {executionId,STAGES} from './reels-pipeline.mjs';
import {projectExecution,REEL_EXECUTION_FIELDS,reelIdPattern} from './reels-model.mjs';
const types=new Set(['start','retry','complement']);
const summary=op=>({id:op.id,type:op.type,status:op.status,createdAt:op.createdAt??null,selectedCount:Array.isArray(op.selected)?op.selected.length:0,acceptedCount:Array.isArray(op.accepted)?op.accepted.length:null,excludedCount:Array.isArray(op.excluded)?op.excluded.length:null,progress:op.progress??null});
// Read-only, bounded views. Command completion means admission, never publication.
export class ReelsBatches {
 constructor({store,clock=Date.now}){this.store=store;this.clock=clock;}
 async list({cursor}={}){
  const page=await this.store.query('reels_commands',{select:['id','type','status','createdAt','selected','accepted','excluded','progress'],orderBy:[{field:'createdAt',direction:'DESCENDING'},{field:'__name__',direction:'DESCENDING'}],limit:25,...(cursor?{cursor}:{})});
  return {items:page.records.map(r=>r.data).filter(op=>types.has(op.type)).map(summary),nextCursor:page.nextCursor??null,observedAt:nowISO(this.clock)};
 }
 async detail(id,{cursor='0'}={}){
  identifier(id);if(!/^(0|[1-9][0-9]{0,5})$/.test(String(cursor)))throw fail('INVALID_PAGE','Página de lote inválida.');
  const op=(await this.store.get('reels_commands/'+id))?.data;
  if(!op||op.id!==id||!types.has(op.type)||!Array.isArray(op.selected)||op.selected.some(x=>!reelIdPattern.test(x)))throw fail('NOT_FOUND','Lote não encontrado.',404);
  const offset=Number(cursor);if(offset>op.selected.length)throw fail('INVALID_PAGE','Página fora da seleção original.');
  const ids=op.selected.slice(offset,offset+25),paths=ids.flatMap(reelId=>STAGES.map(stage=>'reels_executions/'+executionId(id,reelId,stage)));
  const records=paths.length?typeof this.store.getMany==='function'?await this.store.getMany(paths,{select:REEL_EXECUTION_FIELDS}):await Promise.all(paths.map(async path=>{const r=await this.store.get(path);return r?{path,...r}:null;})):[];
  const byPath=new Map(records.filter(Boolean).map(r=>[r.path,r.data]));
  const counts={queued:0,running:0,waiting:0,completed:0,failed:0,uncertain:0,notStarted:0};
  const items=ids.map(reelId=>{
   const executions=STAGES.map(stage=>{const eid=executionId(id,reelId,stage),job=byPath.get('reels_executions/'+eid);return job&&job.id===eid&&job.operationId===id&&job.reelId===reelId&&job.stage===stage?projectExecution(job):null;});
   const latest=executions.filter(Boolean).at(-1),status=latest?.status??'notStarted';
   const outcome=latest?.error?.uncertain?'uncertain':['submitting','collecting','applying'].includes(status)?'running':status==='completed'&&latest?.stage!=='analysis'?'waiting':status;
   counts[outcome]=(counts[outcome]??0)+1;
   return {id:reelId,executions,status:outcome,stage:latest?.stage??null,savedQualityReview:latest?.stage==='analysis'&&latest?.error?.code==='QUALITY_VALIDATION_FAILED'&&!!latest?.resultSavedAt};
  });
  return {operation:summary(op),items,counts,countScope:'page',offset,nextCursor:offset+25<op.selected.length?String(offset+25):null,canResumeAdmission:['pending','running'].includes(op.status)&&op.admissionMode==='processing',observedAt:nowISO(this.clock)};
 }
}
