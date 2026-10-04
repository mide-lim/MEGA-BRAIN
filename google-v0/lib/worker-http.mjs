import {createServer} from 'node:http';
export function workerHTTP(handler){
  return createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    if(req.url!=='/tasks/run'){send(404,{error:'Rota indisponível.'});return;}
    if(req.method!=='POST'){send(405,{error:'Método inválido.'});return;}
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>2048){send(413,{error:'Pedido acima do limite.'});return;}chunks.push(chunk);}
      const headers=new Headers();
      for(const name of ['authorization','x-serverless-authorization','content-type'])if(typeof req.headers[name]==='string')headers.set(name,req.headers[name]);
      const response=await handler(new Request('https://worker.invalid/tasks/run',{method:'POST',headers,body:Buffer.concat(chunks)}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch{if(!res.headersSent)send(500,{error:'Pedido precisa de conferência.'});else res.end();}
  });
}
