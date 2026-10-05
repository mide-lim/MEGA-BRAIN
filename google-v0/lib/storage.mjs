import {createHash,randomBytes} from 'node:crypto';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function objectKey(key){
  if(typeof key!=='string'||!key||key.length>512||!key.split('/').every(v=>/^[A-Za-z0-9_.-]+$/.test(v)&&v!=='.'&&v!=='..'))throw new Error('Objeto de armazenamento inválido.');
  if(!['originals','results','previews','temporary'].includes(key.split('/')[0]))throw new Error('Objeto fora do escopo permitido.');
  return encodeURIComponent(key);
}
export class Storage {
  constructor(api,bucket,{maxBytes=100000000,admitObject=null}={}){
    if(!api.buckets.has(bucket))throw new Error('Bucket não autorizado.');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('Limite de arquivo inválido.');
    this.api=api;this.bucket=bucket;this.maxBytes=maxBytes;this.admitObject=admitObject;
    this.root=`https://storage.googleapis.com/storage/v1/b/${bucket}/o`;
  }
  async metadata(key){
    try{return await this.api.request(`${this.root}/${objectKey(key)}`);}
    catch(error){if(error.status===404)return null;throw error;}
  }
  async read(key,{generation}={}){
    const query=new URLSearchParams({alt:'media'});if(generation)query.set('generation',generation);
    return this.api.request(`${this.root}/${objectKey(key)}?${query}`,{responseMode:'bytes',timeoutMs:120000,maxResponseBytes:this.maxBytes});
  }
  async writeImmutable(key,bytes,{contentType='application/octet-stream',uploadsEnabled=false}={}){
    objectKey(key);
    if(uploadsEnabled!==true)throw new Error('Uploads desligados.');
    if(!Buffer.isBuffer(bytes)||bytes.length>this.maxBytes||!bytes.length)throw new Error('Arquivo vazio ou acima do limite.');
    if(!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType))throw new Error('Tipo de arquivo inválido.');
    const digest=sha256(bytes);
    if(this.admitObject)await this.admitObject({bucket:this.bucket,key,bytes:bytes.length,digest});
    const existing=await this.metadata(key);
    if(existing){
      if(Number(existing.size)!==bytes.length||existing.metadata?.sha256!==digest)throw new Error('Objeto existente diverge da origem; sobrescrita proibida.');
      const actual=await this.read(key,{generation:existing.generation});
      if(sha256(actual)!==digest)throw new Error('Checksum do objeto existente diverge.');
      return {created:false,sha256:digest,generation:existing.generation,size:bytes.length};
    }
    const boundary='megabrain_'+randomBytes(16).toString('hex');
    const metadata={name:key,contentType,metadata:{sha256:digest}};
    const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const url=`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?uploadType=multipart&ifGenerationMatch=0`;
    const object=await this.api.request(url,{method:'POST',body,headers:{'Content-Type':`multipart/related; boundary=${boundary}`},timeoutMs:120000});
    const copied=await this.read(key,{generation:object.generation});
    if(copied.length!==bytes.length||sha256(copied)!==digest)throw new Error('Cópia não passou na verificação de checksum.');
    return {created:true,sha256:digest,generation:object.generation,size:bytes.length};
  }
}
