import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readFile,writeFile,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const hash=b=>createHash('sha256').update(b).digest('hex');
const REPO='mide-lim/MEGA-BRAIN',BRANCH='codex/full-catalogue-calibration';
const invalid=()=>{throw Error('Catalogue source transport differs from sealed provenance.');};
export function assembleCatalogueSource(config,parts){
 if(config?.schemaVersion!==1||config.branch!==BRANCH||!/^[a-f0-9]{40}$/.test(config.stagingSourceCommit??'')||!/^[a-f0-9]{64}$/.test(config.inputSHA256??'')||!Array.isArray(config.parts)||config.parts.length<1||config.parts.length>24||parts.length!==config.parts.length||new Set(config.parts.map(p=>p.runId)).size!==parts.length)invalid();
 let encoded='';
 for(let i=0;i<parts.length;i++){
  const {manifest,text,run}=parts[i],expected=config.parts[i];
  if(!Number.isSafeInteger(expected.runId)||manifest.runId!==String(expected.runId)||manifest.partIndex!==i+1||manifest.partCount!==parts.length||manifest.sourceCommit!==config.stagingSourceCommit||manifest.inputSHA256!==config.inputSHA256||manifest.branch!==BRANCH||run.id!==expected.runId||run.head_sha!==config.stagingSourceCommit||run.head_branch!==BRANCH||run.event!=='workflow_dispatch'||run.path!=='.github/workflows/reels-alignment-review.yml'||run.conclusion!=='success'||run.repository?.full_name!==REPO||typeof text!=='string'||text.length<1||text.length>55000||!/^[A-Za-z0-9+/=]+$/.test(text)||hash(text)!==manifest.encodedPartSHA256)invalid();
  encoded+=text;
 }
 if(encoded.length>1320000||encoded.length%4)invalid();
 const compressed=Buffer.from(encoded,'base64');if(compressed.toString('base64')!==encoded)invalid();
 const bytes=gunzipSync(compressed,{maxOutputLength:6*1024*1024});if(hash(bytes)!==config.inputSHA256)invalid();
 return bytes;
}
async function download(config){
 const parts=[],work=await mkdtemp(join(tmpdir(),'catalogue-source-'));
 for(let i=0;i<config.parts.length;i++){
  const runId=config.parts[i].runId;if(!Number.isSafeInteger(runId))invalid();
  const run=JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/actions/runs/'+runId],{encoding:'utf8',maxBuffer:2097152}));
  const directory=join(work,'part-'+i);
  execFileSync('gh',['run','download',String(runId),'--repo',REPO,'--name','catalogue-source-part','--dir',directory],{stdio:['ignore','ignore','ignore'],timeout:60000});
  if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(['manifest.json','source-part.base64']))invalid();
  parts.push({run,manifest:JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),text:await readFile(join(directory,'source-part.base64'),'utf8')});
 }
 return assembleCatalogueSource(config,parts);
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!==REPO||!process.env.GH_TOKEN)throw Error('Central GitHub Actions required.');
 const [flag,path,outFlag,out]=process.argv.slice(2);if(flag!=='--source'||outFlag!=='--output'||!path||!out)invalid();
 const config=JSON.parse(await readFile(path,'utf8')),snapshot=await download(config.snapshot),bundle=JSON.parse(await download(config.annotations));
 const observation=JSON.parse(snapshot);if(observation.readOnly!==true||observation.writes!==0||observation.providerCalls!==0||!Array.isArray(observation.records)||observation.records.length>2000)invalid();
 const files={};
 for(const [name,expected] of Object.entries(config.annotationFiles??{})){
  const row=bundle.files?.[name];if(!row||row.sha256!==expected)invalid();const bytes=Buffer.from(row.base64,'base64');if(hash(bytes)!==expected)invalid();files[name]=JSON.parse(bytes);
 }
 const annotations=files['full-catalogue-format-annotations-v1.json'],blind=files['full-catalogue-blind-labels-v1.json'];
 if(!annotations?.sealedBeforeNewAlgorithmPredictions||!blind?.sealedBeforeNewAlgorithmPredictions||annotations.sourceObservationSHA256!==config.snapshot.inputSHA256||blind.sourceObservationSHA256!==config.snapshot.inputSHA256)invalid();
 await writeFile(out,JSON.stringify({schemaVersion:1,observation,sourceObservationSHA256:config.snapshot.inputSHA256,formatAnnotations:annotations,blindAnnotations:blind,annotationHashes:config.annotationFiles})+'\n',{flag:'wx'});
 console.log(JSON.stringify({assembled:true,savedRecords:observation.records.length,googleCalls:0,providerCalls:0}));
}
if(process.argv[1]?.endsWith('/prepare-reels-catalogue.mjs'))await main();
