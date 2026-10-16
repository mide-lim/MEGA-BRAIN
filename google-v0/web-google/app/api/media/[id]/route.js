import {mediaStreamRoute,authenticated}from '../../../../lib/server.mjs';
export const dynamic='force-dynamic';
export async function GET(request,{params}){
 if(!await authenticated())return Response.json({error:'Não autorizado'},{status:401,headers:{'Cache-Control':'no-store'}});
 try{return await mediaStreamRoute()(request,(await params).id);}
 catch{return Response.json({error:'Não foi possível acessar o vídeo agora. Tente carregar novamente.'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
export const HEAD=GET;
