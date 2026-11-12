import { dbPut, dbGetAll, dbDelete } from './db.js';

// A queued write: the exact request that couldn't reach a server, kept
// until it can be replayed. `body.id` is always set to a client-generated
// UUID before queuing — see stockMath.js on the backend for why that's
// what makes replaying this safely idempotent (sync it to a LAN peer now,
// the cloud later; either order, no double-count).
export async function enqueueAction({ method, url, storeId, body, isFormData }) {
  const queueId = crypto.randomUUID(); // identifies this queued action to the UI (sync events etc.)
  const bodyWithId = isFormData
    ? body // FormData entries are serialized as a plain object by the caller; id isn't relevant there
    : { ...body, id: body?.id || crypto.randomUUID() };

  const entry = {
    queueId,
    method,
    url,
    storeId,
    body: bodyWithId,
    isFormData: !!isFormData,
    createdAt: Date.now(),
  };
  const seq = await dbPut('outbox', entry); // IndexedDB assigns `seq` since it's the autoIncrement keyPath
  return { ...entry, seq };
}

export async function listQueued(storeId) {
  const all = await dbGetAll('outbox'); // returned in `seq` (insertion) order already
  return storeId ? all.filter((e) => e.storeId === storeId) : all;
}

export async function removeQueued(seq) {
  return dbDelete('outbox', seq);
}

export async function queueSize(storeId) {
  return (await listQueued(storeId)).length;
}
