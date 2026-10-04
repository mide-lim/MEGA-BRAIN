export function parseReelLinks(input){
  if(typeof input!=='string'||input.length>16000)throw new Error('Cole até 100 links por envio.');
  const found=new Map();
  for(const text of input.split(/\s+/).filter(Boolean)){
    let url;try{url=new URL(text);}catch{throw new Error('Envie apenas links, um por linha.');}
    if(!['http:','https:'].includes(url.protocol)||!['instagram.com','www.instagram.com'].includes(url.hostname)||url.port||url.username||url.password)throw new Error('Link não pertence ao Instagram.');
    const match=url.pathname.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]{5,32})\/?$/);
    if(!match)throw new Error('Link de Reel ou post inválido.');
    found.set(match[1],{id:match[1],url:`https://www.instagram.com/p/${match[1]}/`});
  }
  if(!found.size||found.size>100)throw new Error('Envie de 1 a 100 links.');
  return [...found.values()];
}
