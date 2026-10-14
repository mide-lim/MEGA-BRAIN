import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {fragmentCount,fragmentSpec,fragmentPath,fragmentMarker,splitControlMap,hydrateFragments,planFragmentPatch,planControlMigration} from '../lib/control-fragments.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {StorageCapacity} from '../lib/storage-capacity.mjs';
import {Firestore,encodeFields,decodeFields,mutateDocument} from '../lib/firestore.mjs';
const project='megabrain-v0-1017370021431',path='settings/financial';
const job=i=>'job_'+createHash('sha256').update(String(i)).digest('hex');
function fixture(count=550){
 const jobs=Object.fromEntries(Array.from({length:count},(_,i)=>[job(i),{video_id:`Reel_${i}`,stage:'upload',status:'completed',maximum_cents:50,actual_cents:50}]));jobs.media_pilot_delivery={video_id:'Pilot',stage:'media_access',status:'reserved',maximum_cents:100};
 const root={schema_version:1,paused:true,spent_cents:count*50,reserved_cents:100,jobs:{},control_fragments:fragmentMarker(path,jobs)};
 const spec=fragmentSpec(path),chunks=splitControlMap(path,jobs).map((entries,index)=>({path:fragmentPath(spec,index),data:{schema_version:1,owner:path,index,entries},updateTime:'v1'}));
 return {jobs,root,chunks};
}
function server(f=fixture()){
 const docs=new Map([[path,{data:f.root,updateTime:'v1'}],...f.chunks.map(c=>[c.path,c])]);let revision=1;const commits=[];
 const root=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`,prefix=`projects/${project}/databases/(default)/documents/`;
 const api={project,async request(url,o={}){
  if(url===root+':commit'){
   const writes=o.json.writes;
   for(const w of writes){const p=w.update.name.slice(prefix.length);if(docs.get(p)?.updateTime!==w.currentDocument.updateTime)throw Object.assign(Error('conflict'),{status:412});}
   const version='v'+(++revision);commits.push(structuredClone(writes));
   for(const w of writes){const p=w.update.name.slice(prefix.length);docs.set(p,{data:{...docs.get(p).data,...decodeFields(w.update.fields)},updateTime:version});}
   return {writeResults:writes.map(()=>({updateTime:version}))};
  }
  const p=url.slice(root.length+1).split('?')[0];
  if(p==='control_chunks')return {documents:[...docs].filter(([k])=>k.startsWith('control_chunks/')).map(([k,v])=>({name:prefix+k,fields:encodeFields(v.data),updateTime:v.updateTime}))};
  const v=docs.get(p);if(!v)throw Object.assign(Error(),{status:404});return {name:prefix+p,fields:encodeFields(v.data),updateTime:v.updateTime};
 }};return {api,docs,commits,store:new Firestore(api)};
}
test('hydrate keeps legacy finance/media entries and stable digest independent of field ordering',()=>{
 const f=fixture();const x=hydrateFragments(path,f.root,[...f.chunks].reverse());assert.deepEqual(x.data.jobs,f.jobs);assert.equal(Object.keys(x.data.jobs).length,551);
 assert.throws(()=>hydrateFragments(path,f.root,f.chunks.slice(1)),/ausente/);
 const wrong=structuredClone(f.chunks);wrong[0].data.entries[job(777)]={status:'completed'};assert.throws(()=>hydrateFragments(path,f.root,wrong),/inválido|divergem/);
});
test('only touched fragment and compact root are written; no historical job is removed',()=>{
 const f=fixture(),snapshot={data:{...f.root,jobs:f.jobs},chunks:f.chunks};const jobs={...f.jobs,[job(0)]:{...f.jobs[job(0)],status:'uncertain'}};
 const p=planFragmentPatch(path,snapshot,{jobs,paused:true});assert.equal(p.updates.length,1);assert.equal(p.rootChanges.jobs,undefined);
 const oldBytes=Buffer.byteLength(JSON.stringify(encodeFields({jobs,paused:true}))),newBytes=Buffer.byteLength(JSON.stringify(encodeFields(p.rootChanges)))+Buffer.byteLength(JSON.stringify(encodeFields(p.updates[0].changes)));
 assert.ok(newBytes<oldBytes/8);console.log(JSON.stringify({fixture:'550 jobs plus media hold',old_encoded_bytes:oldBytes,new_encoded_bytes:newBytes,reduction_percent:Math.round((1-newBytes/oldBytes)*1000)/10}));
 const removed={...f.jobs};delete removed[job(0)];assert.throws(()=>planFragmentPatch(path,snapshot,{jobs:removed}),/removido/);
});
test('atomic commit preserves root/chunk versions; stale concurrent mutation is definitely rejected',async()=>{
 const s=server(),a=await s.store.get(path),other=new Firestore(s.api),b=await other.get(path);
 await s.store.patch(path,{jobs:{...a.data.jobs,[job(0)]:{...a.data.jobs[job(0)],status:'uncertain'}},paused:true},{updateTime:a.updateTime});
 assert.equal(s.commits[0].length,2);assert.ok(s.commits[0].every(w=>w.currentDocument.updateTime==='v1'));
 await assert.rejects(other.patch(path,{spent_cents:b.data.spent_cents+50},{updateTime:b.updateTime}),e=>e.status===412);
 const after=await s.store.get(path);assert.equal(after.data.jobs[job(0)].status,'uncertain');assert.equal(after.data.jobs.media_pilot_delivery.status,'reserved');
});
test('four simultaneous control mutations retry metadata conflicts without losing totals or jobs',async()=>{
 const s=server();await Promise.all(Array.from({length:4},(_,i)=>mutateDocument(new Firestore(s.api),path,async x=>({changes:{spent_cents:x.data.spent_cents+50,jobs:{...x.data.jobs,[job(i)]:{...x.data.jobs[job(i)],actual_cents:100}}}}))));
 const after=await s.store.get(path);assert.equal(after.data.spent_cents,27700);for(let i=0;i<4;i++)assert.equal(after.data.jobs[job(i)].actual_cents,100);
 assert.equal(s.commits.length,4);assert.ok(s.commits.every(w=>w.length===2));
});
test('ambiguous commit response is never retried, provider-independent only',async()=>{
 const s=server();const original=s.api.request;s.api.request=async(u,o)=>{const r=await original(u,o);if(u.endsWith(':commit'))throw Error('receipt lost');return r;};
 await assert.rejects(mutateDocument(s.store,path,async x=>({changes:{spent_cents:x.data.spent_cents+1}})),/receipt lost/);assert.equal(s.commits.length,1);
 s.api.request=original;assert.equal((await s.store.get(path)).data.spent_cents,27501);
});
test('migration is small, create-only, paused CAS guarded and preserves complete original snapshots',()=>{
 const f=fixture();const financial={data:{...f.root,jobs:f.jobs},updateTime:'v1'};delete financial.data.control_fragments;
 const capacity={data:{claims:{object_abc:{}}},updateTime:'c1'};capacity.data.claims={};
 const controls={data:{enabled:false},updateTime:'a1'};
 const p=planControlMigration({project,financial,capacity,automation:controls,admission:controls});assert.equal(p.writes.length,38);assert.equal(p.applied,false);
 assert.equal(p.proof[0].legacy_snapshot.jobs.media_pilot_delivery.maximum_cents,100);
 financial.data.jobs.media_pilot_delivery.status='started';const legacy=planControlMigration({project,financial,capacity,automation:controls,admission:controls});assert.equal(legacy.proof[0].legacy_snapshot.jobs.media_pilot_delivery.status,'started');
 assert.equal(p.writes.filter(w=>w.exists===false).length,34);assert.equal(p.writes.at(-1).updateTime,'a1');
 assert.throws(()=>planControlMigration({project,financial,capacity,automation:{...controls,data:{enabled:true}},admission:controls}),/Pausar/);
 assert.throws(()=>planControlMigration({project,financial:{...financial,data:{...financial.data,jobs:{...financial.data.jobs,[job(999)]:{stage:'analysis',status:'started'}}}},capacity,automation:controls,admission:controls}),/Pausar/);
});
test('unknown fragments are fail-closed and capacity uses a separate bounded namespace',()=>{
 const f=fixture();assert.throws(()=>hydrateFragments(path,{...f.root,control_fragments:{...f.root.control_fragments,digest:'0'.repeat(64)}},f.chunks),/divergem/);
 const cp='settings/capacity',claims={['object_'+createHash('sha256').update('key').digest('hex')]:{reserved_bytes:1050,bytes:1000,digest:'a'.repeat(64)}};
 const chunks=splitControlMap(cp,claims).map((entries,index)=>({path:fragmentPath(fragmentSpec(cp),index),data:{schema_version:1,owner:cp,index,entries},updateTime:'v1'}));
 assert.deepEqual(hydrateFragments(cp,{claims:{},control_fragments:fragmentMarker(cp,claims)},chunks).data.claims,claims);assert.equal(fragmentCount,16);
});

test('only definitely rejected Firestore metadata429 gets bounded backoff; unknown commit is not retried',async()=>{
 const s=server(),original=s.api.request,delays=[];let rejected=0;
 s.api.request=async(u,o)=>{if(u.endsWith(':commit')&&++rejected<=2)throw Object.assign(Error('rejected'),{status:429,provider_diagnostic:{status:'RESOURCE_EXHAUSTED'}});return original(u,o);};
 await mutateDocument(s.store,path,async x=>({changes:{spent_cents:x.data.spent_cents+1}}),{sleep:async ms=>delays.push(ms)});
 assert.deepEqual(delays,[100,200]);assert.equal(s.commits.length,1);assert.equal((await s.store.get(path)).data.spent_cents,27501);
 s.api.request=async(u,o)=>{if(u.endsWith(':commit'))throw Object.assign(Error('rejected'),{status:429,provider_diagnostic:{status:'RESOURCE_EXHAUSTED'}});return original(u,o);};
 const before=delays.length;await assert.rejects(mutateDocument(s.store,path,async()=>({changes:{paused:true}}),{sleep:async ms=>delays.push(ms)}),e=>e.status===429);assert.equal(delays.length-before,2);
});

test('fragmented real financial ledger preserves four concurrent reservations, pause and uncertain coverage',async()=>{
 const f=fixture(0),s=server(f),now=Date.parse('2026-10-14T04:00:00Z');
 s.docs.get(path).data={...newLedger(),...f.root,paused:false,allocation_cents:170000,coverage_verified:true,ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),credit_expires_at:'2026-11-23T00:00:00Z',enabled_stages:{upload:true,analysis:true,transcription:true}};
 const ledger=new FinancialLedger(s.store,{clock:()=>now});
 await Promise.all(Array.from({length:4},(_,i)=>ledger.reserve({executionId:`run${i}`,videoId:`video${i}`,stage:'analysis',maximumCents:50})));
 assert.equal((await s.store.get(path)).data.reserved_cents,300);
 await Promise.all(Array.from({length:4},(_,i)=>ledger.transition(`run${i}`,'start')));
 await Promise.all(Array.from({length:4},(_,i)=>i===3?ledger.transition('run3','uncertain'):ledger.transition(`run${i}`,'complete',{actualCents:25})));
 const after=(await s.store.get(path)).data;assert.equal(after.spent_cents,75);assert.equal(after.reserved_cents,150);assert.equal(after.paused,true);assert.equal(after.jobs.media_pilot_delivery.maximum_cents,100);
 await assert.rejects(ledger.transition('run3','cancel'));await assert.rejects(ledger.reserve({executionId:'other',videoId:'video3',stage:'analysis',maximumCents:50}));
 assert.ok(s.commits.every(w=>w.length<=2));
});
test('fragmented storage capacity keeps immutable-object dedupe and cannot release or double-count bytes',async()=>{
 const f=fixture(0),s=server(f),cp='settings/capacity';s.docs.get(path).data.ongoing_storage_planned_bytes=50000;
 const spec=fragmentSpec(cp),root={schema_version:1,enabled:true,limit_bytes:50000,admitted_bytes:0,claim_limit:100,claims:{},control_fragments:fragmentMarker(cp,{})};
 s.docs.set(cp,{data:root,updateTime:'v1'});for(let index=0;index<16;index++)s.docs.set(fragmentPath(spec,index),{data:{schema_version:1,owner:cp,index,entries:{}},updateTime:'v1'});
 const capacity=new StorageCapacity(s.store),input={bucket:project+'-media',key:'originals/instagram/Reel_1/video.mp4',bytes:1000,digest:'a'.repeat(64)};
 await capacity.admit(input);const first=await s.store.get(cp);await capacity.admit(input);assert.equal((await s.store.get(cp)).data.admitted_bytes,first.data.admitted_bytes);assert.equal(Object.keys(first.data.claims).length,1);
 await assert.rejects(capacity.admit({...input,digest:'b'.repeat(64)}),/diverge/);assert.ok(s.commits.every(w=>w.length===2));
});
