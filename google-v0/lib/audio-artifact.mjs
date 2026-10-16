export const preparedAudioFields=Object.freeze(['audio_key','audio_generation','audio_bytes','audio_sha256','audio_source_key','audio_source_generation']);
// References are atomic and bind one immutable FLAC to the exact MP4 generation.
export function validatePreparedAudio(video,expectedAudioKey){
 const present=preparedAudioFields.filter(key=>video?.[key]!==undefined);
 if(!present.length)return false;
 if(present.length!==preparedAudioFields.length||video.audio_key!==expectedAudioKey||
    typeof video.audio_generation!=='string'||!/^\d+$/.test(video.audio_generation)||
    !Number.isSafeInteger(video.audio_bytes)||video.audio_bytes<1||video.audio_bytes>100000000||
    !/^[a-f0-9]{64}$/.test(video.audio_sha256??'')||
    video.audio_source_key!==`originals/instagram/${video.id}/video.mp4`||
    video.audio_source_key!==video.video_key||
    typeof video.audio_source_generation!=='string'||!/^\d+$/.test(video.audio_source_generation)||
    video.audio_source_generation!==video.video_generation)throw Error('Referência de áudio incompleta ou divergente da origem.');
 return true;
}
