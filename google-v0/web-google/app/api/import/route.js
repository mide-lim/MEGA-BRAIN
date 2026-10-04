import {routes,authenticated}from '../../../lib/server.mjs';
export async function POST(request){if(!await authenticated())return Response.json({error:'Não autorizado'},{status:401});try{return await routes().importLinks(request);}catch{return Response.json({error:'Cadastro Google indisponível.'},{status:503});}}
