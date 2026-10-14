'use client';
import {useEffect,useRef,useState}from 'react';
const cache=new Map();
export default function VideoPreview({id,controls=false,ready=true,revision=null,refreshKey=null}){
 const video=useRef(null),hovering=useRef(false),pending=useRef(false),[source,setSource]=useState(null),[error,setError]=useState('');
 useEffect(()=>{if(error){cache.delete(id);setSource(null);}setError('');if(!ready)setSource(null);else if(hovering.current&&!controls)prepare();},[id,ready,revision,refreshKey]);
 useEffect(()=>{if(source&&hovering.current&&!controls)video.current?.play().catch(()=>{});},[source,controls]);
 async function prepare(){
  if(!ready||pending.current)return;const current=cache.get(id);
  if(current&&Date.parse(current.expires_at)>Date.now()+10000){setSource(current.url);return;}
  pending.current=true;setError('');try{
   const response=await fetch('/api/video/'+encodeURIComponent(id),{cache:'no-store'});const data=await response.json();
   if(!response.ok)throw new Error(data.error||'Vídeo indisponível.');
   if(data.url!=='/api/media/'+encodeURIComponent(id)||!Number.isFinite(Date.parse(data.expires_at))||Date.parse(data.expires_at)<=Date.now())throw new Error('Autorização de vídeo inválida.');
   cache.set(id,data);setSource(data.url);
  }catch(e){setError(e.message);}finally{pending.current=false;}
 }
 function enter(){if(controls)return;hovering.current=true;if(!ready)return;if(source&&!error)video.current?.play().catch(()=>{});else if(!error)prepare();}
 function leave(){if(controls)return;hovering.current=false;if(video.current){video.current.pause();try{video.current.currentTime=0;}catch{}}}
 return <div className={'video-preview'+(controls?' full':'')} onMouseEnter={enter} onMouseLeave={leave}>
  {source?<video ref={video} src={source} controls={controls} muted={!controls} playsInline preload="none" onLoadedData={()=>{if(hovering.current&&!controls)video.current?.play().catch(()=>{});}} onError={()=>setError('Não foi possível reproduzir. Confira a autorização antes de tentar novamente.')}/>:<span className="poster">▶</span>}
  {controls&&ready&&!source&&!error&&<button className="secondary" onClick={prepare}>Carregar vídeo privado</button>}
  {!ready&&<small className="media-waiting">Reprodução disponível após a análise.</small>}
  {error&&<small className="media-error">{error}</small>}
 </div>;
}
