// Structural/evidence checks remain in analysisOutcome. This checks usefulness
// without inventing data that the source never supplied.
export function knowledgeReadiness(analysis){
 const k=analysis?.knowledge,fields=Array.isArray(k?.fields)?k.fields.filter(f=>f&&typeof f.value==='string'&&f.value.trim()&&Array.isArray(f.evidence)&&f.evidence.length):[];
 const gaps=Array.isArray(k?.missing_information)?k.missing_information.filter(s=>typeof s==='string'&&s.trim()):[];
 if(!k||!fields.length)return {accepted:false,reasons:['NO_SUPPORTED_KNOWLEDGE_FIELDS']};
 const kinds=new Set(fields.map(f=>f.kind)),missing=[],unexplained=[];
 // A gap about price must not waive missing ingredients or the destination.
 // Explicit absence is displayed to the user, never filled with guessed facts.
 const normalized=gaps.map(s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase());
 function requireGroup(present,label,pattern){if(present)return;missing.push(label);if(!normalized.some(s=>pattern.test(s)&&/nao|ausente|omitid|sem |not |unknown|missing|unspecified/.test(s)))unexplained.push(label);}
 if(k.context==='recipe'){
  requireGroup(kinds.has('ingredient'),'Ingredientes não consolidados.',/ingredien/);
  requireGroup(kinds.has('procedure'),'Preparo não consolidado.',/preparo|preparac|etapas|passos|procedure|method|steps/);
 }
 if(k.context==='technology')requireGroup([...kinds].some(x=>['concept','problem','procedure','requirement'].includes(x)),'Conhecimento técnico não consolidado.',/conceit|tecnic|procediment|requisit|concept|technical|procedure|requirement/);
 if(k.context==='travel')requireGroup(kinds.has('place'),'Local não identificado.',/local|lugar|endereco|destino|place|location|address/);
 return {accepted:unexplained.length===0,reasons:unexplained.length?['UNEXPLAINED_CONTEXT_GAPS']:[],missingGroups:missing,sourceGaps:gaps};
}
