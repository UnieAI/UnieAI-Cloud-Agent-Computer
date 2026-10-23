import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openTerminal, listTerminals, closeTerminal, _resetTerminals} from './registry.mjs';
afterEach(_resetTerminals);
test('provider slots deduplicate concurrent opens and remain discoverable after a lost receipt', async()=>{
  let count=0;
  const backend={openTerminal:async()=>{count++; await new Promise(r=>setTimeout(r,5));return new EventEmitter();}};
  const args={sandboxId:'a',backend,spec:{slot:'chat.claude'},attachDeadlineMs:0};
  const [a,b]=await Promise.all([openTerminal(args),openTerminal(args)]);
  assert.equal(a.terminalId,b.terminalId);assert.equal(count,1);
  assert.equal(listTerminals('a')[0].slot,'chat.claude');
  assert.equal((await openTerminal(args)).terminalId,a.terminalId);
  const codex=await openTerminal({...args,spec:{slot:'chat.codex'}});
  assert.notEqual(codex.terminalId,a.terminalId);
  const other=await openTerminal({...args,sandboxId:'b'});
  assert.notEqual(other.terminalId,a.terminalId);
  await closeTerminal('a',a.terminalId);
  assert.notEqual((await openTerminal(args)).terminalId,a.terminalId);
});
test('invalid slots refuse before opening a shell',async()=>{
  await assert.rejects(openTerminal({sandboxId:'a',backend:{openTerminal:()=>{throw Error('must not open');}},spec:{slot:'../../x'}}),/Invalid terminal slot/);
});
