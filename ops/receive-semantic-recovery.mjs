import {readFile,writeFile,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assembleCatalogueSource} from './prepare-reels-catalogue.mjs';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='mide-lim/MEGA-BRAIN'||!process.env.GH_TOKEN)throw Error('Central GitHub Actions required.');
const [flag,path,outFlag,out]=process.argv.slice(2);if(flag!=='--source'||outFlag!=='--output'||!path||!out)throw Error('Explicit sealed input/output required.');
const config=JSON.parse(await readFile(path,'utf8')),work=await mkdtemp(join(tmpdir(),'semantic-recovery-')),parts=[];
for(let i=0;i<config.parts.length;i++){
 const runId=config.parts[i].runId;if(!Number.isSafeInteger(runId))throw Error('Invalid staged run.');
 const run=JSON.parse(execFileSync('gh',['api','repos/mide-lim/MEGA-BRAIN/actions/runs/'+runId],{encoding:'utf8',maxBuffer:2097152})),directory=join(work,'part-'+i);
 execFileSync('gh',['run','download',String(runId),'--repo','mide-lim/MEGA-BRAIN','--name','catalogue-source-part','--dir',directory],{stdio:['ignore','ignore','ignore'],timeout:60000});
 if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(['manifest.json','source-part.base64']))throw Error('Unexpected source artifact content.');
 parts.push({run,manifest:JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),text:await readFile(join(directory,'source-part.base64'),'utf8')});
}
const bytes=assembleCatalogueSource(config,parts),input=JSON.parse(bytes);
if(input.schemaVersion!==1||input.kind!=='saved_semantic_first_response_reconciliation_input'||input.readOnly!==true||input.providerCalls!==0||input.writes!==0||input.sourceCommit!=='8150c85ad40f48c5cac50048f9b233506259068c'||input.sourceObservationSHA256!=='41c61b96dc59ac85929adad158d29712235083ec64a83c337a9394a2118398cd'||!Array.isArray(input.records)||input.records.length!==3)throw Error('Paid-response reconciliation source differs.');
const expected=['reels_index/semantic_result_3b13566530aaade0978c6f5a2a703ae35dedf7a119b1b613f54b8c5a6ae184fb','reels_index/semantic_raw_3b13566530aaade0978c6f5a2a703ae35dedf7a119b1b613f54b8c5a6ae184fb_0','reels_index/semantic_job_e79360382d0231e58861f62238ecb166541d15b0247c98e65c22ab6e87630197'];
if(JSON.stringify(input.records.map(x=>x.path))!==JSON.stringify(expected))throw Error('Unexpected paid-response records.');
await writeFile(out,bytes,{flag:'wx'});console.log(JSON.stringify({received:true,records:3,inputSHA256:config.inputSHA256,providerCalls:0,googleCredentialsUsed:false}));
