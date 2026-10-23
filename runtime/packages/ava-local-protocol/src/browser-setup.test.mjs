import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBrowserSetup,browserSetupApprovalArgs} from './browser-setup.mjs';
import {parseFrame,encodeFrame} from './protocol.mjs';
test('fixed setup requests cross the actual wire parser',()=>{
 const call={action:'setup',browser:'chrome',mode:'headless'};
 assert.equal(parseFrame(encodeFrame({type:'invoke',id:'browser',op:'browserSetup',args:{call}})).ok,true);
 assert.deepEqual(browserSetupApprovalArgs(call),{server:'ava-browser-setup',tool:'setup',arguments:call});
});
test('setup rejects arbitrary executable/package injection and unsupported attach modes',()=>{
 for(const call of [{action:'setup',browser:'chrome',mode:'headless',command:'shell'},{action:'setup',browser:'edge',mode:'attach'},{action:'status',browser:'chrome'}])assert.throws(()=>parseBrowserSetup(call));
 assert.deepEqual(parseBrowserSetup({action:'status'}),{action:'status'});
});
