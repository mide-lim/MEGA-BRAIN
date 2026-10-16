import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisRuntime} from '../lib/stage-analysis.mjs';
import {stageBoundFlow} from '../lib/stage-contract.mjs';
import {WorkerFlow,executionId} from '../lib/worker-flow.mjs';
import {workerHandler} from '../lib/worker-queue.mjs';

const routes={
  upload:{queue:'v0-acquisition',workerOrigin:'https://acquisition.example.run.app'},
  transcription:{queue:'v0-transcription',workerOrigin:'https://transcription.example.run.app'},
  analysis:{queue:'v0-analysis',workerOrigin:'https://analysis.example.run.app'}
};
const request=(stage='analysis',poll=0)=>new Request('https://analysis.example.run.app/tasks/run',{method:'POST',body:JSON.stringify({videoId:'Reel_1',stage,poll})});
function fixture({failProvider=false,failPublication=false}={}){
  let version=0,calls=0;const events=[],artifacts=new Map(),docs=new Map();
  const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
  seed('settings/automation',{enabled:true,analysis_enabled:true,transcription_enabled:true});
  seed('videos/Reel_1',{media_verified:true,audio_status:'present',transcript:'Texto persistido',transcript_key:'saved-transcript.json',transcript_generation:'41'});
  const store={
    async get(path){return structuredClone(docs.get(path)??null);},
    async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},
    async patch(path,changes,{updateTime}){
      assert.equal(docs.get(path)?.updateTime,updateTime);
      if(failPublication&&path==='videos/Reel_1'&&changes.analysis)throw Error('offline publication failure');
      seed(path,{...docs.get(path).data,...changes});return this.get(path);
    }
  };
  const ledger={
    async reserve(input){events.push({kind:'reserve',...input});},
    async transition(id,kind,details){
      if(kind==='complete'){
        const saved=(await store.get('videos/Reel_1')).data;
        assert.equal(saved.analysis_key,`results/instagram/Reel_1/${id}/analysis.json`);
        assert.ok(artifacts.has(saved.analysis_key));assert.equal(saved.status,'analyzed');
      }
      events.push({kind,id,...details});
    }
  };
  const operations={
    async upload(){assert.fail('analysis worker called upload');},
    async transcription(){assert.fail('analysis worker submitted STT');},
    async pollTranscription(){assert.fail('analysis worker polled STT');},
    async analysis({video,executionId:id}){
      calls++;if(failProvider)throw Error('offline inference timeout');
      const key=`results/instagram/${video.id}/${id}/analysis.json`;
      artifacts.set(key,{analysis:{title:'Resultado persistido'},generation:'42'});
      return {video_id:video.id,stage:'analysis',actual_cents:4,changes:{analysis:{title:'Resultado persistido'},analysis_key:key,analysis_generation:'42',analysis_quality_status:'accepted'}};
    }
  };
  const raw=new WorkerFlow({store,ledger,operations,quotes:{analysis:10},clock:()=>1000});
  const flow=stageBoundFlow(raw,'analysis');
  const dispatched=[];
  const handler=workerHandler({flow,stage:'analysis',queue:{async enqueue(task){dispatched.push(task);return {status:'queued'};}},authorize:async()=>true});
  return {flow,handler,store,events,artifacts,dispatched,get calls(){return calls;}};
}

test('analysis factory fixes its role and stays closed without storage/provider calls',async()=>{
  const flow=analysisRuntime({project:'megabrain-v0-1017370021431',cost_accounting:'conservative_estimate_not_invoice',worker_stage:'analysis',worker_origin:routes.analysis.workerOrigin,stage_routes:routes,enabled:false,dispatch_enabled:false,admission_enabled:false,assisted_upload_enabled:false,assisted_single_upload_enabled:false,quotes:{analysis:10},pilot_video_ids:[]},{},{withHandler:false});
  assert.deepEqual(await flow.run({videoId:'Reel_1',stage:'analysis',poll:0}),{status:'blocked',reason:'stage_disabled'});
});
test('analysis completion publishes persisted result before settlement and duplicate never pays again',async()=>{
  const f=fixture();
  for(let i=0;i<2;i++){
    const response=await f.handler(request());assert.equal(response.status,200);
    const body=await response.json();assert.equal(body.status,'completed');assert.equal(body.dispatch,null);
  }
  const saved=(await f.store.get('videos/Reel_1')).data;
  assert.equal(saved.analysis_generation,'42');assert.equal(saved.transcript_generation,'41');
  assert.equal(saved.analysis.title,'Resultado persistido');
  assert.equal(f.calls,1);assert.equal(f.events.filter(e=>e.kind==='reserve').length,1);
  assert.equal(f.events.filter(e=>e.kind==='complete').length,1);assert.equal(f.dispatched.length,0);
  assert.equal((await f.store.get('jobs/'+executionId('Reel_1','analysis'))).data.status,'completed');
});
for(const failure of ['provider','publication'])test(`uncertain ${failure} failure preserves claim and never infers or dispatches on redelivery`,async()=>{
  const f=fixture({failProvider:failure==='provider',failPublication:failure==='publication'});
  for(let i=0;i<2;i++){const response=await f.handler(request());assert.equal((await response.json()).status,'uncertain');}
  assert.equal(f.calls,1);assert.equal(f.events.filter(e=>e.kind==='reserve').length,1);
  assert.equal(f.events.filter(e=>e.kind==='uncertain').length,1);
  assert.equal(f.events.filter(e=>e.kind==='complete').length,0);assert.equal(f.dispatched.length,0);
  assert.equal(f.artifacts.size,failure==='publication'?1:0);
  assert.equal((await f.store.get('jobs/'+executionId('Reel_1','analysis'))).data.status,'uncertain');
});
test('analysis role rejects upload, STT and polling before touching the underlying flow',async()=>{
  let calls=0;const flow=stageBoundFlow({async run(){calls++;},async poll(){calls++;}},'analysis');
  for(const stage of ['upload','transcription'])await assert.rejects(async()=>flow.run({videoId:'Reel_1',stage,poll:0}));
  await assert.rejects(async()=>flow.poll({videoId:'Reel_1'}));assert.equal(calls,0);
});
test('analysis HTTP role rejects cross-stage tasks before flow or queue calls',async()=>{
  let calls=0;const handler=workerHandler({stage:'analysis',authorize:async()=>true,flow:{async run(){calls++;},async poll(){calls++;}},queue:{async enqueue(){calls++;}}});
  for(const [stage,poll] of [['upload',0],['transcription',0],['transcription',1]]){
    const response=await handler(request(stage,poll));assert.ok(response.status>=400&&response.status<500);
  }
  assert.equal(calls,0);
});
