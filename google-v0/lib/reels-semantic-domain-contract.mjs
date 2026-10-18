import {semanticHash} from './reels-semantic-source.mjs';
import {categoryDefinitions} from './category-taxonomy.mjs';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const semanticDomainVersion='semantic-domain-curation-v1';
export const semanticDomainPlanPath='settings/reels_v2_semantic_domain_plan';
const definitions=[
 ['food','Alimentação',['Alimentação'],['recipe','health','home'],'Distinguir preparo, nutrição/suplementação e sustentabilidade pela finalidade demonstrada. Ingrediente saudável não certifica nutrição.'],
 ['technology','Tecnologia',['Tecnologia'],['technology','business'],'Distinguir software, IA, ferramentas e hardware pela finalidade. Usar IA em marketing não transforma o conteúdo em uma aula de IA.'],
 ['health','Saúde e bem-estar',['Saúde e bem-estar'],['health'],'Distinguir treino, execução e bem-estar. Alimentação/nutrição pode ser sugerida ao especialista de Alimentação quando a finalidade justificar.'],
 ['business','Trabalho e negócios',['Trabalho e negócios'],['business','technology'],'Distinguir comunicação, marketing e carreira; citar uma ferramenta não altera a finalidade.'],
 ['home','Casa e estilo',['Casa e estilo'],['home'],'Distinguir decoração, fabricação/reparo e moda pela aplicação e finalidade.'],
 ['travel','Viagens e lugares',['Viagens e lugares'],['travel'],'Distinguir destinos, experiências e onde comer de ensinar o preparo de uma receita.'],
 ['unassigned','Destino pendente',['Outros temas'],['recipe','technology','health','travel','business','home','general'],'Examinar o significado salvo e sugerir um destino com prova literal, ou abster. Outros não é erro nem evidência de que uma categoria específica se aplica.']
];
export const semanticDomainProfiles=freeze(definitions.map(([id,label,groups,contexts,instruction])=>({id,label,version:semanticDomainVersion,categoryIds:categoryDefinitions.filter(c=>groups.includes(c.group)).map(c=>c.id),contexts,instruction,manualWins:true,semanticCertification:false})));
export const semanticDomainProfile=id=>semanticDomainProfiles.find(p=>p.id===id)??null;
export const semanticDomainPromptHash=(base,id)=>{const profile=semanticDomainProfile(id);if(!profile)throw Error('DOMAIN_PROFILE_INVALID');return semanticHash({basePromptHash:base,domainVersion:semanticDomainVersion,profile,destinationContract:'literal-candidate-only-v1'});};
export function routeExistingSemanticDomain(categoryIds=[],nodes=[]){
 const byId=new Map(nodes.map(n=>[n.id,n])),found=new Set(),roots=new Set();
 for(const original of categoryIds){let id=original;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);const p=semanticDomainProfiles.find(d=>d.id!=='unassigned'&&d.categoryIds.includes(id));if(p){found.add(p.id);roots.add(id);break;}id=byId.get(id)?.parentId;}}
 if(found.size!==1)return {domainId:'unassigned',routedByExistingCategory:false,semanticCertified:false,reason:found.size?'CROSS_DOMAIN_DESTINATION_PENDING':'DESTINATION_EVIDENCE_REQUIRED',candidateDomainIds:[...found].sort(),categoryIds:[...new Set(categoryIds)].sort()};
 return {domainId:[...found][0],routedByExistingCategory:true,semanticCertified:false,reason:'EXISTING_CATEGORY_OPERATIONAL_HINT',categoryIds:[...roots].sort(),candidateDomainIds:[]};
}
export function semanticDomainInstruction(id,phase='extract'){
 const p=semanticDomainProfile(id);if(!p)throw Object.assign(Error('DOMAIN_PROFILE_INVALID'),{semantic_preflight:true});
 return 'Especialista operacional: '+p.label+'. '+p.instruction+' O domínio recebido é uma hipótese de organização, não um veredicto. Os grupos deste especialista só podem usar context: '+p.contexts.join(', ')+'. Nunca force enquadramento; fontes cuja finalidade está fora desses contextos não entram em grupos deste especialista. Não modifique decisões manuais.'+(phase==='extract'?' Para cada fonte devolva exatamente uma destination: state suggested com domainId específico e 1 a 8 provas literais, ou state inconclusive com domainId null e evidence vazio. Use destination para sugerir outro especialista quando a finalidade exigir; não crie grupo fora dos contextos permitidos. Não use unassigned como destino sugerido. Sugestão não aprova categoria.':' Não devolva destinations nesta fase; respeite exatamente o schema e os pares/IDs recebidos.');
}
export function semanticDomainResponseSchema(schema,phase,sources=[],domainId){
 if(phase!=='extract')return schema;
 const copy=structuredClone(schema),string={type:'STRING'};
 const profile=semanticDomainProfile(domainId);if(profile&&copy.properties?.groups?.items?.properties?.context)copy.properties.groups.items.properties.context.enum=[...profile.contexts];
 copy.properties.destinations={type:'ARRAY',description:'Exatamente uma decisão por ID recebido; fonte ausente ou insuficiente exige abstenção.',items:{type:'OBJECT',required:['reelId','state','domainId','reason','evidence'],properties:{reelId:{type:'STRING',enum:sources.map(s=>s.id)},state:{type:'STRING',enum:['suggested','inconclusive']},domainId:{type:'STRING',nullable:true,enum:semanticDomainProfiles.filter(p=>p.id!=='unassigned').map(p=>p.id)},reason:{...string,description:'Motivo da finalidade; não vazio, máximo 3000 caracteres.'},evidence:{type:'ARRAY',description:'Suggested exige 1..8 provas; inconclusive usa []. Provas devem ser trechos literais contínuos, máximo1600 caracteres cada.',items:{type:'OBJECT',required:['fieldPath','excerpt'],properties:{fieldPath:string,excerpt:string}}}}}};
 copy.required=[...copy.required,'destinations'];return copy;
}
export function validateSemanticDomainDestinations(output,sources,domainId){
 const profile=semanticDomainProfile(domainId),byId=new Map(sources.map(s=>[s.id,s])),rows=output?.destinations;
 if(!profile||!Array.isArray(rows)||rows.length!==sources.length)throw Object.assign(Error('DOMAIN_DESTINATION_COVERAGE_INVALID'),{code:'DOMAIN_DESTINATION_COVERAGE_INVALID'});
 const seen=new Set(),valid=[];
 for(const row of rows){const source=byId.get(row?.reelId);if(!source||seen.has(row.reelId)||!['suggested','inconclusive'].includes(row.state)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>3000||!Array.isArray(row.evidence)||row.evidence.length>8)throw Object.assign(Error('DOMAIN_DESTINATION_INVALID'),{code:'DOMAIN_DESTINATION_INVALID'});seen.add(row.reelId);
  if(row.state==='suggested'?!semanticDomainProfile(row.domainId)||row.domainId==='unassigned'||row.evidence.length===0:row.domainId!==null||row.evidence.length!==0)throw Object.assign(Error('DOMAIN_DESTINATION_INVALID'),{code:'DOMAIN_DESTINATION_INVALID'});
  const evidence=row.evidence.map(e=>{const field=source.fields.find(f=>f.fieldPath===e?.fieldPath);if(!field||typeof e.excerpt!=='string'||!e.excerpt.trim()||e.excerpt.length>1600||!field.text.includes(e.excerpt))throw Object.assign(Error('DOMAIN_DESTINATION_EVIDENCE_INVALID'),{code:'DOMAIN_DESTINATION_EVIDENCE_INVALID'});return {...e,source:field.source,sourceIdentity:field.sourceIdentity};});
  valid.push({reelId:source.id,proposedByDomainId:domainId,state:source.editorial.manual?'manual_preserved':row.state,suggestedDomainId:row.state==='suggested'?row.domainId:null,reason:row.reason,evidence,sourceIdentity:source.sourceIdentity,sourceVersions:source.sourceVersions,semanticProofHash:source.semanticProofHash,editorialHash:source.editorialHash,accepted:false,semanticCertified:false,originalCategoryUnchanged:true});
 }
 for(const g of output.groups??[])if(!profile.contexts.includes(g.context))throw Object.assign(Error('DOMAIN_GROUP_CONTEXT_OUTSIDE_PROFILE'),{code:'DOMAIN_GROUP_CONTEXT_OUTSIDE_PROFILE'});
 return valid;
}
