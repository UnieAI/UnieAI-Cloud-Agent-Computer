import test from 'node:test';
import assert from 'node:assert/strict';
import {officialHomeMount} from './official-home.mjs';
test('official auth survives container replacement but is never shared across users or workspaces',()=>{
 assert.deepEqual(officialHomeMount('alice','group:shared'),officialHomeMount('alice','group:shared'));
 assert.notDeepEqual(officialHomeMount('alice','group:shared'),officialHomeMount('bob','group:shared'));
 assert.notDeepEqual(officialHomeMount('alice','group:shared'),officialHomeMount('alice','group:other'));
 assert.deepEqual(officialHomeMount('alice'),officialHomeMount('alice','user:alice'));
 assert.deepEqual(officialHomeMount(null,'group:shared'),[]);
 assert.match(officialHomeMount('alice','../../oops')[0],/^ava-official-[a-f0-9]{64}:\/home\/user\/\.ava-official$/);
});
