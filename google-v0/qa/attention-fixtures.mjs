import {video as accepted} from './fixture.mjs';
export function attentionFixtures(){
 const videos=[],items=[];
 for(let i=0;i<207;i++){const v=structuredClone(accepted);v.id=`Audit_${i}`;if(i<6)v.analysis.knowledge.fields=[];videos.push(v);items.push({id:v.id,stage:'analysis',status:'completed',version:`accepted_${i}`});}
 for(let i=0;i<51;i++){const id=`Source_${i}`;videos.push({id,status:'needs_attention',media_verified:false,analysis:null,transcript:'',error:'PRIVATE-DIAGNOSTIC https://private?token=secret'});items.push({id,stage:'upload',status:'completed',reason_code:'source_metadata_failed',version:`source_${i}`});}
 for(let i=0;i<2;i++){const id=`Schema_${i}`;videos.push({id,status:'needs_attention',media_verified:true,transcript:'Preservada',analysis:null});items.push({id,stage:'analysis',status:'completed',reason_code:'schema_rejected',version:`schema_${i}`});}
 videos.push({id:'Uncertain_1',status:'needs_attention',media_verified:true,transcript:'Preservada',analysis:null});items.push({id:'Uncertain_1',stage:'analysis',status:'uncertain',version:'uncertain'});
 videos.push({id:'Candidate_1',status:'needs_attention',media_verified:true,transcript:'Preservada',analysis_quality_status:'review_required',analysis_candidate:{summary:'Candidato preservado'}});items.push({id:'Candidate_1',stage:'analysis',status:'completed',version:'candidate'});
 return {videos,items};
}

export function missingKnowledgeFixtures(){
 const variants=[null,false,'',undefined];
 const videos=variants.map((knowledge,i)=>{const v=structuredClone(accepted);v.id=`Missing_${i}`;v.analysis.title=`Publicado ${i+1}`;if(i===3)delete v.analysis.knowledge;else v.analysis.knowledge=knowledge;return v;});
 return {videos,items:videos.map(v=>({id:v.id,stage:'analysis',status:'completed',version:`missing_${v.id}`}))};
}
