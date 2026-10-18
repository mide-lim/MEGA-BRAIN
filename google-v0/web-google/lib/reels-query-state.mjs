// UI state and request coordination contain no provider or processing actions.
export const catalogDefaults=Object.freeze({q:'',status:'',stage:'',category:'',language:'',tag:'',sort:'newest',worker:'',destination:''});
export function restoreCatalog(value={}){
 const filters={...catalogDefaults};
 for(const k of Object.keys(filters))if(typeof value.filters?.[k]==='string')filters[k]=value.filters[k];
 return {filters,search:typeof value.search==='string'?value.search:filters.q,limit:['25','50','100'].includes(value.limit)?value.limit:'50',view:value.view==='list'?'list':'grid',scope:value.scope==='all'?'all':'ready',attentionKind:value.attentionKind==='uncertain'?'uncertain':'confirmed',expanded:Array.isArray(value.expanded)?value.expanded.filter(x=>typeof x==='string'):[],treeSearch:typeof value.treeSearch==='string'?value.treeSearch:'',scroll:Number.isFinite(value.scroll)?Math.max(0,value.scroll):0,pagination:value.pagination&&typeof value.pagination.signature==='string'&&typeof value.pagination.cursor==='string'&&Array.isArray(value.pagination.history)?value.pagination:{signature:'',cursor:'',history:[]}};
}
export function categoryPath(nodes,id){const path=[],seen=new Set();let node=nodes.find(n=>n.id===id);while(node&&!seen.has(node.id)){seen.add(node.id);path.unshift(node);node=nodes.find(n=>n.id===node.parentId);}return path;}
export function categoryRows(nodes,query=''){
 const normalized=s=>String(s).normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
 const q=normalized(query.trim()),byId=new Map(nodes.map(n=>[n.id,n])),visible=new Set();
 if(q)for(const n of nodes)if(normalized(n.name).includes(q))for(const p of categoryPath(nodes,n.id))visible.add(p.id);
 const children=new Map();
 for(const node of nodes){if(q&&!visible.has(node.id))continue;const parent=byId.has(node.parentId)?node.parentId:null;if(!children.has(parent))children.set(parent,[]);children.get(parent).push(node);}
 return children;
}
export function createResourceClient(fetcher,{now=Date.now,cacheTtlMs=15000}={}){
 const records=new Map();
 function record(path){if(!records.has(path)){if(records.size>=100)for(const [key,r]of records)if(!r.listeners.size&&!r.promise){records.delete(key);break;}records.set(path,{data:null,error:null,loading:false,listeners:new Set(),generation:0,revision:null,dataRevision:null,updatedAt:0});}return records.get(path);}
 const snapshot=r=>({data:r.data,error:r.error,loading:r.loading});
 const emit=r=>{for(const listener of r.listeners)listener(snapshot(r));};
 return {
  peek:path=>path?snapshot(record(path)):{data:null,error:null,loading:false},
  subscribe(path,listener){const r=record(path);r.listeners.add(listener);listener(snapshot(r));return()=>{r.listeners.delete(listener);if(!r.listeners.size&&r.promise){r.generation++;r.controller.abort();r.promise=null;r.loading=false;}};},
  load(path,revision=0){const r=record(path);if(r.promise&&r.revision===revision)return r.promise;const age=now()-r.updatedAt;if(!r.promise&&r.data!==null&&r.data!==undefined&&!r.error&&r.dataRevision===revision&&age>=0&&age<cacheTtlMs)return Promise.resolve(r.data);r.controller?.abort();const controller=new AbortController(),generation=++r.generation;r.controller=controller;r.revision=revision;r.loading=true;emit(r);
   const promise=Promise.resolve().then(()=>fetcher(path,{signal:controller.signal})).then(data=>{if(r.generation===generation&&!controller.signal.aborted){r.data=data;r.dataRevision=revision;r.error=null;r.updatedAt=now();}return data;}).catch(error=>{if(r.generation===generation&&!controller.signal.aborted)r.error=error;}).finally(()=>{if(r.generation===generation){r.loading=false;r.promise=null;emit(r);}});r.promise=promise;return promise;
  }
 };
}
