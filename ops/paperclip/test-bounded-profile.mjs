import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {assertBoundedWorkerEligibility, createProfileRuntime, PROFILE, KEY, ROOT, BASELINE} from '/app/skill-profiles/bounded-worker/profile.mjs';
import {ensureCodexSkillsInjected} from '/app/packages/adapters/codex-local/src/server/execute.ts';
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'bounded-profile-'));
let checks=0;
async function check(name,run){await run();checks++;console.log('PASS '+name);}
const config={paperclipSkillProfile:PROFILE,command:'/usr/local/bin/codex-pilot',engine:'cli'};
const agent={adapterType:'codex_local'};
const entries=[{key:KEY,runtimeName:'paperclip',source:BASELINE,required:true},{key:'optional/example',runtimeName:'example',source:'/missing/optional'}];
const input={config,agent,remote:false,connectorSkillDigest:null,entries};
const runtime=createProfileRuntime();
try {
 await check('default keeps entries without reading profile',async()=>{
  const absent=createProfileRuntime('/missing/profile');
  for(const flag of [undefined,'upstream']) assert.equal(await absent.select({...input,config:{paperclipSkillProfile:flag},agent:{adapterType:'other'}}),entries);
 });
 await check('explicit eligible profile replaces only operational source',async()=>{
  const selected=await runtime.select(input);
  assert.equal(selected[0].source,runtime.bundle);assert.equal(selected[1],entries[1]);assert.equal(entries[0].source,BASELINE);
 });
 for(const [name,change] of Object.entries({
  unknown:{config:{...config,paperclipSkillProfile:'other'}},
  adapter:{agent:{adapterType:'other'}}, command:{config:{...config,command:'codex'}},
  engine:{config:{...config,engine:'api'}},remote:{remote:true},connector:{connectorSkillDigest:'changed'},
  missing:{entries:[]},duplicate:{entries:[entries[0],entries[0]]},
  runtimeName:{entries:[{...entries[0],runtimeName:'custom'}]},source:{entries:[{...entries[0],source:scratch}]},
 })) await check('reject '+name,()=>assert.rejects(runtime.select({...input,...change})));
 await check('early gate rejects ACP before engine dispatch',()=>assert.throws(()=>assertBoundedWorkerEligibility({config:{...config,engine:'acp'},agent})));
 await check('baseline content drift rejected',async()=>{
  const baseline=path.join(scratch,'baseline');await fs.mkdir(baseline);await fs.writeFile(path.join(baseline,'SKILL.md'),'changed');
  await assert.rejects(createProfileRuntime(ROOT,baseline).select({...input,entries:[{...entries[0],source:baseline}]}));
 });
 for(const mutation of ['content','missing','extra','symlink','manifestSymlink','invalidManifest','invalidDigest']) {
  await check('reject bundle '+mutation,async()=>{
   const root=path.join(scratch,mutation);await fs.cp(ROOT,root,{recursive:true});
   async function writable(dir){await fs.chmod(dir,0o700);for(const item of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,item.name);if(item.isDirectory()) await writable(full);else await fs.chmod(full,0o600);}}
   await writable(root);
   const core=path.join(root,'skills/paperclip/SKILL.md');const manifestPath=path.join(root,'manifest.json');
   if(mutation==='content') await fs.appendFile(core,'changed');
   if(mutation==='missing') await fs.unlink(core);
   if(mutation==='extra') await fs.writeFile(path.join(root,'skills/paperclip/extra.txt'),'extra');
   if(mutation==='symlink'){await fs.unlink(core);await fs.symlink(path.join(BASELINE,'SKILL.md'),core);}
   if(mutation==='manifestSymlink'){await fs.unlink(manifestPath);await fs.symlink(path.join(ROOT,'manifest.json'),manifestPath);}
   if(mutation==='invalidManifest') await fs.writeFile(manifestPath,JSON.stringify({profile:PROFILE,format:1,files:'invalid'}));
   if(mutation==='invalidDigest'){const m=JSON.parse(await fs.readFile(manifestPath));m.files['SKILL.md']='invalid';await fs.writeFile(manifestPath,JSON.stringify(m));}
   await assert.rejects(createProfileRuntime(root).verify());
  });
 }
 const home=path.join(scratch,'home');await fs.mkdir(home);
 await check('missing mounted skill rejected',()=>assert.rejects(runtime.mounted({config,skillsHome:home})));
 await fs.mkdir(path.join(home,'paperclip'));
 await check('custom directory is not accepted as profile',()=>assert.rejects(runtime.mounted({config,skillsHome:home})));
 await fs.rmdir(path.join(home,'paperclip'));
 await fs.symlink(BASELINE,path.join(home,'paperclip'));
 await check('wrong mounted source rejected',()=>assert.rejects(runtime.mounted({config,skillsHome:home})));
 const selected=await runtime.select(input);
 await check('real upstream injector switches original to compact',async()=>{
  await ensureCodexSkillsInjected(async()=>{}, {skillsHome:home,skillsEntries:[selected[0]],desiredSkillNames:[KEY]});
  await runtime.mounted({config,skillsHome:home});assert.equal(await fs.realpath(path.join(home,'paperclip')),runtime.bundle);
 });
 await check('real upstream injector restores original on rollback',async()=>{
  await ensureCodexSkillsInjected(async()=>{}, {skillsHome:home,skillsEntries:[entries[0]],desiredSkillNames:[KEY]});
  assert.equal(await fs.realpath(path.join(home,'paperclip')),BASELINE);
  await runtime.mounted({config:{paperclipSkillProfile:'upstream'},skillsHome:home});
 });
 const core=await fs.readFile(path.join(runtime.bundle,'SKILL.md'),'utf8');
 const refs=core.matchAll(/\]\((references\/[^)]+)\)/g);
 for(const match of refs) assert((await fs.stat(path.join(runtime.bundle,match[1]))).isFile());
 console.log(JSON.stringify({checks,coreCharacters:core.length,modelCalls:0}));
} finally {await fs.rm(scratch,{recursive:true,force:true});}
