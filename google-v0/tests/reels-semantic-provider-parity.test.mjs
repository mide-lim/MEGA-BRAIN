import test from 'node:test';
import assert from 'node:assert/strict';
import {ReelsSemanticProvider,semanticResponseSchema,semanticConsolidationSchema,semanticVerificationSchema,semanticSchemaForPhase,semanticInstruction,semanticConsolidationInstruction,semanticVerificationInstruction,semanticPromptVersion,semanticPromptHash,semanticWireSchemaVersion} from '../lib/reels-semantic-provider.mjs';
import {semanticContractSpec as S} from '../lib/reels-semantic-contract-definition.mjs';
import {validateSemanticOutput,validateSemanticVerificationEvidence} from '../lib/reels-semantic-contract.mjs';

const clone=value=>structuredClone(value);
const source=id=>({id,title:id,fields:[{fieldPath:'caption',source:'caption',sourceIdentity:'fixture-caption',text:'Preparo completo de frango. Preparo completo de peixe. '+ 'a'.repeat(1700)}],sourceIdentity:{kind:'native',reelId:id,analysisKey:'fixture/'+id,analysisGeneration:'1'},sourceVersions:{video:'2026-10-18T00:00:00Z'},semanticProofHash:'a'.repeat(64),editorial:{manual:false},editorialHash:'b'.repeat(64),truncated:false});
const sources=[source('QaParity_001'),source('QaParity_002')];
const quote=excerpt=>({fieldPath:'caption',excerpt});
const proof=quote('Preparo completo de frango.');
function valid(){
 return {version:1,profiles:sources.map(s=>({reelId:s.id,context:'recipe',state:'proposed',reason:'Proposta sintética baseada no texto salvo.',units:[]})),groups:[{key:'preparos-caseiros',name:'Preparos caseiros',context:'recipe',kind:'segment',definition:'Preparo culinário desenvolvido na fonte.',aliases:[],positiveCriteria:['Preparo desenvolvido.'],negativeCriteria:['Menção sem preparo.'],members:[{reelId:sources[0].id,role:'central',unitIds:[],evidence:[proof]}],negativeExamples:[{reelId:sources[1].id,reason:'Contraexemplo sintético de contrato.',evidence:[proof]}]}]};
}
// A small independent evaluator for the documented Vertex subset used here.
// It cannot prove semantics, literal citation, identity uniqueness or cross-row links.
function schemaAccepts(schema,value){
 if(schema.anyOf)return schema.anyOf.some(branch=>schemaAccepts(branch,value));
 if(value===null&&schema.nullable===true)return true;
 if(schema.enum&&!schema.enum.includes(value))return false;
 if(schema.type==='OBJECT'){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  if((schema.required??[]).some(key=>!Object.hasOwn(value,key)))return false;
  return Object.entries(schema.properties??{}).every(([key,child])=>!Object.hasOwn(value,key)||schemaAccepts(child,value[key]));
 }
 if(schema.type==='ARRAY')return Array.isArray(value)&&(schema.minItems===undefined||value.length>=schema.minItems)&&(schema.maxItems===undefined||value.length<=schema.maxItems)&&value.every(item=>schemaAccepts(schema.items,item));
 if(schema.type==='STRING')return typeof value==='string';
 if(schema.type==='INTEGER')return Number.isInteger(value)&&(schema.minimum===undefined||value>=schema.minimum)&&(schema.maximum===undefined||value<=schema.maximum);
 return false;
}
const keywords=new Set(['type','enum','items','nullable','properties','description','propertyOrdering','required']);
function assertSupported(schema){
 for(const [key,value] of Object.entries(schema)){
  assert.ok(keywords.has(key),'Unsupported Vertex responseSchema keyword '+key);
  if(key==='properties')for(const child of Object.values(value))assertSupported(child);
  else if(key==='items')assertSupported(value);
  else if(key==='anyOf')value.forEach(assertSupported);
 }
}
test('actual adapter sends finite, supported, phase-specific schemas and shared instructions without invoking a model',async()=>{
 const requests=[],api={project:'megabrain-v0-1017370021431',async request(url,options){requests.push({url,options});return {candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}]};}},provider=new ReelsSemanticProvider({api}),model='gemini-2.5-flash',requestId='f'.repeat(64),groups=[{id:'fixture-group'}],members=[{groupId:'fixture-group',reelId:sources[0].id}],negativeExamples=[{groupId:'negative-group',reelId:sources[1].id}];
 await provider.infer({sources,catalogue:{groups:[]},requestId,model});
 await provider.consolidate({groups,requestId,model});
 await provider.verify({sources,groups,members,negativeExamples,profiles:[],requestId,model});
 assert.equal(requests.length,3);
 for(const [index,phase] of ['extract','consolidate','verify'].entries()){
  const call=requests[index],request=call.options.json,payload=JSON.parse(request.contents[0].parts[0].text);
  assert.equal(call.options.attempt,1);assert.equal(call.options.timeoutMs,90000);
  assert.equal(payload.phase,phase);assert.equal(request.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(request.generationConfig.responseSchema,semanticSchemaForPhase(phase,payload));
  assert.equal(request.systemInstruction.parts[0].text,[semanticInstruction,semanticConsolidationInstruction,semanticVerificationInstruction][index]);
  assertSupported(request.generationConfig.responseSchema);
  assert.equal(request.generationConfig.responseSchema.properties.version.minimum,undefined);
  assert.equal(request.generationConfig.responseSchema.properties.version.maximum,undefined);assert.match(request.generationConfig.responseSchema.properties.version.description,/1/);
 }
 const extract=requests[0].options.json.generationConfig.responseSchema,consolidate=requests[1].options.json.generationConfig.responseSchema,verify=requests[2].options.json.generationConfig.responseSchema;
 assert.equal(extract.properties.profiles.minItems,undefined);assert.equal(extract.properties.profiles.maxItems,undefined);assert.match(extract.properties.profiles.description,/Exatamente 2/);
 assert.deepEqual(extract.properties.profiles.items.properties.reelId.enum,sources.map(s=>s.id));
 assert.equal(consolidate.properties.resolutions.minItems,undefined);assert.equal(consolidate.properties.resolutions.maxItems,undefined);assert.match(consolidate.properties.resolutions.description,/Exatamente 1/);
 assert.equal(verify.properties.members.minItems,undefined);assert.equal(verify.properties.negativeExamples.maxItems,undefined);
 assert.deepEqual(verify.properties.members.items.properties.reelId.enum,[sources[0].id]);assert.deepEqual(verify.properties.members.items.properties.groupId.enum,['fixture-group']);
 assert.deepEqual(verify.properties.negativeExamples.items.properties.reelId.enum,[sources[1].id]);assert.deepEqual(verify.properties.negativeExamples.items.properties.groupId.enum,['negative-group']);
 assert.notStrictEqual(semanticVerificationSchema.properties.members.items,semanticVerificationSchema.properties.negativeExamples.items);
 assert.equal(semanticVerificationSchema.properties.members.items.properties.reelId.enum,undefined,'Per-request narrowing must not mutate the exported schema');
 assert.equal(semanticWireSchemaVersion,'semantic-wire-flat-v1');
 assert.equal(semanticPromptVersion,S.version);assert.match(semanticPromptHash,/^[a-f0-9]{64}$/);
});
test('flat wire retains enums while conditional facet and canonical recipe rules remain strict server guards',()=>{
 for(const schema of [semanticResponseSchema,semanticConsolidationSchema,semanticVerificationSchema])assertSupported(schema);
 const profiles=semanticResponseSchema.properties.profiles.items.properties;
 assert.deepEqual(profiles.context.enum,S.contexts);assert.deepEqual(profiles.state.enum,S.profileStates);
 assert.deepEqual(profiles.units.items.properties.type.enum,S.unitTypes);assert.deepEqual(profiles.units.items.properties.completeness.enum,S.completeness);
 const flat=semanticResponseSchema.properties.groups.items;
 assert.equal(flat.anyOf,undefined);assert.deepEqual(flat.properties.kind.enum,S.groupKinds);assert.deepEqual(flat.properties.context.enum,S.contexts);assert.deepEqual(flat.properties.dimension.enum,S.facetDimensions);assert.equal(flat.properties.dimension.nullable,true);assert.equal(flat.required.includes('dimension'),false);
 for(const dimension of S.facetDimensions){const output=valid();Object.assign(output.groups[0],{kind:'facet',dimension});assert.equal(schemaAccepts(semanticResponseSchema,output),true);assert.doesNotThrow(()=>validateSemanticOutput(output,sources));}
 for(const dimension of [null,'protein','ingredients','']){const output=valid();Object.assign(output.groups[0],{kind:'facet',dimension});assert.equal(schemaAccepts(semanticResponseSchema,output),dimension===null);assert.throws(()=>validateSemanticOutput(output,sources),{code:'SEMANTIC_FACET_INVALID'});}
 const missing=valid();missing.groups[0].kind='facet';assert.equal(schemaAccepts(semanticResponseSchema,missing),true);assert.throws(()=>validateSemanticOutput(missing,sources),{code:'SEMANTIC_FACET_INVALID'});
 const nonFacet=valid();nonFacet.groups[0].dimension='ingredient';assert.equal(schemaAccepts(semanticResponseSchema,nonFacet),true);assert.throws(()=>validateSemanticOutput(nonFacet,sources),{code:'SEMANTIC_NON_FACET_DIMENSION_FORBIDDEN'});
 for(const bad of [{key:'tipo-de-prato',context:'recipe'},{key:'single_recipe',context:'technology'}]){const output=valid();Object.assign(output.groups[0],{kind:'format',...bad});assert.equal(schemaAccepts(semanticResponseSchema,output),true);assert.throws(()=>validateSemanticOutput(output,sources),{code:'SEMANTIC_FORMAT_NOT_CANONICAL'});}

});
test('wire describes output and array limits while the real extraction validator enforces every boundary',()=>{
 for(const version of [0,2,1.5,'1']){const output=valid();output.version=version;assert.equal(schemaAccepts(semanticResponseSchema,output),Number.isInteger(version));assert.throws(()=>validateSemanticOutput(output,sources));}
 for(const [count,allowed] of [[S.limits.groups,true],[S.limits.groups+1,false]]){const output=valid();output.groups=Array.from({length:count},(_,i)=>({...clone(output.groups[0]),key:'group-'+i}));assert.equal(schemaAccepts(semanticResponseSchema,output),true);if(allowed)assert.doesNotThrow(()=>validateSemanticOutput(output,sources));else assert.throws(()=>validateSemanticOutput(output,sources));}
 for(const [count,allowed] of [[S.limits.units,true],[S.limits.units+1,false]]){const output=valid();output.profiles[0].units=Array.from({length:count},(_,i)=>({unitId:'unit'+i,type:'concept',completeness:'complete',evidence:[proof]}));assert.equal(schemaAccepts(semanticResponseSchema,output),true);if(allowed)assert.doesNotThrow(()=>validateSemanticOutput(output,sources));else assert.throws(()=>validateSemanticOutput(output,sources));}
 for(const count of [0,S.limits.evidence,S.limits.evidence+1]){const output=valid();output.groups[0].members[0].evidence=Array.from({length:count},()=>proof);const allowed=count>0&&count<=S.limits.evidence;assert.equal(schemaAccepts(semanticResponseSchema,output),true);if(allowed)assert.doesNotThrow(()=>validateSemanticOutput(output,sources));else assert.throws(()=>validateSemanticOutput(output,sources));}
 for(const name of ['positiveCriteria','negativeCriteria','members']){const output=valid();output.groups[0][name]=[];assert.equal(schemaAccepts(semanticResponseSchema,output),true);assert.throws(()=>validateSemanticOutput(output,sources));}
});
test('character and regexp limits stay server guards with accurate schema descriptions, not unsupported keywords',()=>{
 const cases=[
  ['profile reason',o=>o.profiles[0],'reason',S.limits.profileReason],
  ['group name',o=>o.groups[0],'name',S.limits.groupName],
  ['group definition',o=>o.groups[0],'definition',S.limits.groupDefinition],
  ['negative reason',o=>o.groups[0].negativeExamples[0],'reason',S.limits.negativeReason]
 ];
 for(const [label,select,field,maximum] of cases){const output=valid();select(output)[field]='a'.repeat(maximum);assert.doesNotThrow(()=>validateSemanticOutput(output,sources),label);select(output)[field]+='a';assert.throws(()=>validateSemanticOutput(output,sources),label);select(output)[field]='   ';assert.throws(()=>validateSemanticOutput(output,sources),label);}
 for(const [name,maximum] of [['aliases',S.limits.label],['positiveCriteria',S.limits.label],['negativeCriteria',S.limits.label]]){const output=valid();output.groups[0][name]=['a'.repeat(maximum)];assert.doesNotThrow(()=>validateSemanticOutput(output,sources));output.groups[0][name][0]+='a';assert.throws(()=>validateSemanticOutput(output,sources));}
 for(const [length,allowed] of [[S.limits.excerpt,true],[S.limits.excerpt+1,false]]){const output=valid();output.groups[0].members[0].evidence=[quote('a'.repeat(length))];if(allowed)assert.doesNotThrow(()=>validateSemanticOutput(output,sources));else assert.throws(()=>validateSemanticOutput(output,sources));}
 const output=valid();output.groups[0].key='a'.repeat(S.limits.groupKey);assert.doesNotThrow(()=>validateSemanticOutput(output,sources));output.groups[0].key+='a';assert.throws(()=>validateSemanticOutput(output,sources));
 for(const [id,allowed] of [['a'.repeat(S.limits.unitId),true],['a'.repeat(S.limits.unitId+1),false],['space not allowed',false]]){const unitOutput=valid();unitOutput.profiles[0].units=[{unitId:id,type:'concept',completeness:'complete',evidence:[proof]}];if(allowed)assert.doesNotThrow(()=>validateSemanticOutput(unitOutput,sources));else assert.throws(()=>validateSemanticOutput(unitOutput,sources));}
});
test('cross-source identity, exact unit evidence and format semantics cannot be replaced by schema success',()=>{
 const expectGuardReject=mutate=>{const output=valid();mutate(output);assert.throws(()=>validateSemanticOutput(output,sources));};
 expectGuardReject(o=>o.profiles.push(clone(o.profiles[0])));expectGuardReject(o=>o.profiles.pop());expectGuardReject(o=>o.profiles[0].reelId='External_001');
 expectGuardReject(o=>o.groups[0].members.push(clone(o.groups[0].members[0])));
 expectGuardReject(o=>o.groups[0].negativeExamples[0].reelId=o.groups[0].members[0].reelId);
 expectGuardReject(o=>o.groups[0].members[0].evidence=[quote('Quote absent from source.')]);
 for(const state of ['unknown','inconclusive'])expectGuardReject(o=>o.profiles[0].state=state);
 const recipe=(key,count)=>{const output=valid(),quotes=[proof,quote('Preparo completo de peixe.')];output.profiles[0].units=Array.from({length:count},(_,i)=>({unitId:'recipe'+i,type:'recipe',completeness:'complete',evidence:[quotes[i]]}));Object.assign(output.groups[0],{kind:'format',key});Object.assign(output.groups[0].members[0],{unitIds:output.profiles[0].units.map(u=>u.unitId),evidence:quotes.slice(0,count)});return output;};
 assert.doesNotThrow(()=>validateSemanticOutput(recipe('single_recipe',1),sources));
 assert.doesNotThrow(()=>validateSemanticOutput(recipe('recipe_collection',2),sources));
 assert.throws(()=>validateSemanticOutput(recipe('recipe_collection',1),sources));
 assert.throws(()=>validateSemanticOutput(recipe('single_recipe',2),sources));
 const truncated=clone(sources);truncated[0].truncated=true;assert.throws(()=>validateSemanticOutput(recipe('single_recipe',1),truncated));
 const unbound=recipe('recipe_collection',2);unbound.groups[0].members[0].evidence=[proof];assert.throws(()=>validateSemanticOutput(unbound,sources));
 const missing=recipe('recipe_collection',2);missing.groups[0].members[0].unitIds.pop();assert.throws(()=>validateSemanticOutput(missing,sources));
 const repeated=recipe('recipe_collection',2);repeated.profiles[0].units[1].evidence=[proof];assert.throws(()=>validateSemanticOutput(repeated,sources));
});
test('verification schemas distinguish supported proofs from abstention without claiming semantic truth',()=>{
 const base={version:1,members:[{groupId:'g',reelId:sources[0].id,verdict:'supported',reason:'Sintético.',evidence:[]}],negativeExamples:[]};
 assert.equal(schemaAccepts(semanticVerificationSchema,base),true);assert.throws(()=>validateSemanticVerificationEvidence(base.members[0],sources[0]));
 base.members[0].verdict='inconclusive';assert.equal(schemaAccepts(semanticVerificationSchema,base),true);assert.doesNotThrow(()=>validateSemanticVerificationEvidence(base.members[0],sources[0]));
 base.members[0].evidence=Array.from({length:S.limits.evidence+1},()=>proof);assert.equal(schemaAccepts(semanticVerificationSchema,base),true);assert.throws(()=>validateSemanticVerificationEvidence(base.members[0],sources[0]));
 const resolutions={version:1,resolutions:[{groupId:'g',decision:'keep',mergeInto:'',reason:'Preservar contexto.'}]};
 assert.equal(schemaAccepts(semanticConsolidationSchema,resolutions),true);resolutions.resolutions[0].decision='invent';assert.equal(schemaAccepts(semanticConsolidationSchema,resolutions),false);
});
