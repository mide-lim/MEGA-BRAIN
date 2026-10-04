import {createPublicKey,verify} from 'node:crypto';
const keysUrl='https://www.googleapis.com/oauth2/v3/certs';
const queueEmail='v0-queue@megabrain-v0-1017370021431.iam.gserviceaccount.com';
export function workerAuthorization({audience,fetchImpl=fetch,clock=()=>Date.now()}){
  const origin=new URL(audience);
  if(origin.protocol!=='https:'||!origin.hostname.endsWith('.run.app')||origin.origin!==audience)throw new Error('Audiência própria Cloud Run obrigatória.');
  let keys=[],expires=0;
  return async request=>{
    try{
      // Reject the alternate header: Cloud Run can strip its signature. Only
      // a complete signed Authorization token is accepted by this verifier.
      if(request.headers.has('x-serverless-authorization'))return false;
      const match=request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
      if(!match||match[1].length>12000)return false;
      const [h,p,s]=match[1].split('.'),header=JSON.parse(Buffer.from(h,'base64url')),claims=JSON.parse(Buffer.from(p,'base64url'));
      const now=Math.floor(clock()/1000);
      if(header.alg!=='RS256'||typeof header.kid!=='string'||header.crit||!['https://accounts.google.com','accounts.google.com'].includes(claims.iss)||claims.aud!==audience||claims.email!==queueEmail||claims.email_verified!==true||typeof claims.sub!=='string'||!claims.sub||!Number.isInteger(claims.exp)||claims.exp<=now||!Number.isInteger(claims.iat)||claims.iat>now+30||claims.iat<now-3600||claims.exp-claims.iat>3600||(claims.nbf!==undefined&&(!Number.isInteger(claims.nbf)||claims.nbf>now)))return false;
      if(expires<=clock()){
        const response=await fetchImpl(keysUrl,{redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok)return false;
        const text=await response.text();if(text.length>65536)return false;
        const data=JSON.parse(text);if(!Array.isArray(data.keys)||data.keys.length>20)return false;
        keys=data.keys;expires=clock()+300000;
      }
      const key=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&k.alg==='RS256'&&k.use==='sig');
      if(!key)return false;
      return verify('RSA-SHA256',Buffer.from(h+'.'+p),createPublicKey({key,format:'jwk'}),Buffer.from(s,'base64url'));
    }catch{return false;}
  };
}
