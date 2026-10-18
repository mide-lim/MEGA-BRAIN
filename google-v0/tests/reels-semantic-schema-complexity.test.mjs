import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve,relative} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {semanticResponseSchema,semanticConsolidationSchema,semanticVerificationSchema,semanticSchemaForPhase,semanticWireSchemaVersion} from '../lib/reels-semantic-provider.mjs';
import {measureSemanticSchema} from '../scripts/diagnose-semantic-next-input.mjs';
const report=schema=>({bytes:Buffer.byteLength(JSON.stringify(schema),'utf8'),...measureSemanticSchema(schema)});
const current={extract:semanticResponseSchema,consolidate:semanticConsolidationSchema,verify:semanticVerificationSchema};
test('flat response schemas use typed enums without anyOf or numeric bounds, while semantic policy remains server-owned',()=>{
 assert.equal(semanticWireSchemaVersion,'semantic-wire-flat-v1');
 for(const schema of Object.values(current)){const m=report(schema);assert.equal(m.anyOfNodes,0);assert.equal(m.anyOfBranches,0);assert.equal(m.bounds,0);assert.deepEqual(m.missingType,[]);assert.deepEqual(m.unsupportedKeywords,[]);assert.ok(m.enumFields>0);}
 const ids=Array.from({length:8},(_,i)=>'QaMetrics_'+i),schema=semanticSchemaForPhase('extract',{sources:ids.map(id=>({id})),catalogue:{groups:[]}}),m=report(schema);
 assert.equal(m.bounds,0);assert.equal(m.anyOfNodes,0);assert.deepEqual(schema.properties.profiles.items.properties.reelId.enum,ids);assert.deepEqual(schema.properties.groups.items.properties.members.items.properties.reelId.enum,ids);
});
test('pinned old8150 and conditional120293 wire schema measurements compare with the one flat candidate in GitHub only',{skip:!process.env.SEMANTIC_SCHEMA_BASES_DIR},async()=>{
 assert.equal(process.env.GITHUB_ACTIONS,'true');
 const dir=process.env.SEMANTIC_SCHEMA_BASES_DIR,old=await import(pathToFileURL(resolve(dir,'semantic-provider-8150.mjs')).href),conditional=await import(pathToFileURL(resolve(dir,'semantic-provider-120293.mjs')).href),result={version:1,kind:'semantic_wire_schema_complexity_comparison',historicalExecutionReproduced:false,providerCalls:0,oldCommit:'8150c85ad40f48c5cac50048f9b233506259068c',conditionalCommit:'120293ac4286e04ef89980e394eb72619967b501',schemas:{}};
 for(const [phase,key]of [['extract','semanticResponseSchema'],['consolidate','semanticConsolidationSchema'],['verify','semanticVerificationSchema']]){
  const rows={old8150:report(old[key]),conditional120293:report(conditional[key]),flat:report(current[phase])};result.schemas[phase]=rows;assert.equal(rows.old8150.anyOfNodes,0);assert.equal(rows.flat.anyOfNodes,0);assert.equal(rows.flat.bounds,0);assert.deepEqual(rows.flat.missingType,[]);if(phase!=='consolidate'){assert.ok(rows.conditional120293.anyOfNodes>0);assert.ok(rows.flat.nodes<rows.conditional120293.nodes);assert.ok(rows.flat.bytes<rows.conditional120293.bytes);}
 }
 if(process.env.SEMANTIC_SCHEMA_METRICS_OUTPUT){const output=resolve(process.env.SEMANTIC_SCHEMA_METRICS_OUTPUT),scope=resolve(process.env.RUNNER_TEMP??'');assert.ok(process.env.RUNNER_TEMP);assert.equal(relative(scope,output).startsWith('..'),false);await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}else console.log(JSON.stringify(result));
});
