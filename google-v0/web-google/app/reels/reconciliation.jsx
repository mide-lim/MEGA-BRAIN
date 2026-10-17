'use client';
import {useRef,useState} from 'react';
import {key,request,executionStatuses} from '../../lib/reels-client.mjs';
import {DataPairs,Feedback,Message,Observed,useResource} from './shared.jsx';
const evidenceLabels={verified:'Vínculo verificado',unverified:'Sem vínculo verificável',absent:'Não localizado'};
const blockers={MIGRATION_HOLD:'Cadastro em conferência de migração.',EXECUTION_SUPERSEDED:'Outra execução já possui este Reel.',EXECUTION_NOT_RECOVERABLE:'Esta execução não oferece uma ação de conciliação.',VERIFIABLE_EVIDENCE_REQUIRED:'Ainda não há prova vinculada que permita concluir esta execução.'};
export function Reconciliation({executionId,onRefresh}){
 const [revision,setRevision]=useState(0),state=useResource('/reconciliations/'+encodeURIComponent(executionId),revision),[busy,setBusy]=useState(false),[message,setMessage]=useState(null),keys=useRef({});
 async function submit(action){setBusy(true);setMessage(null);keys.current[action]??=key();try{
  const result=await request('/reconciliations',{method:'POST',body:{executionId,action,idempotencyKey:keys.current[action]}});
  setMessage({text:'Conciliação registrada. Estado da execução: '+(executionStatuses[result.reconciliation?.executionStatus]||'Aguardando confirmação')+'.'});setRevision(n=>n+1);onRefresh();
 }catch(error){setMessage({error:true,text:error.message});}finally{setBusy(false);}}
 const data=state.data;
 return <section className="action-card"><h4>Conferir resultado incerto</h4><Feedback state={state} retry={()=>setRevision(n=>n+1)}>{data&&<>
  <DataPairs data={{'Resultado salvo':evidenceLabels[data.evidence?.savedResult],'Operação externa registrada':evidenceLabels[data.evidence?.savedOperation],'Execução atual':data.evidence?.currentExecution?'Sim':data.evidence?.verifiedSuccessor?'Etapa seguinte com vínculo comprovado':'Não'}}/>
  <Observed at={data.observedAt}/><p>{data.note}</p>{data.blockedReason&&<p className="notice warning">{blockers[data.blockedReason]||'A ação requer conferência no servidor.'}</p>}
  {data.processingAllowed===false&&<p className="notice">A consulta está disponível. Aplicar resultados e encaminhar coleta continua desabilitado no servidor nesta entrega.</p>}
  {data.actions?.map(item=><button key={item.action} disabled={busy||!item.enabled} onClick={()=>submit(item.action)}>{busy?'Registrando…':item.label}</button>)}
 </>}</Feedback><Message value={message}/></section>;
}
