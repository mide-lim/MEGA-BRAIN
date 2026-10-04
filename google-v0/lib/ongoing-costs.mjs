// This is an administrative planning guard, not a provider billing cap.
// All inputs are conservative BRL estimates until account-wide reconciliation.
export function ongoingCostPlan({storageBytes,storageCentsPerGiBMonth,daysUntilCleanup,serviceOperationsCents,transferCents,cleanupCents,remainingCreditCents,allocationRemainingCents,reserveCents,inflightCents}){
 const values=[storageBytes,storageCentsPerGiBMonth,daysUntilCleanup,serviceOperationsCents,transferCents,cleanupCents,remainingCreditCents,allocationRemainingCents,reserveCents,inflightCents];
 if(values.some(v=>!Number.isSafeInteger(v)||v<0)||daysUntilCleanup<1||daysUntilCleanup>365||storageCentsPerGiBMonth<1)throw new Error('Estimativas conservadoras completas são obrigatórias.');
 const storageCents=Math.ceil(storageBytes/1073741824*storageCentsPerGiBMonth*daysUntilCleanup/30);
 const commitmentCents=storageCents+serviceOperationsCents+transferCents+cleanupCents;
 const availableCents=Math.min(remainingCreditCents,allocationRemainingCents)-reserveCents-inflightCents;
 if(!Number.isSafeInteger(commitmentCents)||!Number.isSafeInteger(availableCents))throw new Error('Estimativa fora da precisão permitida.');
 return {ready:commitmentCents<=availableCents,commitment_cents:commitmentCents,storage_cents:storageCents,available_after_commitment_cents:Math.max(0,availableCents-commitmentCents),provider_cap:false};
}
