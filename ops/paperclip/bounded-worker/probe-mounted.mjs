// Disposable CI launcher only; never invokes a model or prints credentials.
import {verifyBoundedWorkerProfileMounted,ROOT,PROFILE} from './profile.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
await verifyBoundedWorkerProfileMounted({config:{paperclipSkillProfile:PROFILE},skillsHome:path.join(process.env.CODEX_HOME,'skills')});
const core=await fs.readFile(path.join(ROOT,'skills/paperclip/SKILL.md'),'utf8');
await fs.writeFile('/tmp/profile-probe-result.json',JSON.stringify({profile:PROFILE,coreCharacters:core.length}));
