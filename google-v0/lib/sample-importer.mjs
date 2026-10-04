import {planMigration} from './migration.mjs';
import {sha256} from './storage.mjs';
export class SampleImporter {
  constructor({sourceReader,storage,firestore,mediaInspector,financialCheck,clock=()=>new Date().toISOString()}){
    if(typeof sourceReader!=='function'||typeof mediaInspector!=='function')throw new Error('Leitor e inspetor de mídia obrigatórios.');
    Object.assign(this,{sourceReader,storage,firestore,mediaInspector,financialCheck,clock});
  }
  async run(sample,{apply=false,uploadsEnabled=false,limit=20}={}){
    const plan=planMigration(sample.records,{limit});
    if(!apply)return plan;
    if(uploadsEnabled!==true)throw new Error('Importação permanece em simulação; uploads desligados.');
    if(typeof this.financialCheck!=='function')throw new Error('Verificação financeira obrigatória antes da importação.');
    const results=[];
    for(const item of plan.items){
      const source=sample.records.find(r=>r.id===item.id);
      if(!item.source_key){results.push({id:item.id,status:'deferred'});continue;}
      const decision=await this.financialCheck({id:source.id,bytes:source.object_bytes});
      if(!decision?.ready||decision.uploads_enabled!==true)throw new Error('Importação bloqueada pela reserva financeira ou controle de ativação.');
      const bytes=await this.sourceReader(item.source_key,this.storage.maxBytes);
      if(!Buffer.isBuffer(bytes)||bytes.length>this.storage.maxBytes||bytes.length!==source.object_bytes)throw new Error('Tamanho do arquivo de origem diverge do inventário.');
      const digest=sha256(bytes);
      if(source.source_sha256_metadata&&source.source_sha256_metadata!==digest)throw new Error('Checksum de origem diverge do inventário.');
      const media=await this.mediaInspector(bytes,{id:source.id});
      if(!media?.hasVideo||!Number.isFinite(media.duration_seconds)||media.duration_seconds<=0)throw new Error('Arquivo não é um vídeo válido.');
      if(source.duration_seconds&&Math.abs(media.duration_seconds-source.duration_seconds)>Math.max(1,source.duration_seconds*.01))throw new Error('Duração diverge do inventário.');
      const copied=await this.storage.writeImmutable(item.destination_key,bytes,{contentType:'video/mp4',uploadsEnabled});
      const transcript=typeof source.transcript==='string'?source.transcript:'';
      if(transcript.trim())await this.storage.writeImmutable(`results/instagram/${source.id}/transcript-legacy.json`,Buffer.from(JSON.stringify({transcript_raw:transcript,source_status:source.status})),{contentType:'application/json',uploadsEnabled});
      if(source.analysis)await this.storage.writeImmutable(`results/instagram/${source.id}/analysis-legacy.json`,Buffer.from(JSON.stringify(source.analysis)),{contentType:'application/json',uploadsEnabled});
      const audioProblem=!media.hasAudio||(media.audio_status==='silent'&&Boolean(transcript.trim()));
      const document={id:source.id,source_url:source.source_url,source_status:source.status,status:audioProblem?'needs_attention':'imported',
        video_key:item.destination_key,duration_seconds:media.duration_seconds,has_audio:Boolean(media.hasAudio),media_verified:true,
        audio_status:media.audio_status??(media.hasAudio?'unmeasured':'missing'),
        source_sha256:digest,video_generation:String(copied.generation),video_bytes:bytes.length,transcript,analysis_legacy:source.analysis??null,
        analysis:null,error:audioProblem?'Vídeo copiado fielmente, mas o áudio está ausente ou silencioso quando há transcrição; requer diagnóstico.':null,updated_at:this.clock()};
      const created=await this.firestore.create(`videos/${source.id}`,document);
      if(!created.created){const existing=await this.firestore.get(`videos/${source.id}`);if(existing?.data.source_sha256!==digest)throw new Error('Registro existente diverge da mídia importada.');}
      results.push({id:source.id,status:document.status,created:created.created,sha256:digest,has_audio:document.has_audio});
    }
    return {mode:'apply',items:results,source_deletions:0,paid_model_calls:0};
  }
}
