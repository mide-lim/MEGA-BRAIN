import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryReelsStore} from '../qa/reels-fixture.mjs';
import {ReelsRepository} from '../lib/reels-repository.mjs';
import {ReelsSemanticCurator} from '../lib/reels-semantic-curator.mjs';
import {semanticHash,semanticPolicyPath,semanticPolicyVersion} from '../lib/reels-semantic-source.mjs';
import {makeSemanticFixture,semanticEnvelope} from './reels-semantic-fixture.mjs';

// Mirrors the production semantic store's UTF8 document fence, including
// create-only raw chunks. It fails the real engine rather than trimming output.
const DOCUMENT_UTF8_LIMIT=800_000,COUNT=499,BATCH_SIZE=8,MAXIMUM_CALLS=127;
function boundedMemoryStore(){
 const store=memoryReelsStore(),sizes=[],oversize=[],create=store.create.bind(store),commit=store.commitSemantic.bind(store);
 function inspect(path,data){
  if(!path.startsWith('reels_index/semantic_'))return;
  const bytes=Buffer.byteLength(JSON.stringify(data),'utf8');sizes.push({path,kind:data.kind,bytes});
  if(bytes>DOCUMENT_UTF8_LIMIT)oversize.push({path,bytes});
  assert.ok(bytes<=DOCUMENT_UTF8_LIMIT,'Derived document exceeds the production UTF8 fence: '+path+' ('+bytes+')');
 }
 store.create=async(path,data)=>{inspect(path,data);return create(path,data);};
 store.commitSemantic=async transaction=>{for(const write of transaction.writes)inspect(write.path,write.data);return commit(transaction);};
 return {store,sizes,oversize};
}
function longClaim(id,index){
 const prefix='Fonte '+id+' · evidência '+index+': ';
 return (prefix+'ação, gestão, organização, decisão e avaliação econômica documentadas. '.repeat(40)).slice(0,1600);
}
function proofsFor(source){
 const fields=source.fields.filter(field=>/^analysis\.claims\.\d+$/.test(field.fieldPath));
 assert.equal(fields.length,8,'The stress fixture must retain all eight source fields');
 for(const field of fields)assert.equal(field.text.length,1600);
 return fields.map(field=>({fieldPath:field.fieldPath,excerpt:field.text}));
}
function growingGroupProvider(){
 const calls=[],envelopes=new Map();
 function save(input,phase,output){
  assert.ok(!envelopes.has(input.requestId),'An inference request must never be repeated');
  calls.push({phase,ids:input.sources?.map(source=>source.id)??[],requestId:input.requestId});
  const envelope=semanticEnvelope(output,input.model);envelopes.set(input.requestId,{json:JSON.stringify(envelope.rawResponse),hash:semanticHash(envelope.rawResponse)});
  return envelope;
 }
 return {calls,envelopes,
  async infer(input){
   const existing=input.catalogue.groups.find(group=>group.key==='gestao-documentada');
   return save(input,'extract',{version:1,
    profiles:input.sources.map(source=>({reelId:source.id,context:'business',state:'proposed',reason:'Synthetic source-bound volume fixture, not a semantic accuracy measurement.',units:[]})),
    groups:[{key:'gestao-documentada',name:'Gestão documentada',context:'business',kind:'segment',definition:'Práticas de gestão desenvolvidas nas análises salvas, com fontes literais verificáveis.',aliases:['Organização de negócios'],positiveCriteria:['O conteúdo desenvolve práticas de gestão.'],negativeCriteria:['Uma menção isolada a um negócio não basta.'],...(existing?{existingGroupId:existing.id}:{}),
     members:input.sources.map(source=>({reelId:source.id,role:'central',unitIds:[],evidence:proofsFor(source)})),negativeExamples:[]}]
   });
  },
  async consolidate(input){
   assert.equal(input.groups.length,1,'All batches must reuse the same contextual group');
   return save(input,'consolidate',{version:1,resolutions:input.groups.map(group=>({groupId:group.id,decision:'keep',mergeInto:'',reason:'Synthetic single contextual group with exact source-bound membership.'}))});
  },
  async verify(input){
   const byId=new Map(input.sources.map(source=>[source.id,source]));
   // Verification reads the saved source independently. Compact membership
   // metadata is not treated as a replacement for the original quotations.
   return save(input,'verify',{version:1,members:input.members.map(member=>({groupId:member.groupId,reelId:member.reelId,verdict:'supported',reason:'Synthetic verification of the complete saved source quotations.',evidence:proofsFor(byId.get(member.reelId))})),negativeExamples:[]});
  }
 };
}
async function setupVolume(){
 const {store,sizes,oversize}=boundedMemoryStore(),base=JSON.parse(makeSemanticFixture().saved.records[0].sourceJson).video,ids=[];
 const updateTime='2026-10-18T00:00:00.000Z';
 store.docs.set('settings/reels_v2_taxonomy',{data:{revision:1,nodes:[{id:'group-trabalho',name:'Trabalho e negócios',parentId:null}],assignments:[],rules:[]},updateTime});
 for(let index=0;index<COUNT;index++){
  const id='QaVol_'+String(index).padStart(3,'0'),video=structuredClone(base);ids.push(id);
  Object.assign(video,{id,title:'Gestão salva '+id,creator:'@volume-fixture',category_ids:['group-trabalho'],analysis_key:'analysis/'+id+'.json',analysis_generation:'7',transcript:'',transcript_key:'transcripts/'+id+'.json',source_caption:{capture_id:'caption-'+id,text:''},transcript_words:[]});
  video.analysis={title:video.title,summary:'Práticas de gestão registradas e preservadas.',claims:Array.from({length:8},(_,claim)=>longClaim(id,claim)),knowledge:{context:'business',fields:[],keywords:[],missing_information:[]}};
  store.docs.set('videos/'+id,{data:video,updateTime});
 }
 assert.ok(Buffer.byteLength(longClaim(ids[0],0),'utf8')>1600,'UTF8 growth must exceed character count');
 const sourceBefore=new Map([...store.docs].filter(([path])=>path.startsWith('videos/')).map(([path,row])=>[path,semanticHash(row)]));
 const repository=new ReelsRepository({store,cacheTtlMs:0}),provider=growingGroupProvider(),deliveries=[];
 const curator=new ReelsSemanticCurator({repository,provider,enqueue:async job=>{deliveries.push({jobId:job.id,sequence:job.dispatch.sequence,outboxId:job.dispatch.outboxId,maxBatches:1});return {status:'sent'};}});
 const inventory=await curator.inventory();assert.equal(inventory.inventory.length,COUNT);
 const pins=inventory.inventory.map(({id,sourceVersions})=>({id,sourceVersions})).sort((a,b)=>a.id.localeCompare(b.id));
 await store.create(semanticPolicyPath,{version:semanticPolicyVersion,enabled:true,model:'gemini-volume-author-synthetic',verifierModel:'gemini-volume-verifier-synthetic',batchSize:BATCH_SIZE,maxSources:COUNT,maxCalls:MAXIMUM_CALLS,authorizationId:'github-synthetic-growing-group499',authorizedCohortHash:semanticHash(pins),expiresAt:'2099-01-01T00:00:00.000Z',autoPromotionEnabled:false,minUniqueMembers:10});
 return {store,sizes,oversize,ids,sourceBefore,repository,provider,deliveries,curator};
}
test('real semantic engine grows one499-member group with eight long UTF8 quotations per source without oversized derived documents', {timeout:180_000},async()=>{
 const s=await setupVolume(),preview=await s.curator.preview({all:true});
 assert.equal(preview.inferenceStarted,false);assert.equal(preview.preview.selectedCount,COUNT);assert.equal(preview.preview.maximumCalls,MAXIMUM_CALLS);assert.equal(s.provider.calls.length,0);
 const command={selection:{all:true},previewHash:preview.previewHash,idempotencyKey:'github-synthetic-growing-group499-command'},created=await s.curator.create(command);
 assert.equal(s.provider.calls.length,0,'Creation queues work without running inference');
 let deliveries=0;
 while(s.deliveries.length){assert.ok(++deliveries<=MAXIMUM_CALLS+1,'Durable continuation must terminate within the finite operation');await s.curator.runDelivery(s.deliveries.shift());}
 const job=(await s.curator.job(created.job.id)).job;
 assert.deepEqual({status:job.status,processed:job.processed,verified:job.verificationProcessed,calls:job.callsUsed},{status:'completed',processed:COUNT,verified:COUNT,calls:MAXIMUM_CALLS},JSON.stringify(job));
 assert.equal(s.provider.calls.length,MAXIMUM_CALLS);
 assert.deepEqual(s.provider.calls.filter(call=>call.phase==='extract').flatMap(call=>call.ids).sort(),s.ids);
 assert.deepEqual(s.provider.calls.filter(call=>call.phase==='verify').flatMap(call=>call.ids).sort(),s.ids);
 assert.equal(s.provider.calls.filter(call=>call.phase==='consolidate').length,1);
 const overview=await s.curator.overview();assert.equal(overview.groups.length,1);assert.equal(overview.coverage.evaluated,COUNT);assert.equal(overview.coverage.unknown,0);assert.equal(overview.coverage.pending,0);
 const group=overview.groups[0];assert.equal(group.status,'candidate','Volume is not permission for automatic promotion');assert.equal(group.memberCount,COUNT);
 const stored=(await s.store.get('reels_index/semantic_group_'+group.id)).data;
 assert.equal(stored.members.length,COUNT);assert.equal(new Set(stored.members.map(member=>member.id)).size,COUNT);assert.deepEqual(stored.members.map(member=>member.id).sort(),s.ids);
 assert.equal(stored.verification.status,'supported');assert.equal(stored.verification.members.length,COUNT);assert.equal(new Set(stored.verification.members.map(member=>member.reelId)).size,COUNT);
 assert.ok(stored.members.every(member=>member.evidenceRef?.resultId&&member.evidenceCount===8),'Every compact association retains a reference to its eight original quotations');
 const sourceQuotationCharacters=COUNT*8*1600;assert.ok(sourceQuotationCharacters>DOCUMENT_UTF8_LIMIT*7,'The fixture must exceed a single document many times before compaction');
 const results=[...s.store.docs].filter(([,row])=>row.data.kind==='semantic_result');assert.equal(results.length,MAXIMUM_CALLS);
 for(const [path,row]of results){
  assert.equal(row.data.processed,true,path);
  const expected=s.provider.envelopes.get(row.data.id);assert.ok(expected,path);
  const restored=await s.curator.envelopeRead(row);assert.equal(JSON.stringify(restored.rawResponse),expected.json,'Raw response must round-trip without citation truncation: '+path);assert.equal(row.data.rawHash,expected.hash);
 }
 const detail=await s.curator.detail(group.id);assert.equal(detail.members.length,COUNT);assert.equal(detail.proofDetails.hydratedMembers,20);assert.equal(detail.proofDetails.complete,false);assert.equal(detail.proofDetails.rawPreserved,true);
 const first=detail.members.find(member=>member.id===s.ids[0]);assert.equal(first.evidence.length,8);assert.deepEqual(first.evidence.map(proof=>proof.excerpt),Array.from({length:8},(_,i)=>longClaim(first.id,i)));
 const tail=await s.curator.detail(group.id,{memberId:s.ids.at(-1)}),last=tail.members.find(member=>member.id===s.ids.at(-1));
 assert.equal(tail.proofDetails.hydratedMembers,1);assert.equal(last.evidence.length,8);assert.deepEqual(last.evidence.map(proof=>proof.excerpt),Array.from({length:8},(_,i)=>longClaim(last.id,i)));
 await s.curator.command({action:'group_approve',groupId:group.id,revision:group.revision,idempotencyKey:'github-synthetic-volume499-manual-approval'});
 assert.deepEqual((await s.curator.matchingIds(group.id)).sort(),s.ids);const library=await s.repository.list({workspace:'library',category:'semantic_'+group.id,limit:100});assert.equal(library.total,COUNT);assert.equal(new Set(library.items.map(item=>item.id)).size,100);
 const beforeReads=s.provider.calls.length,metadataBefore=semanticHash([...s.store.docs].filter(([path])=>path.startsWith('reels_index/semantic_')));
 await s.curator.overview();await s.curator.detail(group.id,{memberId:s.ids.at(-1)});await s.curator.create(command);
 await s.curator.runDelivery({jobId:created.job.id,sequence:0,outboxId:semanticHash({jobId:created.job.id,sequence:0}),maxBatches:3});
 assert.equal(s.provider.calls.length,beforeReads,'GET, detail and duplicate delivery cannot regenerate paid results');assert.equal(s.deliveries.length,0);
 assert.equal(semanticHash([...s.store.docs].filter(([path])=>path.startsWith('reels_index/semantic_'))),metadataBefore,'Completed reads and duplicate commands remain read-only');
 for(const [path,hash]of s.sourceBefore)assert.equal(semanticHash(s.store.docs.get(path)),hash,'Saved source changed: '+path);
 assert.equal([...s.store.docs.keys()].filter(path=>path.startsWith('videos/')).length,COUNT);
 assert.deepEqual(s.oversize,[]);assert.ok(s.sizes.some(write=>write.kind==='semantic_group'));assert.ok(s.sizes.some(write=>write.kind==='semantic_raw'));
 for(const [path,row]of s.store.docs)if(path.startsWith('reels_index/semantic_'))assert.ok(Buffer.byteLength(JSON.stringify(row.data),'utf8')<=DOCUMENT_UTF8_LIMIT,'Final derived document too large: '+path);
});
