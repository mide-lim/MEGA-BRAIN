import {createHash} from 'node:crypto';
import {projectContextualPublication} from '../lib/reels-contextual-projection.mjs';
// Complete synthetic accepted-source inventory; no I/O and no real Reel data.
export function makeFullCatalogueFixture(){
 const observedAt='2026-10-18T00:20:00.000Z',version='2026-10-18T00:15:00.000Z',catalog=[],records=[],formatReviews=[];
 const make=(id,context,units=[])=>{
  const transcript=units.map(u=>u.excerpt).join(' '),fields=[];
  if(units.length)fields.push({kind:'ingredient',name:'Frango',value:'Frango',unitIds:['u1'],evidence:[{source:'caption',excerpt:units[0].excerpt}]});
  if(units.length>1)fields.push({kind:'tool',name:'Forno',value:'Forno',unitIds:['u2'],evidence:[{source:'caption',excerpt:units[1].excerpt}]});
  const video={id,status:'completed',title:id,creator:'@fixture',category_ids:[context==='recipe'?'receitas':'inteligencia-artificial'],analysis_key:'analysis/'+id+'.json',analysis_generation:'7',analysis_quality_status:'accepted',duration_seconds:12,transcript,transcript_key:'transcripts/'+id+'.json',transcript_generation:'8',source_caption:{capture_id:'capture-'+id,text:transcript},transcript_words:units.map((u,i)=>({word:u.excerpt,start_seconds:i*5+0.2,end_seconds:i*5+3.5})),analysis:{title:id,summary:context==='recipe'?'Receita salva.':'Tecnologia salva.',knowledge:{context,fields,keywords:[],missing_information:[]}}};
  if(units.length)video.analysis.taxonomySignals={version:1,parentCategoryId:'receitas',complete:true,confidence:0.95,units:units.map((u,i)=>({id:'u'+(i+1),kind:'recipe',title:u.title,evidence:[{source:'transcript',excerpt:u.excerpt,start_seconds:i*5,end_seconds:i*5+4}]}))};
  return {video,item:{id,title:id,creator:'@fixture',categoryIds:video.category_ids,tags:[],publication:{available:true,summary:video.analysis.summary}},sourceUpdateTime:{video:version}};
 };
 const sources=[
  make('QaFull_single','recipe',[{title:'Frango na frigideira',excerpt:'Frango na frigideira: tempere o frango, cozinhe na frigideira e sirva.'}]),
  make('QaFull_many','recipe',[{title:'Frango na frigideira',excerpt:'Frango na frigideira: tempere o frango, cozinhe na frigideira e sirva.'},{title:'Peixe no forno',excerpt:'Peixe no forno: tempere o peixe, asse no forno e sirva.'}]),
  make('QaFull_unknown','recipe'),
  make('QaFull_tech','technology')
 ];
 const id='QaFull_legacy',legacy={schemaVersion:1,reelId:id,status:'legacy_preserved',historical:true,executable:false,originalStatus:'analyzed',provenance:{recordHash:'a'.repeat(64),sourceSnapshotHash:'b'.repeat(64)},analysis:{summary:'Conhecimento histórico preservado.',topics:['frango'],claims:[],candidate_relations:[]}};
 sources.push({video:{id,status:'registered'},legacy,item:{id,title:'Acervo preservado',categoryIds:['receitas'],tags:[],publication:{available:true,source:'legacy_preserved',summary:legacy.analysis.summary}},sourceUpdateTime:{video:version,legacy:version}});
 for(const source of sources){
  const sourceJson=JSON.stringify(source),sourceSnapshotHash=createHash('sha256').update(sourceJson).digest('hex'),identity=source.legacy?{kind:'legacy_preserved',recordHash:source.legacy.provenance.recordHash,sourceSnapshotHash:source.legacy.provenance.sourceSnapshotHash}:{kind:'native',analysisKey:source.video.analysis_key,analysisGeneration:source.video.analysis_generation};
  catalog.push({id:source.item.id,publicationAvailable:true,categoryIds:source.item.categoryIds,manual:false,sourceIdentity:identity,updateTime:version});
  records.push({sourceJson,sourceSnapshotHash});
  if(source.item.id==='QaFull_single'||source.item.id==='QaFull_many'){
   const entry=projectContextualPublication(source),units=source.video.analysis.taxonomySignals.units;
   formatReviews.push({schemaVersion:1,kind:'independent_format_review',reelId:source.item.id,value:source.item.id==='QaFull_single'?'single_recipe':'recipe_collection',state:'supported',sourceIdentity:entry.sourceIdentity,sourceProofHash:entry.sourceProofHash,sourceSnapshotHash,reviewId:'fixture-independent-'+source.item.id,reviewer:{identity:'fixture:independent-source-reviewer',kind:'independent_source_review'},reviewedAt:observedAt,evidence:units.map((u,i)=>({id:'review-proof-'+i,sourceKind:'caption',sourceIdentity:source.video.source_caption.capture_id,excerpt:u.evidence[0].excerpt})),units:units.map((u,i)=>({unitId:u.id,evidenceRefs:['review-proof-'+i]}))});
  }
 }
 return {schemaVersion:1,observedAt,dataAsOf:version,catalog,records,formatReviews,taxonomy:{nodes:[{id:'group-alimentacao',name:'Alimentação',parentId:null},{id:'receitas',name:'Receitas',parentId:'group-alimentacao'}]}};
}
