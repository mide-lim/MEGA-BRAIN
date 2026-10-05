import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {WorkerFlow} from '../lib/worker-flow.mjs';
import {FinancialLedger,newLedger} from '../lib/financial-ledger.mjs';
import {workerReservationGate} from '../lib/worker-reservation-gate.mjs';
import {googleOperations} from '../lib/google-operations.mjs';
import {GoogleREST} from '../lib/google-rest.mjs';
import {Storage} from '../lib/storage.mjs';
import {StorageCapacity,newCapacity} from '../lib/storage-capacity.mjs';
import {readFile} from 'node:fs/promises';

for(const profile of [{location:'global',model:'offline_model',gemini:'gemini-offline-model'},{location:'us',model:'chirp_3',gemini:'gemini-3.5-flash-lite'},{location:'us',model:'chirp_3',gemini:'gemini-3.5-flash-lite',synchronous:true},{location:'us',model:'chirp_3',gemini:'gemini-3.5-flash-lite',synchronous:true,noSpeech:true},{location:'us',model:'chirp_3',gemini:'gemini-3.5-flash-lite',readFault:true}])test(`Google adapters integrate upload, async STT and validated Gemini (${profile.location}, ${profile.readFault?'read-fault':profile.noSpeech?'no-speech':profile.synchronous?'sync':'batch'}) with durable reservations`,async()=>{
  const project='megabrain-v0-1017370021431',bucket=project+'-media',videoId='Reel_123',now=Date.now();let version=0,submits=0,analyses=0,polls=0,injectReadFault=false;
  const docs=new Map(),objects=new Map(),calls=[];
  const seed=(path,data)=>docs.set(path,{data:structuredClone(data),updateTime:String(++version)});
  const store={async get(path){return structuredClone(docs.get(path)??null);},async create(path,data){if(docs.has(path))return {created:false};seed(path,data);return {created:true};},async patch(path,changes,{updateTime}){assert.equal(docs.get(path)?.updateTime,updateTime);seed(path,{...docs.get(path).data,...changes});return this.get(path);}};
  seed('settings/automation',{enabled:true,transcription_enabled:true,analysis_enabled:true});
  seed('settings/financial',{...newLedger(),paused:false,coverage_verified:true,ongoing_commitment_cents:0,ongoing_costs_observed_at:new Date(now).toISOString(),ongoing_costs_valid_until:new Date(now+86400000).toISOString(),remaining_credit_cents:172411,balance_observed_at:new Date(now).toISOString(),credit_expires_at:new Date(now+30*86400000).toISOString(),enabled_stages:{upload:true,transcription:true,analysis:true}});
  seed('videos/'+videoId,{id:videoId,source_url:'https://www.instagram.com/p/'+videoId+'/',media_verified:false,transcript:''});
  const report={title:'Tecnologia',summary:'Resumo com evidências',categories:['Tecnologia'],useful_information:[{claim:'Ideia do autor',application:'Estudar',classification:'author_claim',evidence:[{source:'transcript',start_seconds:0,end_seconds:1,excerpt:'Texto reconhecido'}]}],visual_observations:[],limitations:['Exemplo simulado'],transcript_quality:{assessment:'Clara',uncertain_segments:[]}};
  if(profile.noSpeech){report.useful_information[0].evidence[0].source='video';report.useful_information[0].evidence[0].excerpt='Texto na tela';}
  report.knowledge={context:'technology',keywords:[{term:'Tecnologia',evidence:structuredClone(report.useful_information[0].evidence)}],fields:[{kind:'concept',name:'Conceito apresentado',value:'Texto de exemplo',evidence:structuredClone(report.useful_information[0].evidence)}],missing_information:[]};
  const api=new GoogleREST({project,buckets:[bucket],tokenProvider:async()=>'offline-test-token',fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push({url,method:options.method});
    if(u.hostname==='storage.googleapis.com'){
      if(u.pathname.startsWith('/upload/')){
        const body=options.body.toString(),match=body.match(/\r\n\r\n(\{"name"[^\r]+)\r\n--/);assert.ok(match);
        const meta=JSON.parse(match[1]),start=body.indexOf('\r\n\r\n',body.indexOf('Content-Type:',body.indexOf(match[1])+match[1].length))+4,end=body.lastIndexOf('\r\n--');
        const bytes=Buffer.from(body.slice(start,end));objects.set(meta.name,{bytes,meta:{...meta,generation:String(objects.size+1),size:String(bytes.length)}});
        return Response.json(objects.get(meta.name).meta);
      }
      const key=decodeURIComponent(u.pathname.split('/o/')[1]),object=objects.get(key);
      if(!object)return new Response('',{status:404});
      if(injectReadFault&&u.searchParams.get('alt')==='media')return new Response('private error text must not be stored',{status:403});
      return u.searchParams.get('alt')==='media'?new Response(object.bytes):Response.json(object.meta);
    }
    if(['speech.googleapis.com','us-speech.googleapis.com'].includes(u.hostname)){
      assert.equal(u.hostname,profile.location==='us'?'us-speech.googleapis.com':'speech.googleapis.com');
      if(options.method==='POST'){
        submits++;const request=JSON.parse(options.body);
        if(profile.synchronous){assert.match(u.pathname,/:recognize$/);assert.equal(Buffer.from(request.content,'base64').toString(),'simulated flac');assert.equal(request.files,undefined);return Response.json({results:[{alternatives:[profile.noSpeech?{}:{transcript:'Texto reconhecido'}]}]});}
        assert.equal(request.files.length,1);assert.ok(request.recognitionOutputConfig.inlineResponseConfig);
        assert.equal(request.config.model,profile.model);assert.equal(request.config.features.enableWordTimeOffsets,true);
        return Response.json({name:`projects/${profile.location==='us'?'711042421394':project}/locations/${profile.location}/operations/speech_1`});
      }
      if(++polls===1)return Response.json({done:false});
      const audioKey=[...objects.keys()].find(k=>k.endsWith('/audio.flac'));
      return Response.json({done:true,response:{results:{[`gs://${bucket}/${audioKey}`]:{inlineResult:{transcript:{results:[{alternatives:[{transcript:'Texto reconhecido'}]}]}}}}}});
    }
    if(profile.location==='global')assert.equal(JSON.parse(JSON.parse(options.body).contents[0].parts[1].text).caption_raw,'Descrição do post: ferramenta de organização.');
    analyses++;assert.match(u.pathname,/generateContent$/);
    if(profile.gemini==='gemini-3.5-flash-lite'){const config=JSON.parse(options.body).generationConfig;assert.equal(config.thinkingConfig.thinkingLevel,'MINIMAL');assert.equal(config.temperature,undefined);}
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(report)}]}}],usageMetadata:{totalTokenCount:123}});
  }});
  seed('settings/capacity',{...newCapacity(),enabled:true,limit_bytes:10000});
  const financial=await store.get('settings/financial');await store.patch('settings/financial',{ongoing_storage_planned_bytes:10000},{updateTime:financial.updateTime});
  const capacity=new StorageCapacity(store),storage=new Storage(api,bucket,{admitObject:input=>capacity.admit(input)}),quotes={upload:10,transcription:10,analysis:10};
  const preset=JSON.parse(await readFile(new URL('../config/analysis-preset.json',import.meta.url)));
  const config={enabled:true,uploads_enabled:true,speech_model:profile.model,speech_location:profile.location,language_codes:['pt-BR'],gemini_model:profile.gemini,synchronous_short_audio:profile.synchronous===true,quotes};
  const operations=googleOperations({api,storage,preset,config,gate:workerReservationGate(store,{clock:()=>now}),tools:{...(profile.location==='global'?{captureCaption:async()=>({text:'Descrição do post: ferramenta de organização.',capture_id:createHash('sha256').update('Descrição do post: ferramenta de organização.').digest('hex'),captured_at:new Date().toISOString()})}:{}),download:async()=>Buffer.from('simulated video'),extractAudio:async()=>Buffer.from('simulated flac')},inspect:async()=>({audio_status:'present',duration_seconds:10})});
  const flow=new WorkerFlow({store,operations,quotes,eligibleVideos:[videoId],ledger:new FinancialLedger(store,{clock:()=>now}),clock:()=>now});
  assert.equal((await flow.run({videoId:'Other_123',stage:'upload'})).reason,'outside_pilot');
  assert.equal((await flow.poll({videoId:'Other_123'})).reason,'outside_pilot');
  assert.equal(docs.has('videos/Other_123'),false);assert.equal(calls.length,0);
  assert.equal((await flow.run({videoId,stage:'upload'})).status,'completed');
  if(profile.readFault){injectReadFault=true;const failed=await flow.run({videoId,stage:'transcription'});assert.equal(failed.status,'uncertain');const job=await store.get('jobs/'+failed.execution_id);assert.deepEqual(job.data.failure_diagnostic,{operation_step:'read_media',http_status:403,tool_code:null});assert.equal(submits,0);assert.equal(analyses,0);assert.equal((await store.get('settings/financial')).data.reserved_cents,10);assert.equal((await flow.run({videoId,stage:'transcription'})).duplicate,true);return;}
  if(profile.synchronous){assert.equal((await flow.run({videoId,stage:'transcription'})).status,'completed');assert.equal(polls,0);}
  else{assert.equal((await flow.run({videoId,stage:'transcription'})).status,'waiting');assert.equal((await flow.poll({videoId})).status,'waiting');assert.equal((await flow.poll({videoId})).status,'completed');}
  if(profile.noSpeech){const video=(await store.get('videos/'+videoId)).data;assert.equal(video.transcript_status,'no_speech_recognized');assert.equal(video.transcript,'');assert.ok(video.transcript_generation);}
  assert.equal((await flow.run({videoId,stage:'analysis'})).status,'completed');
  await flow.run({videoId,stage:'analysis'});assert.equal(submits,1);assert.equal(analyses,1);
  assert.equal(objects.size,profile.location==='global'?5:4);assert.equal((await store.get('videos/'+videoId)).data.analysis.title,'Tecnologia');
  assert.equal((await store.get('videos/'+videoId)).data.analysis.knowledge.fields.length,1);
  assert.equal((await store.get('settings/financial')).data.spent_cents,30);
  assert.ok(calls.every(c=>!c.url.includes('megabrain-stt')&&!c.url.includes('cloudflare')));
  config.enabled=false;await assert.rejects(operations.analysis({video:{id:videoId},executionId:'fake'}),/desligadas/);
});
