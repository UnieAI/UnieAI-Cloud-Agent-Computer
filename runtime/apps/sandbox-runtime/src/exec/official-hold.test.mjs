import test from 'node:test';
import assert from 'node:assert/strict';
import {officialHarnessHold} from './official-hold.mjs';

const binding={sessionId:'774ca436-e769-4c58-a3ef-27c72ee460cb',provider:'claude',cwd:'/workspace'};
test('background hold observes the admitted session for longer than the native turn budget',()=>{
  const hold=officialHarnessHold(binding);
  assert.ok(hold.timeoutMs>60*60_000);
  const request=JSON.parse(hold.payload.stdin);
  assert.equal(request.hold,true);
  assert.deepEqual(request.call,{action:'read',...binding});
});
test('background hold cannot inject a command, prompt, path or provider',()=>{
  for(const override of [{command:'touch /tmp/unsafe'},{text:'replay this'},{cwd:'/tmp'},{provider:'other'},{sessionId:'------------------------------------'}])
    assert.throws(()=>officialHarnessHold({...binding,...override}),/Invalid official harness observer/);
});
