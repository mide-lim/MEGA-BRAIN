import {createHash} from 'node:crypto';
// Synthetic saved publications for central CI and browser QA only. No I/O.
export function makeContextualCalibrationFixture(){
 const observedAt='2026-10-17T22:50:00.000Z',updateTime='2026-10-17T22:45:00.000Z';
 const catalog=[],records=[],annotations=[],trainIds=[],holdoutIds=[];
 for(let i=1;i<=8;i++){
  const ingredient=i<=4?'Frango':'Peixe',value=i<=4?'frango':'peixe',id='QaCal_'+String(i).padStart(3,'0');
  const text='Ingredientes: 300 g de '+value+'. Prepare na frigideira.';
  const video={id,title:'Preparo de '+value+' '+i,creator:'@cozinha_ci',status:'completed',category_ids:['receitas'],analysis_key:'analysis/'+id+'.json',analysis_generation:String(100+i),analysis_quality_status:'accepted',source_caption:{text,capture_id:'caption-'+id},duration_seconds:30,analysis:{title:'Preparo de '+value+' '+i,summary:'Uma preparação ilustrativa de '+value+'.',knowledge:{context:'recipe',fields:[{kind:'ingredient',name:ingredient,value:ingredient,role:'supporting',evidence:[{source:'caption',excerpt:text}]}]}}};
  const sourceIdentity={kind:'native',analysisKey:video.analysis_key,analysisGeneration:video.analysis_generation};
  const item={id,title:video.title,creator:video.creator,categoryIds:['receitas'],tags:[],publication:{available:true,summary:video.analysis.summary}};
  const sourceJson=JSON.stringify({item,video,sourceUpdateTime:{video:updateTime}});
  const sourceSnapshotHash=createHash('sha256').update(sourceJson).digest('hex');
  catalog.push({id,publicationAvailable:true,sourceIdentity,categoryIds:['receitas'],manual:false,updateTime});
  records.push({sourceJson,sourceSnapshotHash});
  // Independent annotations are synthetic labels, never production evidence.
  for(const [ruleValue,positive] of [['frango',i<=4],['peixe',i>4]]){
   annotations.push({reelId:id,ruleId:'recipe-ingredient-'+ruleValue+'-any-v1',label:positive?'positive':'negative',sourceSnapshotHash,anchors:[{sourceKind:'caption',sourceIdentity:video.source_caption.capture_id,excerpt:text}],reason:positive?'Synthetic ingredient explicitly included.':'Synthetic source explicitly lists the other ingredient.',annotator:{identity:'fixture:independent-curator',kind:'independent_source_review',predictionsSeen:false},reviewedAt:'2026-10-17T22:49:00.000Z'});
  }
  (i===1||i===2||i===5||i===6?trainIds:holdoutIds).push(id);
 }
 return {schemaVersion:1,observedAt,catalog,records,annotations,splitManifest:{trainIds,holdoutIds,lockedAt:'2026-10-17T22:46:00.000Z',predictionsUnseen:true},taxonomy:{updateTime,data:{revision:7,nodes:[{id:'group-alimentacao',name:'Alimentação',parentId:null,manual:false},{id:'receitas',name:'Receitas e preparos',parentId:'group-alimentacao',manual:false}],assignments:[],rules:[],appliedCommands:[]}}};
}
