import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
// Request construction only. Any accidental provider call fails locally in CI.
globalThis.fetch=()=>{throw Error('Network forbidden in offline request diagnosis');};
const [oldRoot,newRoot,outDir]=process.argv.slice(2);if(!oldRoot||!newRoot||!outDir)throw Error('Three paths required');
const fixtureBytes=readFileSync(new URL('../google-v0/tests/fixtures/meg109-request-shape.json',import.meta.url));
const fixture=JSON.parse(fixtureBytes);
mkdirSync(outDir,{recursive:true});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const write=(name,x)=>writeFileSync(resolve(outDir,name),JSON.stringify(x,null,2)+'\n');
function metrics(schema){
 const rows=[],issues=[];let maxDepth=0,enumValues=0,enumBytes=0;
 function walk(x,path='$',depth=0){
  if(!x||typeof x!=='object'||Array.isArray(x))return;maxDepth=Math.max(maxDepth,depth);
  const row={path,depth,minItems:x.minItems??null,maxItems:x.maxItems??null,type:x.type,required:x.required??[],nullable:x.nullable===true,enumCount:x.enum?.length??0,enumBytes:Buffer.byteLength(JSON.stringify(x.enum??[])),properties:Object.keys(x.properties??{}).length};
  if(!(x.type===undefined&&Array.isArray(x.anyOf)&&x.anyOf.length)&&!['STRING','INTEGER','NUMBER','BOOLEAN','OBJECT','ARRAY'].includes(x.type))issues.push({path,issue:'unknown schema type',type:x.type});
  if(x.nullable!==undefined&&typeof x.nullable!=='boolean')issues.push({path,issue:'nonboolean nullable'});
  if(x.enum&&x.type!=='STRING')issues.push({path,issue:'enum on non-string type'});
  for(const key of ['minItems','maxItems'])if(x[key]!==undefined&&(!Number.isInteger(x[key])||x[key]<0))issues.push({path,issue:'invalid array bound',key});
  if(x.minItems!==undefined&&x.maxItems!==undefined&&x.minItems>x.maxItems)issues.push({path,issue:'inverted array bounds'});
  rows.push(row);if(x.enum){enumValues+=x.enum.length;enumBytes+=row.enumBytes;if(!x.enum.length||x.enum.some(v=>typeof v!=='string'))issues.push({path,issue:'empty/non-string enum'});}
  for(const k of x.required??[])if(!Object.hasOwn(x.properties??{},k))issues.push({path,issue:'required missing property',key:k});
  for(const [k,v] of Object.entries(x.properties??{}))walk(v,path+'.'+k,depth+1);if(x.items)walk(x.items,path+'[]',depth+1);for(const [i,v] of (x.anyOf??[]).entries())walk(v,path+'.anyOf['+i+']',depth+1);
 }
 walk(schema);return {schemaBytes:Buffer.byteLength(JSON.stringify(schema)),maxDepth,enumValues,enumBytes,nullableEnums:rows.filter(r=>r.nullable&&r.enumCount).length,issues,paths:rows};
}
const result={mode:'offline reconstruction only',noProviderCalls:true,notVertexValidation:true,provenance:fixture.provenance,fixtureSha256:createHash('sha256').update(fixtureBytes).digest('hex'),sourceCommits:{PR98:execFileSync('git',['-C',oldRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),PR99:execFileSync('git',['-C',newRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim()},comparisons:[]};
for(const [version,root] of [['PR98',oldRoot],['PR99',newRoot]]){
 const {buildAnalysisRequest}=await import(pathToFileURL(resolve(root,'google-v0/lib/analysis.mjs')));
 const preset=JSON.parse(readFileSync(resolve(root,'google-v0/config/analysis-preset.json')));
 for(const [catalogue,contextCatalogSnapshot] of [['none',null],['prior-proxy',fixture.priorCatalogueProxy]])for(const taxonomySignalsEnabled of [false,true]){
  const name=version+'-'+catalogue+'-taxonomy-'+taxonomySignalsEnabled;
  const request=buildAnalysisRequest({record:fixture.record,bucket:'megabrain-v0-1017370021431-media',preset,model:'gemini-3.5-flash-lite',qualityGateV2Enabled:true,taxonomySignalsEnabled,contextCatalogSnapshot});
  const schema=request.generationConfig.responseSchema,payload=JSON.parse(request.contents[0].parts[1].text),m=metrics(schema);
  write(name+'-request.json',request);write(name+'-schema.json',schema);write(name+'-metrics.json',m);
  result.comparisons.push({name,requestBytes:Buffer.byteLength(JSON.stringify(request)),requestHash:hash(request),schemaHash:hash(schema),anchorCount:payload.source_time_anchors.length,anchorHash:payload.evidence_anchor_hash,...Object.fromEntries(Object.entries(m).filter(([k])=>k!=='paths'))});
 }
}
write('summary.json',result);console.log(JSON.stringify(result,null,2));
if(result.comparisons.some(x=>x.issues.length))process.exitCode=1;
