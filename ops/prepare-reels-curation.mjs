import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readFile,writeFile,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const digest=v=>createHash('sha256').update(v).digest('hex');
const REPO='mide-lim/MEGA-BRAIN',BRANCH='codex/category-calibration-worker-quality';
const fail=()=>{throw Error('Saved-source artifact provenance, bounds or hash differs.');};
export function assembleCalibrationSource(config,parts){
 if(config?.schemaVersion!==1||config.branch!==BRANCH||!/^[a-f0-9]{40}$/.test(config.stagingSourceCommit??'')||!/^[a-f0-9]{64}$/.test(config.inputSHA256??'')||!Array.isArray(config.parts)||!config.parts.length||config.parts.length>6||new Set(config.parts.map(p=>p.runId)).size!==config.parts.length||parts.length!==config.parts.length)fail();
 let encoded='';
 for(let i=0;i<parts.length;i++){
  const {manifest,text,run}=parts[i],expected=config.parts[i];
  if(!Number.isSafeInteger(expected.runId)||manifest.runId!==String(expected.runId)||manifest.partIndex!==i+1||manifest.partCount!==parts.length||manifest.sourceCommit!==config.stagingSourceCommit||manifest.inputSHA256!==config.inputSHA256||manifest.branch!==BRANCH||run.id!==expected.runId||run.head_sha!==config.stagingSourceCommit||run.head_branch!==BRANCH||run.event!=='workflow_dispatch'||run.path!=='.github/workflows/reels-alignment-review.yml'||run.conclusion!=='success'||run.repository?.full_name!==REPO||!text||text.length>55000||!/^[A-Za-z0-9+/=]+$/.test(text)||digest(text)!==manifest.encodedPartSHA256)fail();
  encoded+=text;
 }
 if(encoded.length>330000||encoded.length%4!==0)fail();
 const compressed=Buffer.from(encoded,'base64');if(compressed.toString('base64')!==encoded)fail();
 const bytes=gunzipSync(compressed,{maxOutputLength:4*1024*1024});if(digest(bytes)!==config.inputSHA256)fail();
 const source=JSON.parse(bytes);if(source.schemaVersion!==1||!Array.isArray(source.records)||source.records.length>40||!Array.isArray(source.annotations)||source.annotations.length>300||!Array.isArray(source.catalogRecords)||source.catalogRecords.length>2000)fail();
 return bytes;
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!==REPO||!process.env.GH_TOKEN)throw Error('Artifact preparation is restricted to central GitHub Actions.');
 const [flag,path,outFlag,out]=process.argv.slice(2);if(flag!=='--source'||outFlag!=='--output'||!path||!out)throw Error('Expected source config and output path.');
 const config=JSON.parse(await readFile(path,'utf8')),parts=[];
 if(!Array.isArray(config.parts)||config.parts.length>6)fail();
 const work=await mkdtemp(join(tmpdir(),'curation-sources-'));
 for(let i=0;i<config.parts.length;i++){
  const runId=config.parts[i].runId;if(!Number.isSafeInteger(runId)||runId<1)fail();
  const run=JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/actions/runs/'+runId],{encoding:'utf8',maxBuffer:2*1024*1024}));
  const directory=join(work,'part-'+(i+1));
  execFileSync('gh',['run','download',String(runId),'--repo',REPO,'--name','curation-source-part','--dir',directory],{stdio:['ignore','ignore','ignore'],timeout:60000});
  const names=(await readdir(directory)).sort();if(JSON.stringify(names)!==JSON.stringify(['manifest.json','source-part.base64']))fail();
  parts.push({run,manifest:JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),text:await readFile(join(directory,'source-part.base64'),'utf8')});
 }
 const bytes=assembleCalibrationSource(config,parts);await writeFile(out,bytes,{flag:'wx'});console.log(JSON.stringify({sourceAssembled:true,bytes:bytes.length,parts:parts.length,googleCredentialsUsed:false,providers:0}));
}
if(process.argv[1]?.endsWith('/prepare-reels-curation.mjs'))await main();
