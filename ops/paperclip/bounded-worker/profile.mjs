import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const PROFILE='bounded-worker-v1';
export const KEY='paperclipai/paperclip/paperclip';
export const ROOT='/app/skill-profiles/bounded-worker';
export const BASELINE='/app/skills/paperclip';
export const BASELINE_SHA='9f1d16ec93444b34554e731cb5c1576b4850f4afab4494f91cac889627be68a6';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertBoundedWorkerEligibility({config,agent}) {
 const flag=config.paperclipSkillProfile;
 if(flag==null || flag==='upstream') return false;
 if(flag!==PROFILE) throw Error('Unknown Paperclip skill profile');
 if(agent.adapterType!=='codex_local' || config.command!=='/usr/local/bin/codex-pilot' || config.engine!=='cli') throw Error('Bounded profile requires local pilot CLI');
 return true;
}
export function createProfileRuntime(root=ROOT, baseline=BASELINE) {
 const bundle=path.join(root,'skills','paperclip');
 async function verify() {
  if(await fs.realpath(bundle)!==bundle) throw Error('Profile root must not be a symlink');
  const manifestPath=path.join(root,'manifest.json');
  if(!(await fs.lstat(manifestPath)).isFile()) throw Error('Manifest must be a regular file');
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  if(manifest.profile!==PROFILE || manifest.format!==1 || !manifest.files || typeof manifest.files!=='object' || Array.isArray(manifest.files)) throw Error('Invalid profile manifest');
  const actual=[];
  async function walk(dir) {
   for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    const stat=await fs.lstat(full);
    if(stat.isSymbolicLink()) throw Error('Profile symlinks forbidden');
    if(stat.isDirectory()) await walk(full);
    else if(stat.isFile()) actual.push(path.relative(bundle,full).split(path.sep).join('/'));
    else throw Error('Unexpected profile file type');
   }
  }
  await walk(bundle);
  const expected=Object.keys(manifest.files);
  if(!expected.includes('SKILL.md') || JSON.stringify(actual.sort())!==JSON.stringify(expected.sort())) throw Error('Profile file set mismatch');
  for(const name of expected) {
   if(typeof manifest.files[name]!=='string' || !/^[a-f0-9]{64}$/.test(manifest.files[name])) throw Error('Invalid content digest');
   if(name.startsWith('/') || name.includes('\\') || name.split('/').some(x=>!x || x==='.' || x==='..')) throw Error('Unsafe profile path');
   const bytes=await fs.readFile(path.join(bundle,name));
   if(digest(bytes)!==manifest.files[name]) throw Error('Profile content hash mismatch');
  }
  return manifest;
 }
 async function select({config,agent,remote,connectorSkillDigest,entries}) {
  if(!assertBoundedWorkerEligibility({config,agent})) return entries;
  if(remote || connectorSkillDigest) throw Error('Bounded profile requires local pilot CLI without connector overrides');
  const matching=entries.filter(e=>e.key===KEY);
  if(matching.length!==1 || matching[0].runtimeName!=='paperclip') throw Error('Operational skill identity mismatch');
  if(await fs.realpath(matching[0].source)!==baseline) throw Error('Assigned operational source cannot be overridden');
  const original=await fs.readFile(path.join(baseline,'SKILL.md'));
  if(digest(original)!==BASELINE_SHA) throw Error('Pinned operational skill changed');
  await verify();
  return entries.map(e=>e.key===KEY?{...e,source:bundle}:e);
 }
 async function mounted({config,skillsHome}) {
  if(config.paperclipSkillProfile==null || config.paperclipSkillProfile==='upstream') return;
  if(config.paperclipSkillProfile!==PROFILE) throw Error('Unknown Paperclip skill profile');
  await verify();
  const target=path.join(skillsHome,'paperclip');
  if(!(await fs.lstat(target)).isSymbolicLink() || await fs.realpath(target)!==bundle) throw Error('Bounded operational skill was not mounted');
 }
 return {select,mounted,verify,bundle};
}
const runtime=createProfileRuntime();
export const selectBoundedWorkerProfile=input=>runtime.select(input);
export const verifyBoundedWorkerProfileMounted=input=>runtime.mounted(input);
