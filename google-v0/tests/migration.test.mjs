import test from 'node:test';
import assert from 'node:assert/strict';
import {planMigration} from '../lib/migration.mjs';
const row = {id:'DXVj0SkDesv',status:'analyzed',video_key:'original/instagram/reels/DXVj0SkDesv/video.mp4',transcript:'Transcrição preservada',analysis:{version:1}};
test('existing media and transcript are reused without a paid request', () => {
  const before=JSON.stringify(row),p=planMigration([row]);
  assert.equal(p.items[0].media_action,'copy_and_verify');assert.equal(p.items[0].transcript_action,'reuse_immutable');
  assert.equal(p.items[0].delete_source,false);assert.equal(p.paid_calls,0);assert.equal(JSON.stringify(row),before);
});
test('missing media defers Instagram download instead of pretending a copy succeeded', () => {
  assert.equal(planMigration([{...row,video_key:null}]).items[0].media_action,'defer_download');
});
test('duplicate IDs and storage keys outside the item scope are rejected', () => {
  assert.throws(()=>planMigration([row,row]));assert.throws(()=>planMigration([{...row,video_key:'private/other-account'}]));
});
