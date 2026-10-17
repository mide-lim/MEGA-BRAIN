import {readFile,stat} from 'node:fs/promises';
import {prepareReelsPilot} from '../lib/reels-pilot-readiness.mjs';
const usage='Uso: node google-v0/scripts/prepare-reels-pilot.mjs --observation arquivo.json --candidate SHA40';
async function main(){
 const args=process.argv.slice(2),options={};
 if(args.length!==4)throw new Error(usage);
 for(let index=0;index<args.length;index+=2){
  const flag=args[index];if(!['--observation','--candidate'].includes(flag)||options[flag])throw new Error(usage);options[flag]=args[index+1];
 }
 if(!options['--observation']||!options['--candidate'])throw new Error(usage);
 const file=await stat(options['--observation']);
 if(!file.isFile()||file.size>1048576)throw new Error('Observação deve ser um arquivo JSON sanitizado de até 1 MiB.');
 const text=await readFile(options['--observation'],'utf8');
 if(Buffer.byteLength(text)>1048576)throw new Error('Observação excede o limite.');
 let observation;try{observation=JSON.parse(text);}catch{throw new Error('Observação JSON inválida; nenhum conteúdo foi reproduzido.');}
 const report=prepareReelsPilot({candidateCommit:options['--candidate'],observation});
 process.stdout.write(JSON.stringify(report,null,2)+'\n');
 process.exitCode=report.blockers.length?2:0;
}
try{await main();}catch(error){
 const known=error?.message===usage||/^(Candidato deve|Observação deve|Observação excede|Observação JSON inválida)/.test(error?.message??'');
 process.stderr.write((known?error.message:'Não foi possível ler a observação sanitizada. Nenhuma ação foi aplicada.')+'\n');process.exitCode=1;
}
