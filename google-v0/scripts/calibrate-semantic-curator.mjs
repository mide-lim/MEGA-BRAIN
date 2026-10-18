import {readFile,writeFile} from 'node:fs/promises';
import {evaluateSemanticCalibration} from '../lib/reels-semantic-calibration.mjs';
const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--input'||args[2]!=='--output')throw Error('Usage: --input saved-evaluation.json --output receipt.json');
const text=await readFile(args[1],'utf8');if(Buffer.byteLength(text)>4000000)throw Error('CALIBRATION_INPUT_LIMIT');
const receipt=evaluateSemanticCalibration(JSON.parse(text));await writeFile(args[3],JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({verdict:receipt.verdict,receiptHash:receipt.receiptHash,evaluated:receipt.holdout.total,providerCalls:0}));
