'use client';
import {useEffect,useRef,useState}from 'react';
const cache=new Map();
// The detail has already verified media availability. The local stream authenticates
// every GET/Range again; no private Storage URL or client authorization is introduced.
function PrivatePlayer({id,ready}){
 const video=useRef(null),[error,setError]=useState(''),[waiting,setWaiting]=useState(false);
 useEffect(()=>{setError('');setWaiting(false);},[id,ready]);
 function retry(){setError('');setWaiting(true);const element=video.current;if(!element)return;element.load();element.play().catch(()=>{setWaiting(false);setError('Não foi possível iniciar a reprodução. Tente novamente.');});}
 return <div className="video-preview full">
  {ready?<video ref={video} src={'/api/media/'+encodeURIComponent(id)} aria-label="Vídeo do Reel" controls playsInline preload="metadata" onWaiting={()=>setWaiting(true)} onPlaying={()=>{setWaiting(false);setError('');}} onCanPlay={()=>setWaiting(false)} onPause={()=>setWaiting(false)} onError={()=>{setWaiting(false);setError('Não foi possível acessar o vídeo agora. Tente novamente.');}}/>:<span className="poster">▶</span>}
  {!ready&&<small className="media-waiting">Reprodução disponível após a análise.</small>}
  {waiting&&!error&&<small className="media-waiting" role="status">Preparando reprodução…</small>}
  {error&&<><small className="media-error" role="alert">{error}</small><button className="secondary" onClick={retry}>Tentar reproduzir novamente</button></>}
 </div>;
}
function HoverPreview({id,ready,revision,refreshKey}){
 const video=useRef(null),hovering=useRef(false),pending=useRef(false),[source,setSource]=useState(null),[error,setError]=useState('');
 useEffect(()=>{if(error){cache.delete(id);setSource(null);}setError('');if(!ready)setSource(null);else if(hovering.current)prepare();},[id,ready,revision,refreshKey]);
 useEffect(()=>{if(source&&hovering.current)video.current?.play().catch(()=>{});},[source]);
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
 function enter(){hovering.current=true;if(!ready)return;if(source&&!error)video.current?.play().catch(()=>{});else if(!error)prepare();}
 function leave(){hovering.current=false;if(video.current){video.current.pause();try{video.current.currentTime=0;}catch{}}}
 return <div className="video-preview" onMouseEnter={enter} onMouseLeave={leave}>
  {source?<video ref={video} src={source} muted playsInline preload="none" onLoadedData={()=>{if(hovering.current)video.current?.play().catch(()=>{});}} onError={()=>{cache.delete(id);setSource(null);setError('Não foi possível acessar o vídeo agora. Tente carregar novamente.');}}/>:<span className="poster">▶</span>}
  {!ready&&<small className="media-waiting">Reprodução disponível após a análise.</small>}
  {error&&<><small className="media-error">{error}</small>{ready&&<button className="secondary" onClick={prepare}>Tentar carregar vídeo novamente</button>}</>}
 </div>;
}
export default function VideoPreview({id,controls=false,ready=true,revision=null,refreshKey=null}){
 return controls?<PrivatePlayer key={id} id={id} ready={ready}/>:<HoverPreview key={id} id={id} ready={ready} revision={revision} refreshKey={refreshKey}/>;
}

