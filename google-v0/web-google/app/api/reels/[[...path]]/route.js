import {authenticated,reelsRoutes} from '../../../../lib/server.mjs';
export const dynamic='force-dynamic';
async function handle(request){
 const headers={'Cache-Control':'no-store'};
 if(!await authenticated())return Response.json({error:'Não autorizado.',code:'UNAUTHORIZED'},{status:401,headers});
 try{return await reelsRoutes()(request);}catch{return Response.json({error:'Serviço temporariamente indisponível.',code:'SERVICE_UNAVAILABLE'},{status:503,headers});}
}
export const GET=handle;
export const POST=handle;
