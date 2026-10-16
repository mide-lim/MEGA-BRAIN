import {mediaStreamRoute}from '../../../../lib/server.mjs';
export const dynamic='force-dynamic';
export async function GET(request,{params}){return mediaStreamRoute()(request,(await params).id);}
export const HEAD=GET;
