import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {openTerminal,attachTerminal,_resetTerminals} from './registry.mjs';
afterEach(_resetTerminals);
function response(){const res=new EventEmitter();res.frames=[];res.writeHead=()=>{};res.write=value=>res.frames.push(value);return res;}
function replay(res){return res.frames.filter(x=>x.startsWith('event: data')).map(x=>Buffer.from(JSON.parse(x.split('\ndata: ')[1].trim()).data,'base64').toString()).join('');}
test('private auth output replays across disconnects and stays bounded, ordinary terminals do not replay consumed output',async()=>{
 for(const auth of [true,false]){
  const handle=new EventEmitter();const backend={openTerminal:async()=>handle};
  const {terminalId}=await openTerminal({sandboxId:'private',backend,spec:{env:auth?{AVA_OFFICIAL_AUTH:'codex.connect'}:{}},attachDeadlineMs:0});
  const first=response();attachTerminal('private',terminalId,first);
  handle.emit('data',Buffer.from('official challenge'));
  first.emit('close');
  const second=response();attachTerminal('private',terminalId,second);
  assert.equal(replay(second),auth?'official challenge':'');
  assert.throws(()=>attachTerminal('other-user',terminalId,response()),/no terminal/);
  if(auth){handle.emit('data',Buffer.alloc(128*1024,120));second.emit('close');const third=response();attachTerminal('private',terminalId,third);assert.equal(Buffer.byteLength(replay(third)),65536);third.emit('close');}
  else second.emit('close');
 }
});
test('invalid auth intent fails before launching a process',async()=>{
 let launched=false;
 await assert.rejects(openTerminal({sandboxId:'private',backend:{openTerminal:async()=>{launched=true;return new EventEmitter();}},spec:{env:{AVA_OFFICIAL_AUTH:'sh.connect'}}}),/invalid_official_auth_intent/);
 assert.equal(launched,false);
});
