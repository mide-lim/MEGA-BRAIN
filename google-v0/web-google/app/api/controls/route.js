import {routes,authenticated}from '../../../lib/server.mjs';
export const dynamic='force-dynamic';
async function handle(request){if(!await authenticated())return Response.json({error:'Não autorizado'},{status:401});try{return await routes().controls(request);}catch{return Response.json({error:'Ambiente Google ainda não configurado.'},{status:503});}}
export const GET=handle;export const POST=handle;
