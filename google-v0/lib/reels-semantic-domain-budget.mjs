export const semanticDomainBudgetDefaults=Object.freeze({version:'full-wire-utf8-proxy-v1',maxSources:12,maxRequestUtf8Bytes:192000,maxRequestCharacters:320000,maxEstimatedInputTokens:200000,reservedInputTokens:1024,maxOutputTokens:16384});
export function semanticDomainBudget(value={}){
 const b={...semanticDomainBudgetDefaults,...value};
 if(b.version!==semanticDomainBudgetDefaults.version||Object.keys(b).some(k=>!Object.hasOwn(semanticDomainBudgetDefaults,k))||!Number.isSafeInteger(b.maxSources)||b.maxSources<1||b.maxSources>12||!Number.isSafeInteger(b.maxRequestUtf8Bytes)||b.maxRequestUtf8Bytes<4096||b.maxRequestUtf8Bytes>320000||!Number.isSafeInteger(b.maxRequestCharacters)||b.maxRequestCharacters<4096||b.maxRequestCharacters>320000||!Number.isSafeInteger(b.maxEstimatedInputTokens)||b.maxEstimatedInputTokens<4096||b.maxEstimatedInputTokens>320000||!Number.isSafeInteger(b.reservedInputTokens)||b.reservedInputTokens<1024||b.reservedInputTokens>32000||b.maxOutputTokens!==16384)throw Error('DOMAIN_BUDGET_INVALID');
 return b;
}
export function measureSemanticDomainRequest(request,rawBudget={}){
 const budget=semanticDomainBudget(rawBudget),json=JSON.stringify(request),requestUtf8Bytes=Buffer.byteLength(json,'utf8'),requestCharacters=json.length,estimatedInputTokens=requestUtf8Bytes+budget.reservedInputTokens;
 return {requestUtf8Bytes,requestCharacters,estimatedInputTokens,reservedInputTokens:budget.reservedInputTokens,outputTokenLimit:request.generationConfig?.maxOutputTokens??null,estimateFormula:'ceil(full_request_utf8_bytes*1)+reserved_input_tokens',estimateVersion:budget.version,estimated:true,providerTokenCount:null,providerUsage:null,includes:['instruction','schema','catalogue','sources','ids','json_envelope'],withinBudget:requestUtf8Bytes<=budget.maxRequestUtf8Bytes&&requestCharacters<=budget.maxRequestCharacters&&estimatedInputTokens<=budget.maxEstimatedInputTokens&&(request.generationConfig?.maxOutputTokens??Infinity)<=budget.maxOutputTokens};
}
