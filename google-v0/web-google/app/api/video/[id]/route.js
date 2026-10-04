import {mediaRoute,authenticated}from '../../../../lib/server.mjs';
export const dynamic='force-dynamic';
export async function GET(request,context){if(!await authenticated())return Response.json({error:'Não autorizado'},{status:401});try{const {id}=await context.params;return await mediaRoute()(request,id);}catch{return Response.json({error:'Reprodução Google indisponível.'},{status:503});}}
