// Persist each submission before calling Gemini. Only an explicit HTTP429
// response permits another submission; a crash/timeout never does.
export const maximumAnalysisAttempts=3;
export const confirmedAnalysis429=diagnostic=>diagnostic?.operation_step==='submit_analysis'&&diagnostic.http_status===429;
export function recoverableAnalysis429(job){
  const attempts=job?.analysis_attempts;
  return job?.stage==='analysis'&&job.status==='uncertain'&&confirmedAnalysis429(job.failure_diagnostic)&&
    (attempts===undefined||Array.isArray(attempts)&&attempts.length>0&&attempts.length<maximumAnalysisAttempts&&attempts.every((a,i)=>a.number===i+1&&a.status==='http_429'));
}
export async function submitAnalysisWithRetry({submit,admit,record,attempts=[],sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  if(!Array.isArray(attempts)||attempts.length>=maximumAnalysisAttempts||attempts.some((a,i)=>a.number!==i+1||a.status!=='http_429'))throw Error('Histórico não permite repetir análise.');
  const history=structuredClone(attempts);
  for(let number=history.length+1;number<=maximumAnalysisAttempts;number++){
    if(number>1)await sleep(number===2?5000:15000);
    await admit();
    const attempt={number,status:'started'};history.push(attempt);await record(history);
    let response;
    try{response=await submit();}
    catch(error){
      attempt.status=error.status===429?'http_429':'uncertain';
      if(error.provider_diagnostic)attempt.provider_diagnostic=error.provider_diagnostic;
      await record(history);
      if(error.status!==429||number===maximumAnalysisAttempts)throw error;
      continue;
    }
    attempt.status='response_received';await record(history);
    return response;
  }
}
