const base='http://metadata.google.internal/computeMetadata/v1/';
export function serviceIdentity({project,account='v0-web',fetchImpl=fetch,clock=()=>Date.now()}){
  if(project!=='megabrain-v0-1017370021431'||!['v0-web','v0-worker'].includes(account))throw new Error('Identidade Google independente obrigatória.');
  let token=null,expires=0;
  async function read(path,json=false){const r=await fetchImpl(base+path,{headers:{'Metadata-Flavor':'Google'},redirect:'error',signal:AbortSignal.timeout(5000)});if(!r.ok||r.headers.get('metadata-flavor')!=='Google')throw new Error('Identidade de execução indisponível.');return json?r.json():r.text();}
  return async()=>{
    if(token&&expires>clock()+60000)return token;
    const [actualProject,email]=await Promise.all([read('project/project-id'),read('instance/service-accounts/default/email')]);
    if(actualProject.trim()!==project||email.trim()!==`${account}@${project}.iam.gserviceaccount.com`)throw new Error('Identidade pertence a outro ambiente.');
    const data=await read('instance/service-accounts/default/token',true);
    if(typeof data.access_token!=='string'||!data.access_token||!Number.isFinite(data.expires_in)||data.expires_in<60)throw new Error('Token de execução inválido.');
    token=data.access_token;expires=clock()+data.expires_in*1000;return token;
  };
}
