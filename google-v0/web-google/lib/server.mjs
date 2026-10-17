import {readFileSync}from 'node:fs';import {isAbsolute}from 'node:path';import {cookies}from 'next/headers';
import {validateWebConfig}from '../../lib/web-config.mjs';import {openSession,sessionCookie}from '../../lib/web-session.mjs';
import {serviceIdentity}from '../../lib/service-identity.mjs';import {GoogleREST}from '../../lib/google-rest.mjs';
import {Firestore}from '../../lib/firestore.mjs';import {LibraryRepository}from '../../lib/library-repository.mjs';import {libraryAPI}from '../../lib/library-api.mjs';
import {boundedMedia}from '../../lib/bounded-media.mjs';
import {ReelsRepository}from '../../lib/reels-repository.mjs';
import {reelsAPI}from '../../lib/reels-api.mjs';
import {reelsWebRuntime}from '../../lib/reels-web-runtime.mjs';
export function settings(){
  const path=process.env.MEGABRAIN_V0_CONFIG;
  if(!path||!isAbsolute(path)||path.includes('/run/megabrain/')||path.includes('/opt/megabrain-pilot/'))throw new Error('Configuração própria da v0 ausente.');
  return validateWebConfig(JSON.parse(readFileSync(path,'utf8')),{session_secret:process.env.V0_SESSION_SECRET,google_client_id:process.env.V0_GOOGLE_CLIENT_ID,google_client_secret:process.env.V0_GOOGLE_CLIENT_SECRET});
}
export async function authenticated(){try{const s=settings();const value=(await cookies()).get(sessionCookie)?.value;
  const user=openSession(value,s.session_secret,{origin:s.origin,kind:'session'});return Boolean(user&&user.email===s.allowed_email&&typeof user.sub==='string');}catch{return false;}}
export function sameOrigin(request){return request.headers.get('origin')===settings().origin;}
let backend,mediaHandler;
export function routes(){
  if(!backend){const s=settings(),tokenProvider=serviceIdentity({project:s.project_id}),api=new GoogleREST({project:s.project_id,buckets:[s.media_bucket],tokenProvider});
    const store=new Firestore(api),repository=new LibraryRepository(store);
    backend=libraryAPI({repository,ledgerStore:store,authorize:authenticated,sameOrigin,linkImportEnabled:s.link_import_enabled===true});
    mediaHandler=boundedMedia({repository,api,authorize:authenticated});}
  return backend;
}
export function mediaRoute(){routes();return mediaHandler.metadata;}
export function mediaStreamRoute(){return async(request,id)=>{
  if(!await authenticated())return Response.json({error:'Não autorizado'},{status:401,headers:{'Cache-Control':'no-store'}});
  try{routes();return await mediaHandler.stream(request,id);}
  catch{return Response.json({error:'Não foi possível acessar o vídeo agora. Tente carregar novamente.'},{status:503,headers:{'Cache-Control':'no-store'}});}
};}

let reelsBackend;
export function reelsRoutes(){
 if(!reelsBackend){const s=settings(),tokenProvider=serviceIdentity({project:s.project_id}),api=new GoogleREST({project:s.project_id,buckets:[s.media_bucket],tokenProvider});
  const repository=new ReelsRepository({store:new Firestore(api)});
  // Processing remains off unless protected configuration explicitly selects v2.
  const runtime=reelsWebRuntime({repository,api,config:s});
  reelsBackend=reelsAPI({repository,authorize:authenticated,sameOrigin,processingEnabled:runtime.processingEnabled,service:runtime.service,reconciliation:runtime.reconciliation});}
 return reelsBackend;
}
