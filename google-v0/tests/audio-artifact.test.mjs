import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePreparedAudio,preparedAudioFields} from '../lib/audio-artifact.mjs';
const video={id:'Reel_audio',video_key:'originals/instagram/Reel_audio/video.mp4',video_generation:'1'},key='results/instagram/Reel_audio/job_test/audio.flac';
const fields={audio_key:key,audio_generation:'2',audio_bytes:32,audio_sha256:'a'.repeat(64),audio_source_key:video.video_key,audio_source_generation:'1'};
test('absent audio reference is legacy and a complete matching reference is accepted',()=>{assert.equal(validatePreparedAudio(video,key),false);assert.equal(validatePreparedAudio({...video,...fields},key),true);});
for(const field of preparedAudioFields)test(`audio reference missing ${field} fails closed`,()=>{const ref={...video,...fields};delete ref[field];assert.throws(()=>validatePreparedAudio(ref,key));});
for(const [field,value] of [['audio_bytes',0],['audio_bytes',100000001],['audio_sha256','bad'],['audio_generation','oops'],['audio_source_key','originals/instagram/Other_id/video.mp4'],['audio_source_generation','99'],['audio_key',key+'wrong']])test(`audio reference rejects invalid ${field} ${value}`,()=>{assert.throws(()=>validatePreparedAudio({...video,...fields,[field]:value},key));});
