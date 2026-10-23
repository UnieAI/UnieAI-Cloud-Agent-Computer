import {createHash} from 'node:crypto';
/** Vendor credentials/history never enter the shared project volume. The same
 * user's same workspace reconnects to its private volume after container reap. */
export function officialHomeMount(userId, owner) {
  if(typeof userId!=='string'||!userId)return [];
  const scope=createHash('sha256').update(JSON.stringify([userId,owner||`user:${userId}`])).digest('hex');
  return [`ava-official-${scope}:/home/user/.ava-official`];
}
