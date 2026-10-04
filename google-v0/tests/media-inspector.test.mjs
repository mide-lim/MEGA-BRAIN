import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProbe,audioStatus,inspectMedia} from '../lib/media-inspector.mjs';
test('no audio stream and silent audio are distinct diagnostic states',()=>{
  const media=parseProbe({format:{duration:'30.5'},streams:[{codec_type:'video'}]});assert.equal(media.hasAudio,false);
  assert.equal(audioStatus('',false).audio_status,'missing');
  assert.equal(audioStatus('max_volume: -inf dB',true).audio_status,'silent');
  assert.equal(audioStatus('max_volume: -3.2 dB',true).audio_status,'present');
  assert.throws(()=>audioStatus('decoder failed',true));
});
test('invalid duration and non-video input are rejected before paid processing',()=>{
  assert.throws(()=>parseProbe({format:{duration:'NaN'},streams:[{codec_type:'video'}]}));
  assert.throws(()=>parseProbe({format:{duration:700},streams:[{codec_type:'video'}]}));
  assert.throws(()=>parseProbe({format:{duration:30},streams:[{codec_type:'audio'}]}));
});
test('full decode uses conventional tools without a shell',async()=>{
  const calls=[];const run=async(command,args)=>{calls.push({command,args});return command==='ffprobe'?{stdout:JSON.stringify({format:{duration:30},streams:[{codec_type:'video'},{codec_type:'audio'}]})}:{stderr:'max_volume: -2 dB'};};
  const result=await inspectMedia(Buffer.from('test fixture'),{run});assert.equal(result.audio_status,'present');
  assert.equal(calls.length,2);assert.equal(calls[0].command,'ffprobe');assert.equal(calls[1].command,'ffmpeg');assert.ok(calls[1].args.includes('-xerror'));
});
