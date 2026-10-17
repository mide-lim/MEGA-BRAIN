import {executionId} from '../lib/reels-pipeline.mjs';
// Synthetic data and CAS store for browser QA only. Never imported by the product.
export function reelsFixture(now=new Date()) {
 const at=new Date(now).toISOString(),day=at.slice(0,10);
 const registered=Array.from({length:72},(_,i)=>({id:'QaReg_'+String(i).padStart(3,'0'),title:'Entrada '+String(i).padStart(3,'0'),creator:'Autor de teste',status:'registered',stage:null,created_at:at,updated_at:at,language:'pt',tags:['entrada']}));
 const published=(id,title,category,extra={})=>({id,title,status:'analyzed',stage:null,created_at:at,updated_at:at,source_url:'https://www.instagram.com/reel/'+id+'/',creator:'Autora do acervo',language:'pt',tags:['publicado'],media_verified:true,video_key:'qa/'+id,video_generation:'1',analysis_key:'qa/'+id+'/published.json',analysis_generation:'2',analysis_quality_status:'accepted',analysis_published_at:at,categoryIds:[category],source_caption:{text:'Legenda original preservada de '+id,source:'instagram'},transcript:'Transcrição preservada de '+id,transcript_segments:[{start_seconds:0,end_seconds:2,text:'Trecho de teste preservado.'}],analysis:{title,version:'qa-v2',summary:'Resumo publicado de '+id,knowledge:{context:'Conhecimento disponível na publicação',fields:[{kind:'concept',name:'Conceito preservado',value:'Explicação consolidada e publicada.',evidence:[{source:'transcript',start_seconds:0,end_seconds:2,excerpt:'Trecho de teste preservado.'}]}],keywords:[{term:'Evidência'}],missing_information:['Local não informado.']},visual:['Quadro sintético vertical.'],insights:['Aplicação prática preservada.'],evidence:{categories:[{categoryId:category,source:'transcript',confidence:0.95}]}},...extra});
 const videos=[...registered,
  published('QaPub_tech','Modelo publicado','cat_models',{candidate_analysis_key:'qa/candidate.json',analysis_review_reasons:['Candidato separado sem substituir publicação.']}),
  published('QaPub_food','Receita publicada','cat_food'),
  {id:'QaFail_01',title:'Falha confirmada',status:'failed',failure_confirmed:true,stage:'acquisition',created_at:at,error:{code:'SOURCE_FAILED',message:'Origem exige diagnóstico.',destination:'retry',worker:'qa-worker',retryable:true}},
  {id:'QaUnknown',title:'Resultado incerto',status:'uncertain',stage:'analysis',created_at:at,error:{code:'RESULT_UNKNOWN',message:'Resposta paga ainda sem confirmação.',worker:'qa-worker',uncertain:true}},
  {id:'QaQueued',title:'Na fila de aquisição',status:'queued',stage:'acquisition',created_at:at},
  {id:'QaRunning',title:'Transcrição em curso',status:'running',stage:'transcription',created_at:at},
  {id:'QaWaiting',title:'Análise aguardando externo',status:'waiting',stage:'analysis',created_at:at}
 ];
 // A legacy recipe has published knowledge but no structural recurrence proof.
 // Technology is outside the first recipe-specific segmentation contract.
 const food=videos.find(v=>v.id==='QaPub_food');food.transcript='Use 300 g de frango. Doure na frigideira por 8 minutos. Rende 2 porções.';
 food.analysis.knowledge={context:'recipe',keywords:[{term:'Frango'}],missing_information:[],fields:[
  {kind:'ingredient',name:'Ingrediente principal',value:'300 g de frango'},
  {kind:'procedure',name:'Modo de preparo',value:'Doure na frigideira por 8 minutos.'},
  {kind:'preparation_time',name:'Tempo informado',value:'8 minutos'},
  {kind:'serving_count',name:'Rendimento informado',value:'2 porções'}
 ].map(field=>({...field,evidence:[{source:'transcript',start_seconds:0,end_seconds:14,excerpt:food.transcript}]}))};
 videos.find(v=>v.id==='QaPub_tech').analysis.knowledge.context='technology';
 const failed=videos.find(video=>video.id==='QaFail_01'),failedOperation='qa-failed-operation',failedId=executionId(failedOperation,failed.id,'acquisition');
 failed.reels_v2={status:'failed',stage:'acquisition',operationId:failedOperation,executionId:failedId,error:{...failed.error,stage:'acquisition',uncertain:false}};
 const documents=Object.fromEntries(videos.map(v=>['videos/'+v.id,v]));
 documents['reels_executions/'+failedId]={id:failedId,operationId:failedOperation,reelId:failed.id,stage:'acquisition',status:'failed',owner:'qa-fixture-owner',error:{...failed.reels_v2.error},createdAt:at};
 documents['settings/reels_v2_taxonomy']={revision:1,nodes:[{id:'cat_tech',parentId:null,name:'Tecnologia',manual:false,evidenceCount:1},{id:'cat_models',parentId:'cat_tech',name:'Modelos',manual:false,evidenceCount:1},{id:'cat_food',parentId:null,name:'Receitas',manual:true,evidenceCount:1}],assignments:[],rules:[],appliedCommands:[]};
 documents['settings/reels_v2_finance']={budget:{amount:25,currency:'BRL'},days:[{day,billed:{amount:0.15,currency:'USD'}}],coverage:{estimates:null,measured:null,billing:{source:'qa-only',observedAt:at}},appliedCommands:[]};
 documents['reels_executions/qa_completed']={id:'qa_completed',reelId:'QaPub_tech',stage:'analysis',status:'completed',createdAt:at,completedAt:at,rawResult:{valid:true,finance:{estimatedUsd:0.02,measuredUsd:null}}};
 for(const stage of ['acquisition','transcription','analysis'])documents['reels_controls/'+stage]={id:stage,paused:stage==='analysis',desiredConcurrency:7,effectiveConcurrency:2,appliedCommands:[]};
 documents['reels_events/00000000000000000001_qa']={id:'00000000000000000001_qa',at,reelId:'QaPub_tech',stage:'analysis',worker:'qa-worker',level:'info',type:'published',message:'Publicação sintética preservada.'};
 documents['settings/reels_v2_event_clock']={sequence:1,pending:null};
 return {documents,registeredIds:registered.map(x=>x.id),at};
}

