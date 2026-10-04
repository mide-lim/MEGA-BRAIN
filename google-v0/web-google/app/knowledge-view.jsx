'use client';
import {contextLabels,fieldLabels} from '../../lib/knowledge.mjs';
export function KnowledgeDetails({knowledge}){
 if(!knowledge)return null;
 return <section className="knowledge-details"><span className="eyebrow">CONHECIMENTO EXTRAÍDO</span><h3>{contextLabels[knowledge.context]??'Conhecimento'}</h3>{!knowledge.fields.length&&<p className="notice">A extração estruturada precisa de revisão. Confira as limitações e o vídeo de origem.</p>}<div className="keyword-tags">{knowledge.keywords.map((k,i)=><span key={i}>{k.term}</span>)}</div>{knowledge.fields.map((f,i)=><section className="knowledge-field" key={i}><small>{fieldLabels[f.kind]??'Informação'}</small><h4>{f.name}</h4><p>{f.value}</p>{f.evidence.map((e,j)=><blockquote key={j}><small>{e.source==='transcript'?'Transcrição':'Vídeo'} · {e.start_seconds}s–{e.end_seconds}s</small><br/>{e.excerpt}</blockquote>)}</section>)}{!!knowledge.missing_information.length&&<><h4>O que a fonte não informa</h4>{knowledge.missing_information.map((s,i)=><p key={i}>{s}</p>)}</>}</section>;
}
export function KnowledgeBook({videos,onOpen}){
 if(!videos.length)return <div className="empty">Nenhum conhecimento encontrado nesta seleção.</div>;
 return <div className="grid knowledge-book">{videos.map(v=>{const k=v.analysis.knowledge;return <article className="knowledge-card" key={v.id}><small>{contextLabels[k.context]??'Conhecimento'}</small><h4>{v.analysis.title}</h4><div className="keyword-tags">{k.keywords.slice(0,4).map((word,i)=><span key={i}>{word.term}</span>)}{k.keywords.length>4&&<span>+{k.keywords.length-4}</span>}</div>{k.fields.length?<><p className="knowledge-preview"><strong>{k.fields[0].name}: </strong>{k.fields[0].value}</p><small>{k.fields.length} informações com evidência</small></>:<p className="notice">Extração pendente de revisão.</p>}<div className="knowledge-actions"><button className="secondary" onClick={()=>onOpen(v)}>Explorar conhecimento e vídeo</button></div></article>;})}</div>;
}
