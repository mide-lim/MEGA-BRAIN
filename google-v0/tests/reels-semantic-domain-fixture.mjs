import {semanticHash,semanticPolicy,semanticSourceFromSaved} from '../lib/reels-semantic-source.mjs';
import {semanticDomainRecordFromSaved,prepareSemanticDomainManifest} from '../lib/reels-semantic-domain-planner.mjs';
import {prepareSemanticProviderRequest} from '../lib/reels-semantic-provider.mjs';
import {semanticEnvelope} from './reels-semantic-fixture.mjs';
export function semanticDomainUnknownProvider(){
 const calls=[];
 const finish=(phase,input,output)=>{calls.push({phase,ids:(input.sources??[]).map(s=>s.id),requestId:input.requestId});const payload=phase==='extract'?{sources:input.sources,catalogue:input.catalogue}:phase==='consolidate'?{groups:input.groups}:{sources:input.sources,groups:input.groups,members:input.members,negativeExamples:input.negativeExamples,profiles:input.profiles??[]},request=prepareSemanticProviderRequest({phase,payload,requestId:input.requestId,domainId:input.domainId});return {...semanticEnvelope(output,input.model),requestHash:semanticHash(request)};};
 return {calls,async infer(input){return finish('extract',input,{version:1,profiles:input.sources.map(s=>({reelId:s.id,context:'general',state:'unknown',reason:'Synthetic bounded domain contract; no semantic accuracy claim.',units:[]})),groups:[],destinations:input.sources.map(s=>({reelId:s.id,state:'inconclusive',domainId:null,reason:'Synthetic abstention with no inferred destination.',evidence:[]}))});},async consolidate(input){return finish('consolidate',input,{version:1,resolutions:input.groups.map(g=>({groupId:g.id,decision:'keep',mergeInto:'',reason:'Synthetic unchanged definition.'}))});},async verify(input){return finish('verify',input,{version:1,members:[],negativeExamples:[]});}};
}
export function makeSemanticDomainFixture({count=20}={}){
 const at='2026-10-18T00:00:00.000Z',ids=Array.from({length:count},(_,i)=>'QaDomain_'+String(i).padStart(3,'0')),documents=ids.map((id,i)=>({path:'videos/'+id,updateTime:at,data:{id,status:'completed',title:'Fonte '+i,creator:i%2?'Bia':'Ada',categoryIds:[i===count-1?'a-organizar':i===count-2?'desenvolvimento-software':'receitas'],analysis_key:'analysis/'+id+'.json',analysis_generation:'1',analysis_quality_status:'accepted',analysis:{title:'Fonte '+i,summary:'Conteúdo salvo '+('á🙂'.repeat(i%3===0?1800:100)),categories:[i===count-1?'a-organizar':i===count-2?'desenvolvimento-software':'receitas']}}}));
 documents.push({path:'settings/reels_v2_taxonomy',data:{revision:1,nodes:[],assignments:[],rules:[]},updateTime:at});
 const provider=semanticDomainUnknownProvider();return {documents,ids,at,provider,calls:provider.calls};
}
export async function seedSemanticDomainManifest({curator,store=curator.store,histories=[],historyCoverageConfirmed=true,budget={},observedAt=curator.now()}){
 const inventory=await curator.inventory(),records=[];for(const item of inventory.items)records.push(semanticDomainRecordFromSaved(await curator.catalogue.loadSource(item.id)));
 const taxonomy=(await store.get('settings/reels_v2_taxonomy'))?.data??{},manifest=prepareSemanticDomainManifest({records,taxonomy,histories,historyCoverageConfirmed,catalogue:{groups:[]},budget,prepareRequest:prepareSemanticProviderRequest,observedAt});
 await store.create('settings/reels_v2_semantic_domain_plan',manifest);return {manifest,records};
}