export function memoryReelsStore(documents={}) {
 let revision=1;
 const docs=new Map(Object.entries(documents).map(([path,data])=>[path,{data:structuredClone(data),updateTime:String(revision++)}]));
 const reads=[];
 const project=(data,select)=>{if(!select)return structuredClone(data);const out={};for(const field of select){const parts=field.split('.');let value=data;for(const part of parts)value=value?.[part];if(value===undefined)continue;let target=out;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=structuredClone(value);}return out;};
 const encode=path=>Buffer.from(JSON.stringify({path})).toString('base64url');
 const decode=cursor=>cursor?JSON.parse(Buffer.from(cursor,'base64url').toString()).path:null;
 const query=async(collection,{select,limit=100,cursor,filters=[]}={})=>{
  reads.push({collection,select:structuredClone(select??null),cursor:cursor??null});
  const after=decode(cursor);
  let rows=[...docs].filter(([path])=>path.startsWith(collection+'/')&&path.split('/').length===2).sort(([a],[b])=>a<b?-1:a>b?1:0);
  for(const filter of filters){if(filter.op!=='eq')throw Error('Unsupported QA filter');rows=rows.filter(([,record])=>record.data[filter.field]===filter.value);}
  if(after)rows=rows.filter(([path])=>path>after);
  const page=rows.slice(0,limit),lastCursor=page.length?encode(page.at(-1)[0]):null;
  return {records:page.map(([path,record])=>({path,data:project(record.data,select),updateTime:record.updateTime})),nextCursor:rows.length>limit?lastCursor:null,lastCursor};
 };
 return {docs,reads,query,
  get:async path=>structuredClone(docs.get(path)??null),
  create:async(path,data)=>{if(docs.has(path))return {created:false};const record={data:structuredClone(data),updateTime:String(revision++)};docs.set(path,record);return {created:true,...structuredClone(record)};},
  patch:async(path,data,{updateTime}={})=>{const old=docs.get(path);if(!old||old.updateTime!==updateTime)throw Object.assign(Error('CAS conflict'),{status:412});const record={data:{...old.data,...structuredClone(data)},updateTime:String(revision++)};docs.set(path,record);return structuredClone(record);},
  list:async(collection,{pageSize=100,pageToken}={})=>{const page=await query(collection,{limit:pageSize,cursor:pageToken});return {records:page.records,nextPageToken:page.nextCursor};}
 };
}
