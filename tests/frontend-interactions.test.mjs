import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let interactions;
try { interactions = require('../assets/interactions.js'); } catch {}
const storage = (value = null) => ({ getItem: () => value, setItem: (key, next) => { value = next; } });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const egg = { id: 'one', name: 'One', status: 'active', verified_at: '2026-10-09' };
const confirmed = { good: 3, bad: 1, myVote: 'good', reviewPending: false, reviewRequestedAt: null, lastVerified: '2026-10-09' };

test('eaten state survives a new store and combines with an existing filtered list', () => {
  assert.ok(interactions?.createStore, 'interaction state is implemented');
  const local = storage();
  const a = interactions.createStore({ storage: local });
  a.toggleEaten('one');
  const b = interactions.createStore({ storage: local });
  assert.equal(b.isEaten('one'), true);
  const alreadyGradeFiltered = [egg, { id: 'two', status: 'active' }];
  assert.deepEqual(alreadyGradeFiltered.filter(e => b.matches(e, 'eaten')).map(e => e.id), ['one']);
  assert.deepEqual(alreadyGradeFiltered.filter(e => b.matches(e, 'uneaten')).map(e => e.id), ['two']);
  b.toggleEaten('one');
  assert.equal(interactions.createStore({ storage: local }).isEaten('one'), false);
});
test('damaged or refused storage gives an honest warning while keeping session use', () => {
  assert.ok(interactions?.createStore);
  const damaged = interactions.createStore({ storage: storage('{bad') });
  assert.equal(damaged.isEaten('one'), false);
  assert.match(damaged.storageMessage, /损坏/);
  const refused = interactions.createStore({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
  refused.toggleEaten('one');
  assert.equal(refused.isEaten('one'), true);
  assert.match(refused.storageMessage, /本次|当前/);
});
test('pending vote survives new card rendering and blocks duplicates until server confirmation', async () => {
  assert.ok(interactions?.createStore);
  let resolveVote;
  const store = interactions.createStore({ storage: storage(), fetch: async (url, options) => {
    if (options?.method === 'POST') return new Promise(resolve => { resolveVote = resolve; });
    return response(url.endsWith('/config') ? { available: true } : { available: true, eggs: { one: { ...confirmed, good: 2, myVote: null } } });
  } });
  await store.load([egg]);
  const first = store.vote('one', 'good');
  assert.equal(store.view(egg).good, 2, 'no optimistic count');
  assert.equal(store.view(egg).busy, true);
  assert.equal(await store.vote('one', 'bad'), false);
  assert.match(store.cardHTML(egg), /disabled/);
  resolveVote(response({ available: true, egg: { id: 'one', ...confirmed } }));
  await first;
  assert.equal(store.view(egg).good, 3);
  assert.equal(store.view(egg).busy, false);
  assert.match(store.cardHTML(egg), /aria-pressed="true"/);
});
test('unavailable service shows unknown counts, allows eaten and recovers on retry', async () => {
  assert.ok(interactions?.createStore);
  let online = false;
  const store = interactions.createStore({ storage: storage(), fetch: async url => online
    ? response(url.endsWith('/config') ? { available: true } : { available: true, eggs: { one: confirmed } })
    : response({ available: false, message: 'Unavailable' }, 503) });
  await store.load([egg]);
  assert.equal(store.view(egg).good, null);
  assert.match(store.cardHTML(egg), /—/);
  assert.match(store.serviceMessage, /暂不可用/);
  store.toggleEaten('one');
  assert.equal(store.isEaten('one'), true);
  online = true;
  await store.load([egg]);
  assert.equal(store.view(egg).good, 3);
});
test('vote failure leaves confirmed data unchanged and exposes feedback', async () => {
  assert.ok(interactions?.createStore);
  const store = interactions.createStore({ storage: storage(), fetch: async (url, options) => options?.method === 'POST'
    ? response({ message: '请稍后再试。' }, 429)
    : response(url.endsWith('/config') ? { available: true } : { available: true, eggs: { one: confirmed } }) });
  await store.load([egg]);
  assert.equal(await store.vote('one', 'bad'), false);
  assert.equal(store.view(egg).bad, 1);
  assert.equal(store.view(egg).myVote, 'good');
  assert.match(store.view(egg).message, /稍后/);
});
test('connection lost while voting marks service unavailable instead of presenting stale counts', async () => {
  const store = interactions.createStore({ storage: storage(), fetch: async (url, options) => {
    if (options?.method === 'POST') throw new TypeError('Failed to fetch');
    return response(url.endsWith('/config') ? { available: true } : { available: true, eggs: { one: confirmed } });
  } });
  await store.load([egg]);
  await store.vote('one', 'bad');
  assert.equal(store.available, false);
  assert.equal(store.view(egg).good, null);
  assert.match(store.serviceMessage, /暂不可用/);
});
