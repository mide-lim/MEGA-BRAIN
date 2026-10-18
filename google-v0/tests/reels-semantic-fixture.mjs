import {makeFullCatalogueFixture} from './reels-contextual-catalogue-fixture.mjs';
import {semanticHash,semanticPolicyPath} from '../lib/reels-semantic-source.mjs';
export const semanticEnvelope=(output,model='gemini-synthetic')=>({rawResponse:{responseId:'synthetic-'+semanticHash(output).slice(0,16),candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:10}},model,requestHash:semanticHash({model,output}),usage:{promptTokenCount:10,candidatesTokenCount:10},providerResponseId:'synthetic'});
export function semanticUnknownProvider(){
 const calls=[];
 return {calls,async infer(input){calls.push({phase:'extract',requestId:input.requestId,ids:input.sources.map(s=>s.id)});return semanticEnvelope({version:1,profiles:input.sources.map(s=>({reelId:s.id,context:'general',state:'unknown',reason:'Synthetic contract fixture abstains; no semantic accuracy claim.',units:[]})),groups:[]},input.model);},async consolidate(input){calls.push({phase:'consolidate',requestId:input.requestId});return semanticEnvelope({version:1,resolutions:input.groups.map(g=>({groupId:g.id,decision:'keep',mergeInto:'',reason:'Synthetic unchanged definition.'}))},input.model);},async verify(input){calls.push({phase:'verify',requestId:input.requestId});return semanticEnvelope({version:1,members:input.members.map(m=>({...m,verdict:'inconclusive',reason:'Synthetic unknown fixture.'})),negativeExamples:input.negativeExamples.map(m=>({...m,verdict:'inconclusive',reason:'Synthetic unknown fixture.'}))},input.model);}};
}
export function makeSemanticFixture({navigationGroups=false}={}){
 const saved=makeFullCatalogueFixture(),documents=[];
 for(const row of saved.records){const s=JSON.parse(row.sourceJson);documents.push({path:'videos/'+s.item.id,data:s.video,updateTime:s.sourceUpdateTime.video});if(s.legacy)documents.push({path:'reels_legacy_content/'+s.item.id,data:s.legacy,updateTime:s.sourceUpdateTime.legacy});}
 documents.push({path:'settings/reels_v2_taxonomy',data:{revision:13,nodes:saved.taxonomy.nodes,assignments:[],rules:[]},updateTime:saved.dataAsOf});
 const pins=saved.catalog.map(c=>({id:c.id,sourceVersions:JSON.parse(saved.records.find(r=>JSON.parse(r.sourceJson).item.id===c.id).sourceJson).sourceUpdateTime})).sort((a,b)=>a.id.localeCompare(b.id));
 const policy={version:'semantic-curator-v1',enabled:true,model:'gemini-author-synthetic',verifierModel:'gemini-verifier-synthetic',batchSize:2,maxCalls:7,maxSources:5,authorizationId:'fixture-semantic-001',authorizedCohortHash:semanticHash(pins),expiresAt:'2099-01-01T00:00:00.000Z',autoPromotionEnabled:false,minUniqueMembers:2};
 documents.push({path:semanticPolicyPath,data:policy,updateTime:saved.dataAsOf});
 const calls=[],proof=s=>{const f=s.fields.find(f=>f.fieldPath==='caption'&&f.text)||s.fields.find(f=>f.fieldPath==='analysis.summary')||s.fields[0];return {fieldPath:f.fieldPath,excerpt:f.text.slice(0,1200)};};
 const provider={
 calls,
 async infer(input){
  calls.push({phase:'extract',requestId:input.requestId,ids:input.sources.map(s=>s.id)});
  const members=input.sources.filter(s=>['QaFull_single','QaFull_many'].includes(s.id)),negative=input.sources.filter(s=>s.id==='QaFull_tech'),existing=input.catalogue.groups.find(g=>g.key==='preparos-caseiros');
  return semanticEnvelope({version:1,profiles:input.sources.map(s=>({reelId:s.id,context:s.id==='QaFull_tech'?'technology':['QaFull_single','QaFull_many','QaFull_unknown'].includes(s.id)?'recipe':'general',state:s.id==='QaFull_legacy'?'unknown':'proposed',reason:'Synthetic source-bound semantic fixture; not a real model evaluation.',units:[]})),groups:members.length?[{key:'preparos-caseiros',name:'Preparos caseiros',context:'recipe',kind:'segment',definition:'Demonstração de um preparo culinário doméstico.',aliases:['Cozinha de casa'],positiveCriteria:['Um preparo culinário é o assunto desenvolvido.'],negativeCriteria:['Conteúdo sobre tecnologia sem preparo culinário não pertence.'],...(existing?{existingGroupId:existing.id}:{}),members:members.map(s=>({reelId:s.id,role:'central',unitIds:[],evidence:[proof(s)]})),negativeExamples:negative.map(s=>({reelId:s.id,reason:'O assunto desenvolvido é tecnologia.',evidence:[proof(s)]}))}]:[]},input.model);
 },
 async consolidate(input){calls.push({phase:'consolidate',requestId:input.requestId});return semanticEnvelope({version:1,resolutions:input.groups.map(g=>({groupId:g.id,decision:'keep',mergeInto:'',reason:'One coherent synthetic recipe group; no duplicates.'}))},input.model);},
 async verify(input){calls.push({phase:'verify',requestId:input.requestId,ids:input.sources.map(s=>s.id)});return semanticEnvelope({version:1,members:input.members.map(m=>({groupId:m.groupId,reelId:m.reelId,verdict:'supported',reason:'Synthetic independent-phase contract fixture only.',evidence:m.evidence.map(({fieldPath,excerpt})=>({fieldPath,excerpt}))})),negativeExamples:input.negativeExamples.map(m=>({groupId:m.groupId,reelId:m.reelId,verdict:'supported',reason:'Synthetic documented contrasting context.',evidence:m.evidence.map(({fieldPath,excerpt})=>({fieldPath,excerpt}))}))},input.model);}
 };
 if(navigationGroups){
  const originalInfer=provider.infer;
  provider.infer=async input=>{
   const envelope=await originalInfer(input),output=JSON.parse(envelope.rawResponse.candidates[0].content.parts[0].text),single=input.sources.find(s=>s.id==='QaFull_single'),recipes=input.sources.filter(s=>['QaFull_single','QaFull_many'].includes(s.id));
   if(single){const p=output.profiles.find(p=>p.reelId===single.id),e=proof(single);p.units=[{unitId:'preparo_1',type:'recipe',completeness:'complete',evidence:[e]}];const old=input.catalogue.groups.find(g=>g.key==='single_recipe');output.groups.push({key:'single_recipe',name:'Receita única',context:'recipe',kind:'format',definition:'Um preparo completo independente desenvolvido no conteúdo.',aliases:[],positiveCriteria:['Um preparo completo.'],negativeCriteria:['Mais de um preparo independente.'],...(old?{existingGroupId:old.id}:{}),members:[{reelId:single.id,role:'central',unitIds:['preparo_1'],evidence:[e]}],negativeExamples:[]});}
   if(recipes.length){const old=input.catalogue.groups.find(g=>g.key==='frango');output.groups.push({key:'frango',name:'Frango',context:'recipe',kind:'facet',dimension:'ingredient',definition:'Ingrediente associado a um preparo demonstrado; não afirma centralidade do vídeo.',aliases:[],positiveCriteria:['Uso do ingrediente num preparo.'],negativeCriteria:['Apenas menção ou ausência de preparo.'],...(old?{existingGroupId:old.id}:{}),members:recipes.map(s=>({reelId:s.id,role:'supporting',unitIds:[],evidence:[proof(s)]})),negativeExamples:[]});}
   return semanticEnvelope(output,input.model);
  };
 }
 return {documents,policy,saved,provider,calls,expected:{publishedCount:5,groupName:'Preparos caseiros',memberIds:['QaFull_many','QaFull_single'],groupId:semanticHash({version:'semantic-curator-contract-v1',context:'recipe',kind:'segment',dimension:null,key:'preparos-caseiros'}),maximumCalls:7}};
}
