import {createHash} from 'node:crypto';
const rank={upload:0,transcription:1,analysis:2};
const states=new Set(['reserved','started','completed','cancelled','uncertain']);
export function pipelineProgress(jobs={}){
 const groups=new Map();
 for(const [key,j]of Object.entries(jobs)){
  if(!j||!/^[A-Za-z0-9_-]{5,32}$/.test(j.video_id??'')||!Object.hasOwn(rank,j.stage)||!states.has(j.status))continue;
  const group=groups.get(j.video_id)??[];group.push({key,stage:j.stage,status:j.status,at:typeof j.updated_at==='string'?j.updated_at:typeof j.created_at==='string'?j.created_at:''});groups.set(j.video_id,group);
 }
 const items=[...groups].map(([id,history])=>{
  history.sort((a,b)=>rank[a.stage]-rank[b.stage]||a.at.localeCompare(b.at)||a.key.localeCompare(b.key));
  const latest=history.at(-1);
  return {id,stage:latest.stage,status:latest.status,version:createHash('sha256').update(JSON.stringify(history)).digest('hex')};
 });
 return {items,active:items.some(x=>['started','reserved'].includes(x.status))};
}
