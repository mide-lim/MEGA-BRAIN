import {automationChanges} from './controls.mjs';
import {parseReelLinks}from './links.mjs';
const idPattern=/^[A-Za-z0-9_-]{5,32}$/;
export class LibraryRepository{
  constructor(store){this.store=store;}
  async page({cursor,pageSize=40}={}){
    const result=await this.store.list('videos',{pageSize,pageToken:cursor});
    return {videos:result.records.map(({data})=>({id:data.id,source_url:data.source_url,status:data.status,
      duration_seconds:data.duration_seconds,has_audio:data.has_audio,audio_status:data.audio_status,
      media_verified:data.media_verified,transcript:data.transcript??'',transcript_status:data.transcript_status??null,analysis:data.analysis??null,
      analysis_legacy:data.analysis_legacy??null,error:data.error??null,updated_at:data.updated_at})),next_cursor:result.nextPageToken};
  }
  async video(id){if(!idPattern.test(id??''))throw new Error('Vídeo inválido.');return (await this.store.get(`videos/${id}`))?.data??null;}
  async registerLinks(input){
    const links=parseReelLinks(input);let created=0;const now=new Date().toISOString();
    for(const link of links){const result=await this.store.create(`videos/${link.id}`,{id:link.id,source_url:link.url,status:'pending',video_key:null,
      video_generation:null,video_bytes:null,media_verified:false,has_audio:null,audio_status:null,duration_seconds:null,
      transcript:'',analysis:null,analysis_legacy:null,error:null,created_at:now,updated_at:now});if(result.created)created++;}
    return {created,already_present:links.length-created,automatic_processing_started:false};
  }
  async controls(){return (await this.store.get('settings/automation'))?.data??{enabled:false,transcription_enabled:false,analysis_enabled:false,parallelism:1};}
  async updateControls(body){
    const changes=automationChanges(body);const state=await this.store.get('settings/automation');
    if(!state)throw new Error('Controles não inicializados.');
    const result=await this.store.patch('settings/automation',changes,{updateTime:state.updateTime});return result.data;
  }
}
