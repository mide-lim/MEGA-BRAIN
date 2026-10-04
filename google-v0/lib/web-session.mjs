import {createHmac,timingSafeEqual}from 'node:crypto';
export const sessionCookie='__Host-megabrain-v0';
export const oauthCookie='__Host-megabrain-v0-oauth';
export function sealSession(payload,key,{origin,kind,now=Date.now(),ttl=28800000}){
  if(!['session','oauth'].includes(kind)||!Number.isInteger(ttl)||ttl<1||ttl>(kind==='oauth'?600000:28800000))throw new Error('Sessão inválida.');
  const raw=Buffer.from(JSON.stringify({...payload,aud:origin,kind,iat:now,exp:now+ttl})).toString('base64url');
  return raw+'.'+createHmac('sha256',key).update(raw).digest('base64url');
}
export function openSession(value,key,{origin,kind,now=Date.now()}){
  try{
    if(typeof value!=='string'||value.length>8192)return null;const parts=value.split('.');if(parts.length!==2)return null;
    const [raw,sig]=parts,expected=createHmac('sha256',key).update(raw).digest(),actual=Buffer.from(sig,'base64url');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
    const data=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
    const max=kind==='oauth'?600000:28800000;
    return data.aud===origin&&data.kind===kind&&Number.isFinite(data.iat)&&Number.isFinite(data.exp)&&data.iat<=now&&data.exp>now&&data.exp-data.iat<=max?data:null;
  }catch{return null;}
}
export function ownerAllowed(claims){return claims?.email==='midelim.dev@gmail.com'&&claims.email_verified===true&&typeof claims.sub==='string'&&Boolean(claims.sub);}
