import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {ReelsRepository} from '../google-v0/lib/reels-repository.mjs';
import {ReelsSemanticCurator} from '../google-v0/lib/reels-semantic-curator.mjs';
import {semanticHash} from '../google-v0/lib/reels-semantic-source.mjs';
import {prepareSemanticProviderRequest} from '../google-v0/lib/reels-semantic-provider.mjs';
import {prepareSemanticDomainManifest} from '../google-v0/lib/reels-semantic-domain-planner.mjs';
import {semanticDomainRecordFromSaved} from '../google-v0/lib/reels-semantic-domain-service.mjs';
import {memoryReelsStore} from '../google-v0/qa/reels-fixture.mjs';

const sourceSHA='41c61b96dc59ac85929adad158d29712235083ec64a83c337a9394a2118398cd';
const forbiddenKeys=new Set(['rawResponse','rawText','requestBody','systemInstruction','contents','sourceFields','fields','headers','accessToken','credentials']);
function metadataOnly(value,path='manifest'){
 if(!value||typeof value!=='object')return;
 for(const [key,item] of Object.entries(value)){
  assert.ok(!forbiddenKeys.has(key),'Source bodies or credentials are forbidden in the report: '+path+'.'+key);
  metadataOnly(item,path+'.'+key);
 }
}
export async function rehearseSavedDomainPlanning(input,{sourceCommit='unknown'}={}){
 assert.equal(input.schemaVersion,1);
 assert.equal(input.sourceObservationSHA256,sourceSHA);
 const observation=input.observation;
 assert.equal(observation.readOnly,true);assert.equal(observation.providerCalls,0);assert.equal(observation.writes,0);assert.equal(observation.records.length,738);
 const documents=Object.fromEntries(observation.records.map(row=>[row.path,row.data]));
 documents['settings/reels_v2_taxonomy']=observation.taxonomy?.data??observation.taxonomy;
 const store=memoryReelsStore(documents);
 for(const row of observation.records)store.docs.set(row.path,{data:structuredClone(row.data),updateTime:row.updateTime});
 const before=new Map(observation.records.map(row=>[row.path,semanticHash(store.docs.get(row.path))]));
 const repository=new ReelsRepository({store,cacheTtlMs:0}),curator=new ReelsSemanticCurator({repository});
 const inventory=await curator.inventory();assert.equal(inventory.inventory.length,499);
 const records=new Array(inventory.inventory.length);let cursor=0;
 await Promise.all(Array.from({length:8},async()=>{while(cursor<records.length){
  const index=cursor++,pin=inventory.inventory[index],raw=await curator.catalogue.loadSource(pin.id);
  assert.ok(raw?.item.publication.available);
  records[index]=semanticDomainRecordFromSaved(raw);
 }}));
 const manifest=prepareSemanticDomainManifest({records,taxonomy:documents['settings/reels_v2_taxonomy'],histories:[],historyCoverageConfirmed:false,catalogue:{groups:[]},prepareRequest:prepareSemanticProviderRequest,observedAt:observation.observedEnd??observation.observedStart??null});
 metadataOnly(manifest);
 for(const [path,hash] of before)assert.equal(semanticHash(store.docs.get(path)),hash,'Saved source changed: '+path);
 return {schemaVersion:1,kind:'saved499_domain_planning_rehearsal',sourceCommit,sourceObservationSHA256:sourceSHA,sourceDocuments:738,published:499,sourceObservationDate:observation.observedEnd??observation.observedStart??null,actualGoogleObservations:false,historicalExecutionCoverageConfirmed:false,scope:'Existing saved analysis routing, presence and full-request size measurements only; historical inputs do not prove the current retained/protected sets.',manifest,actualProviderCalls:0,networkRequests:0,googleWrites:0,newReels:0,paidReplays:0,originalSourcesUnchanged:true,semanticAccuracyMeasured:false,sourceBodiesIncluded:false,executionAuthorized:false};
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='mide-lim/MEGA-BRAIN')throw Error('Central GitHub Actions required.');
 const [flag,path,outFlag,out]=process.argv.slice(2);
 if(flag!=='--input'||!path||outFlag!=='--output'||!out)throw Error('Explicit input and output required.');
 const report=await rehearseSavedDomainPlanning(JSON.parse(await readFile(path,'utf8')),{sourceCommit:process.env.GITHUB_SHA});
 await mkdir(out,{recursive:true});await writeFile(join(out,'saved499-domain-planning.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({kind:report.kind,published:report.published,sourceDocuments:738,actualGoogleObservations:false,historicalExecutionCoverageConfirmed:false,actualProviderCalls:0,googleWrites:0,originalSourcesUnchanged:true,semanticAccuracyMeasured:false}));
}
if(process.argv[1]?.endsWith('/prepare-semantic-domain-curation.mjs'))await main();
