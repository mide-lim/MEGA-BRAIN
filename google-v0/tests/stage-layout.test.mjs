import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const example=JSON.parse(await readFile(new URL('../config/stage-workers.example.json',import.meta.url),'utf8'));
const stages=['upload','transcription','analysis'];
const queues=['v0-acquisition','v0-transcription','v0-analysis'];
const services=['megabrain-v0-acquisition','megabrain-v0-transcription','megabrain-v0-analysis'];

test('offline layout declares exactly three unique stage routes and queue audiences',()=>{
  assert.equal(example.example_only,true);assert.equal(example.resources_applied,false);
  assert.deepEqual(Object.keys(example.stage_routes),stages);
  assert.deepEqual(example.queues.map(q=>q.name),queues);
  assert.equal(new Set(Object.values(example.stage_routes).map(r=>r.workerOrigin)).size,3);
  for(const [i,stage] of stages.entries()){
    const route=example.stage_routes[stage];assert.equal(route.queue,queues[i]);
    const origin=new URL(route.workerOrigin);assert.equal(origin.protocol,'https:');
    assert.ok(origin.hostname.endsWith('.run.app'));assert.equal(origin.origin,route.workerOrigin);
    assert.equal(example.services[i].config_overrides.worker_origin,route.workerOrigin);
  }
});
test('all proposed services reuse one image with fixed stage entrypoints and conservative limits',()=>{
  assert.equal(example.requires_build,true);
  assert.equal(example.services.length,3);assert.equal(new Set(example.services.map(s=>s.image)).size,1);
  assert.equal(example.config_source_environment,'MEGABRAIN_V0_WORKER_CONFIG');
  for(const [i,service] of example.services.entries()){
    assert.equal(service.name,services[i]);assert.equal(service.image,example.shared_image);
    assert.deepEqual(service.command,['node','/app/scripts/serve-stage-worker.mjs',stages[i]]);
    assert.equal(service.cpu,1);assert.equal(service.memory,'512Mi');
    assert.equal(service.max_instances,1);assert.equal(service.concurrency,1);
  }
  for(const queue of example.queues){
    assert.equal(queue.max_concurrent_dispatches,1);assert.equal(queue.max_attempts,1);assert.equal(queue.paused,true);
  }
});
test('each stage config is server-owned and all processing producers start closed',()=>{
  for(const [i,service] of example.services.entries()){
    const config=service.config_overrides;
    assert.equal(config.worker_stage,stages[i]);
    for(const key of ['enabled','dispatch_enabled','admission_enabled','assisted_upload_enabled','assisted_single_upload_enabled'])assert.equal(config[key],false);
  }
  const raw=JSON.stringify(example);
  assert.doesNotMatch(raw,/@sha256:|Bearer |-----BEGIN|secretVersion|access_token|private_key|skip.*gate|bypass/i);
});
