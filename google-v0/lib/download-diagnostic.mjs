const messages=Object.freeze({none:'Consulta de metadados concluída com sucesso.',empty_media_response:'O extrator recebeu uma resposta sem mídia; a disponibilidade do Reel não foi confirmada.',unknown:'A ferramenta não forneceu uma causa reconhecida.',http_403:'A origem respondeu HTTP 403; a causa da restrição não foi determinada.',http_404:'A origem respondeu HTTP 404; isso não comprova remoção definitiva.',http_429:'A origem respondeu HTTP 429 (limitação de requisições).',login_required:'A ferramenta informou que o acesso exige autenticação.',unavailable:'A ferramenta informou que o conteúdo não está disponível.',format_unavailable:'A ferramenta não encontrou o formato solicitado.',network_error:'A ferramenta informou falha de conexão ou resolução de nome.',timeout:'A ferramenta informou tempo limite excedido.',process_interrupted:'O processo foi interrompido; a causa não foi determinada.',output_limit:'O processo excedeu o limite de saída de diagnóstico.',file_invalid:'O arquivo final está ausente, vazio ou acima do limite.',local_io:'Houve uma falha local de leitura ou escrita.'});
// Additional detail is an enum with fixed copy, never an excerpt of tool output.
// Keep cause stable: existing recovery/hold policies consume that coarse field.
const downloadDetails=Object.freeze({
 metadata_extraction_failed:'O extrator informou falha ao interpretar os dados de metadados da origem; a disponibilidade do Reel não foi confirmada.',
 metadata_json_invalid:'O extrator informou uma resposta de metadados que não conseguiu interpretar como JSON.',
 source_auth_challenge:'A origem informou um desafio de autenticação; o acesso ao Reel não foi confirmado.',
 source_rate_limited:'A ferramenta informou limitação de requisições na origem; nenhuma nova tentativa foi iniciada.',
 source_http_400:'A ferramenta informou HTTP 400 ao consultar a origem; o motivo da rejeição não foi determinado.',
 source_http_401:'A ferramenta informou HTTP 401 ao consultar a origem; o motivo da rejeição não foi determinado.',
 source_http_5xx:'A ferramenta informou HTTP 5xx ao consultar a origem; a disponibilidade do Reel não foi confirmada.',
 tls_validation_failed:'A ferramenta informou falha de validação do certificado da conexão com a origem.',
 extractor_unavailable:'A ferramenta informou que não encontrou um extrator compatível com a origem.',
 metadata_error_unclassified:'O extrator encerrou com erro durante a leitura dos metadados; o diagnóstico disponível não identifica a causa nem confirma a disponibilidade do Reel.'
});
const phases=new Set(['unknown','source_validation','metadata','format_selection','transfer','merge','remux','file_validation','media_validation','storage_write']);
const version=(v,kind)=>typeof v==='string'&&(kind==='yt-dlp'?/^\d{4}\.\d{2}\.\d{2}$/:/^\d+\.\d+(?:\.\d+)?$/).test(v)?v:null;
// Only fixed messages and allowlisted scalar values cross the persistence boundary.
// Never forward stderr, stdout, error.message, commands, URLs or arbitrary labels.
export function safeDownloadDiagnostic(value){
 let cause=typeof value?.cause==='string'&&Object.hasOwn(messages,value.cause)?value.cause:'unknown';
 if(cause==='none'&&(value?.phase!=='metadata'||value?.exit_code!==0))cause='unknown';
 const detail=cause==='unknown'&&Number.isInteger(value?.exit_code)&&value.exit_code>0&&value.exit_code<=255?(typeof value?.detail_code==='string'&&Object.hasOwn(downloadDetails,value.detail_code)&&value.detail_code!=='metadata_error_unclassified'?value.detail_code:value?.phase==='metadata'?'metadata_error_unclassified':null):null;
 return {...(detail?{detail_code:detail}:{}),phase:phases.has(value?.phase)?value.phase:'unknown',phase_source:['boundary','tool_output'].includes(value?.phase_source)?value.phase_source:'boundary',cause,message:detail?downloadDetails[detail]:messages[cause],elapsed_ms:Number.isSafeInteger(value?.elapsed_ms)&&value.elapsed_ms>=0&&value.elapsed_ms<=600000?value.elapsed_ms:null,exit_code:Number.isInteger(value?.exit_code)&&value.exit_code>=0&&value.exit_code<=255?value.exit_code:null,tool:'yt-dlp',yt_dlp_version:version(value?.yt_dlp_version,'yt-dlp'),ffmpeg_version:version(value?.ffmpeg_version,'ffmpeg')};
}
