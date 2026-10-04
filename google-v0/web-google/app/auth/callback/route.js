import {NextResponse}from 'next/server';import {cookies}from 'next/headers';import {settings}from '../../../lib/server.mjs';import {sealSession,openSession,ownerAllowed,oauthCookie,sessionCookie}from '../../../../lib/web-session.mjs';
export async function GET(request){const fail=()=>{const r=NextResponse.json({error:'Não foi possível autorizar essa conta.'},{status:403});r.cookies.delete(oauthCookie);return r;};
 try{const s=settings(),url=new URL(request.url),state=openSession((await cookies()).get(oauthCookie)?.value,s.session_secret,{origin:s.origin,kind:'oauth'});
  if(!state||typeof state.verifier!=='string'||state.state!==url.searchParams.get('state')||!url.searchParams.get('code'))return fail();
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),body:new URLSearchParams({client_id:s.google_client_id,client_secret:s.google_client_secret,code:url.searchParams.get('code'),grant_type:'authorization_code',redirect_uri:s.origin+'/auth/callback',code_verifier:state.verifier})});
  if(!response.ok)return fail();const tokens=await response.json();if(typeof tokens.access_token!=='string'||!tokens.access_token)return fail();
  const info=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+tokens.access_token},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!info.ok)return fail();const user=await info.json();if(!ownerAllowed(user))return fail();
  const r=NextResponse.redirect(s.origin);r.cookies.set(sessionCookie,sealSession({email:user.email,sub:user.sub},s.session_secret,{origin:s.origin,kind:'session'}),{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:28800});r.cookies.delete(oauthCookie);return r;
 }catch{return fail();}}
