export function validateWebConfig(config,secrets={}){
  if(config?.environment!=='google-v0'||config.project_id!=='megabrain-v0-1017370021431')throw new Error('Projeto v0 obrigatório.');
  const url=new URL(config.origin);
  if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||['megabrain.midelim.tech','paperclip.midelim.tech','remotedc.midelim.tech'].includes(url.hostname))throw new Error('Origem HTTPS independente obrigatória.');
  if(config.allowed_email!=='midelim.dev@gmail.com')throw new Error('Conta autorizada inválida.');
  if(config.media_bucket!==config.project_id+'-media')throw new Error('Bucket independente obrigatório.');
  if(typeof secrets.session_secret!=='string'||secrets.session_secret.length<43)throw new Error('Segredo próprio de sessão obrigatório.');
  if(typeof secrets.google_client_id!=='string'||!secrets.google_client_id.endsWith('.apps.googleusercontent.com')||typeof secrets.google_client_secret!=='string'||!secrets.google_client_secret)throw new Error('OAuth próprio não configurado.');
  return {...config,origin:url.origin,...secrets};
}
