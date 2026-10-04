import {verifyPilotBackup,restorePilotBackupLocally} from '../lib/pilot-backup.mjs';
const [action,source,destination]=process.argv.slice(2);
try{
 if(action==='verify'){
  const {manifest}=await verifyPilotBackup(source);
  console.log(JSON.stringify({verified:true,document_count:manifest.document_count,object_count:manifest.objects.length}));
 }else if(action==='restore-local')console.log(JSON.stringify(await restorePilotBackupLocally({source,destination})));
 else throw new Error('Use verify ou restore-local com caminhos absolutos.');
}catch{console.error(JSON.stringify({completed:false,google_mutations:0,automatic_retry:false}));process.exitCode=1;}
