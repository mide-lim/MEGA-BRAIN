import test from 'node:test';
import assert from 'node:assert/strict';
import {googleOperations} from '../lib/google-operations.mjs';
import {executionId} from '../lib/worker-flow.mjs';
import {sha256} from '../lib/storage.mjs';
const project='megabrain-v0-1017370021431',id='Reel_audio',audio=Buffer.from('simulated FLAC'),media=Buffer.from('simulated MP4'),key=`originals/instagram/${id}/video.mp4`,audioKey=`results/instagram/${id}/${executionId(id,'transcription')}/audio.flac`;
function fixture({stage,sync=false,extractFail=false,writeFail=false,persistFail=false,requireRecorded=false}={}){
 const calls={paid:0,extract:0,download:0,reads:[],writes:[],recorded:0},objects=new Map(),video={id,video_key:key,video_generation:'1',duration_seconds:10,media_verified:true,audio_status:'present'};
 objects.set(key,{bytes:media,generation:'1',size:String(media.length),metadata:{sha256:sha256(media)}});
 const storage={bucket:project+'-media',
  async metadata(key){const x=objects.get(key);return x?{generation:x.generation,size:x.size,metadata:x.metadata}:null;},
  async read(key,{generation}={}){calls.reads.push(key);const x=objects.get(key);assert.ok(x);assert.equal(generation,x.generation);return x.bytes;},
  async writeImmutable(key,bytes){calls.writes.push(key);if(writeFail&&key.endsWith('audio.flac'))throw Error('storage failed');const old=objects.get(key);if(old){assert.equal(sha256(old.bytes),sha256(bytes));return {generation:old.generation,size:bytes.length,sha256:sha256(bytes)};}const generation=String(objects.size+1);objects.set(key,{bytes,generation,size:String(bytes.length),metadata:{sha256:sha256(bytes)}});return {generation,size:bytes.length,sha256:sha256(bytes)};}
 };
 const api={project,async request(url){if(requireRecorded)assert.equal(calls.recorded,1);calls.paid++;if(url.endsWith(':recognize'))return {results:[{alternatives:[{transcript:'texto'}]}]};if(url.endsWith(':batchRecognize'))return {name:`projects/${project}/locations/us/operations/one`};return {done:true,response:{results:{[`gs://${storage.bucket}/${audioKey}`]:{inlineResult:{transcript:{results:[{alternatives:[{transcript:'texto'}]}]}}}}}};}};
 const config={enabled:true,uploads_enabled:true,worker_stage:stage,quotes:{upload:10,transcription:10},speech_model:'chirp_3',speech_location:'us',language_codes:['pt-BR'],synchronous_short_audio:sync};
 const operations=googleOperations({api,storage,tools:{async download(){calls.download++;return media;},async extractAudio(bytes){calls.extract++;assert.deepEqual(bytes,media);if(extractFail)throw Error('ffmpeg failed');return audio;}},preset:{},config,gate:async()=>({maximum_cents:10}),inspect:async()=>({audio_status:'present',duration_seconds:10})});
 const recordPreparedAudio=async changes=>{calls.recorded++;if(persistFail)throw Error('video CAS failed');Object.assign(video,changes);};
 return {operations,video,objects,calls,recordPreparedAudio,storage};
}
test('upload stage persists FLAC with exact source lineage before returning handoff changes',async()=>{
 const f=fixture({stage:'upload'}),r=await f.operations.upload({video:{id},executionId:executionId(id,'upload')});
 assert.equal(f.calls.extract,1);assert.deepEqual(f.calls.writes,[key,audioKey]);assert.equal(r.changes.audio_key,audioKey);assert.equal(r.changes.audio_source_key,key);assert.equal(r.changes.audio_source_generation,r.changes.video_generation);assert.equal(r.changes.audio_sha256,sha256(audio));assert.equal(r.changes.audio_bytes,audio.length);assert.equal(f.calls.paid,0);
});
for(const type of ['legacy','assisted'])test(`${type} upload preserves MP4-only behavior`,async()=>{
 const f=fixture();await f.operations.upload({video:{id},executionId:executionId(id,'upload')});assert.equal(f.calls.extract,0);assert.deepEqual(f.calls.writes,[key]);assert.equal(f.objects.has(audioKey),false);
});
for(const failure of ['extractFail','writeFail'])test(`upload ${failure} cannot return a successful handoff`,async()=>{
 const f=fixture({stage:'upload',[failure]:true});await assert.rejects(f.operations.upload({video:{id},executionId:executionId(id,'upload')}));assert.equal(f.calls.paid,0);assert.equal(f.objects.has(key),true);assert.equal(f.objects.has(audioKey),false);
});
for(const sync of [false,true])test(`verified prepared audio is reused without reading MP4 or conversion (sync=${sync})`,async()=>{
 const f=fixture({stage:'upload',sync}),r=await f.operations.upload({video:{id},executionId:executionId(id,'upload')});Object.assign(f.video,r.changes);f.calls.reads=[];f.calls.writes=[];const before=f.calls.extract;
 const result=await f.operations.transcription({video:f.video,executionId:executionId(id,'transcription'),recordPreparedAudio:f.recordPreparedAudio});
 assert.equal(f.calls.extract,before);assert.deepEqual(f.calls.reads,[audioKey]);assert.equal(f.calls.writes.some(key=>key.endsWith('audio.flac')),false);assert.equal(f.calls.paid,1);assert.equal(f.calls.recorded,0);
 if(sync){assert.equal(result.changes.transcript,'texto');assert.equal(result.changes.audio_generation,f.video.audio_generation);}else{assert.match(result.operation_name,/operations\/one$/);const polled=await f.operations.pollTranscription({operationName:result.operation_name,videoId:id,executionId:executionId(id,'transcription')});assert.equal(polled.changes.transcript,'texto');assert.equal(f.calls.extract,before);}
});
for(const fault of ['partial','audio-generation','audio-checksum','audio-bytes','source-generation','lineage','path'])test(`prepared audio ${fault} blocks before paid request and conversion`,async()=>{
 const f=fixture({stage:'upload'}),r=await f.operations.upload({video:{id},executionId:executionId(id,'upload')});Object.assign(f.video,r.changes);
 if(fault==='partial')delete f.video.audio_sha256;
 if(fault==='audio-generation')f.objects.get(audioKey).generation='99';
 if(fault==='audio-checksum')f.objects.get(audioKey).bytes=Buffer.from('altered FLAC');
 if(fault==='audio-bytes')f.objects.get(audioKey).size='999';
 if(fault==='source-generation')f.objects.get(key).generation='99';
 if(fault==='lineage')f.video.audio_source_generation='99';
 if(fault==='path')f.video.audio_key='results/instagram/Other_reel/audio.flac';
 const before=f.calls.extract;await assert.rejects(f.operations.transcription({video:f.video,executionId:executionId(id,'transcription')}));assert.equal(f.calls.paid,0);assert.equal(f.calls.extract,before);
});
test('legacy conversion persists its reference before batch submission and is reusable',async()=>{
 const f=fixture({requireRecorded:true});await f.operations.transcription({video:f.video,executionId:executionId(id,'transcription'),recordPreparedAudio:f.recordPreparedAudio});assert.equal(f.calls.recorded,1);assert.equal(f.calls.extract,1);assert.equal(f.video.audio_sha256,sha256(audio));
 // Simulates a caller only preparing/reusing bytes, not WorkerFlow retry rights.
 f.calls.paid=0;f.calls.reads=[];await f.operations.transcription({video:f.video,executionId:executionId(id,'transcription')});assert.equal(f.calls.extract,1);assert.deepEqual(f.calls.reads,[audioKey]);assert.equal(f.calls.paid,1);
});
test('legacy orphan cannot be trusted or overwritten and does not call provider',async()=>{
 const f=fixture();f.objects.set(audioKey,{bytes:audio,generation:'2',size:String(audio.length),metadata:{sha256:sha256(audio)}});await assert.rejects(f.operations.transcription({video:f.video,executionId:executionId(id,'transcription')}),/sem referência/);assert.equal(f.calls.extract,0);assert.equal(f.calls.paid,0);assert.deepEqual(f.calls.writes,[]);
});
test('legacy reference persistence failure holds the FLAC and prevents paid submission/reconversion',async()=>{
 const f=fixture({persistFail:true});await assert.rejects(f.operations.transcription({video:f.video,executionId:executionId(id,'transcription'),recordPreparedAudio:f.recordPreparedAudio}),/CAS/);assert.equal(f.objects.has(audioKey),true);assert.equal(f.calls.paid,0);
 await assert.rejects(f.operations.transcription({video:f.video,executionId:executionId(id,'transcription'),recordPreparedAudio:f.recordPreparedAudio}),/sem referência/);assert.equal(f.calls.extract,1);assert.equal(f.calls.paid,0);
});
