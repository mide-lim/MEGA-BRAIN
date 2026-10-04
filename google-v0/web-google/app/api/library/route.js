import {routes,authenticated}from '../../../lib/server.mjs';
export const dynamic='force-dynamic';
export async function GET(request){if(!await authenticated())return Response.json({error:'Não autorizado'},{status:401});try{return await routes().library(request);}catch{return Response.json({error:'Ambiente Google ainda não configurado.'},{status:503});}}
