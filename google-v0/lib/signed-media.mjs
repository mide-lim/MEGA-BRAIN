import {createHash}from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const escape=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function canonicalMediaRequest({project,bucket,id,generation,expiresSeconds=300,now=Date.now()}){
  if(project!=='megabrain-v0-1017370021431'||bucket!==project+'-media'||!/^[A-Za-z0-9_-]{5,32}$/.test(id??'')||!/^\d{1,30}$/.test(generation??''))throw new Error('Mídia fora do escopo Google.');
  if(!Number.isInteger(expiresSeconds)||expiresSeconds<1||expiresSeconds>300||!Number.isFinite(now))throw new Error('Validade da URL inválida.');
  const timestamp=new Date(now).toISOString().replace(/[:-]|\.\d{3}/g,''),date=timestamp.slice(0,8);
  const email=`v0-web@${project}.iam.gserviceaccount.com`,scope=`${date}/auto/storage/goog4_request`;
  const path=`/${bucket}/originals/instagram/${id}/video.mp4`,host='storage.googleapis.com';
  const values={'X-Goog-Algorithm':'GOOG4-RSA-SHA256','X-Goog-Credential':`${email}/${scope}`,'X-Goog-Date':timestamp,
    'X-Goog-Expires':String(expiresSeconds),'X-Goog-SignedHeaders':'host',generation,
    'response-cache-control':'private, no-store','response-content-type':'video/mp4'};
  const query=Object.keys(values).sort().map(k=>`${escape(k)}=${escape(values[k])}`).join('&');
  const canonical=['GET',path,query,`host:${host}\n`,'host','UNSIGNED-PAYLOAD'].join('\n');
  return {email,unsignedUrl:`https://${host}${path}?${query}`,stringToSign:['GOOG4-RSA-SHA256',timestamp,scope,hash(canonical)].join('\n'),expires_at:new Date(now+expiresSeconds*1000).toISOString()};
}
export class SignedMedia{
  constructor({project,bucket,tokenProvider,fetchImpl=fetch,clock=()=>Date.now()}){Object.assign(this,{project,bucket,tokenProvider,fetch:fetchImpl,clock});}
  async issue({id,generation,financialCheck,markStarted,markUncertain}){
    if(typeof financialCheck!=='function'||typeof markStarted!=='function'||typeof markUncertain!=='function')throw new Error('Controle financeiro de reprodução obrigatório.');
    const request=canonicalMediaRequest({project:this.project,bucket:this.bucket,id,generation,now:this.clock()});
    const decision=await financialCheck();if(!decision?.ready||decision.media_access_enabled!==true)throw new Error('Reprodução bloqueada pelo controle financeiro.');
    await markStarted();
    try{
      const token=await this.tokenProvider();if(typeof token!=='string'||!token)throw new Error('Identidade indisponível.');
      const r=await this.fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${escape(request.email)}:signBlob`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','x-goog-user-project':this.project},body:JSON.stringify({payload:Buffer.from(request.stringToSign).toString('base64')}),redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw new Error('Assinatura Google indisponível.');const result=await r.json();
      if(typeof result.signedBlob!=='string'||!result.signedBlob||!/^[A-Za-z0-9+/]+={0,2}$/.test(result.signedBlob))throw new Error('Assinatura inválida.');
      const signature=Buffer.from(result.signedBlob,'base64');if(signature.length<128||signature.length>1024)throw new Error('Assinatura inválida.');
      return {url:request.unsignedUrl+'&X-Goog-Signature='+signature.toString('hex'),expires_at:request.expires_at};
    }catch(error){await markUncertain();throw error;}
  }
}
