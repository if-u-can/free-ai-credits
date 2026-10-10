import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fixture from './google-community-fixture.cjs';
import worker from '../src/worker.js';

const eggId = JSON.parse(readFileSync(new URL('../data/eggs.json', import.meta.url))).eggs[0].id;
const origin = 'https://freeegg.iffy.site';
const googleURL = 'https://script.google.com/macros/s/test_deployment/exec';

async function combined(run) {
  const h = fixture.harness();
  h.advance(Date.now() - h.payload('health').timestamp);
  h.install();
  const env = { INTERACTIONS_GOOGLE_URL: googleURL,
    INTERACTIONS_GOOGLE_SECRET: h.database.properties.get('INTERACTIONS_GOOGLE_SECRET'),
    INTERACTIONS_ID_SECRET: 'test-only-independent-edge-identity-key-at-least-32-bytes' };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, googleURL);
    const result = h.context.doPost({ postData: { contents: init.body } });
    return new Response(result.text, { headers: { 'content-type': 'application/json' } });
  };
  async function request(path, choice, ip = '203.0.113.1', configuration = env) {
    const response = await worker.fetch(new Request(origin + path, {
      method: choice ? 'POST' : 'GET', headers: {
        'CF-Connecting-IP': ip, ...(choice ? { origin, 'content-type': 'application/json' } : {})
      }, ...(choice ? { body: JSON.stringify({ eggId, vote: choice }) } : {})
    }), configuration);
    return { status: response.status, retryAfter: response.headers.get('retry-after'), data: await response.json() };
  }
  try { await run({ h, env, request }); } finally { globalThis.fetch = original; }
}

test('Cloudflare signed transport and real Apps Script source persist a unique changing ballot and review baseline together', async () => {
  await combined(async ({ h, request }) => {
    assert.equal((await request('/api/interactions/config')).data.available, true);
    const read = () => request('/api/interactions?ids=' + eggId);
    assert.equal((await read()).data.eggs[eggId].good, 0);
    const cast = (choice, ip) => request('/api/interactions/vote', choice, ip);
    assert.equal((await cast('good')).data.egg.good, 1);
    assert.equal((await cast('good')).data.egg.good, 1);
    assert.equal((await cast('bad')).data.egg.good, 0);
    await cast('bad', '203.0.113.2'); await cast('bad', '203.0.113.3');
    let result = (await read()).data.eggs[eggId];
    assert.equal(result.bad, 3); assert.equal(result.myVote, 'bad'); assert.equal(result.reviewPending, true);
    h.context.resolveCommunityReview({ resolutionId: 'test-combined-review', eggId, expectedGeneration: 0,
      outcome: 'confirmed', evidenceUrl: 'https://official.example/offer',
      notes: 'Test fixture: official terms and current grading rules checked.', verifiedAt: '2026-10-09' });
    await cast('bad');
    result = (await read()).data.eggs[eggId];
    assert.equal(result.reviewPending, false); assert.equal(result.lastVerified, '2026-10-09');
    assert.equal(h.database.sheets.get('社区投票').getLastRow(), 4);
  });
});

test('real Google authentication and shared lock failures reach the Cloudflare fail-closed API', async () => {
  await combined(async ({ h, env, request }) => {
    const mismatch = { ...env, INTERACTIONS_GOOGLE_SECRET: 'test-only-wrong-google-key-at-least-32-bytes' };
    assert.equal((await request('/api/interactions/config', null, '203.0.113.1', mismatch)).data.available, false);
    assert.equal((await request('/api/interactions/vote', 'good', '203.0.113.1', mismatch)).status, 503);
    assert.equal(h.database.sheets.get('社区投票').getLastRow(), 1);
    h.setBusy(true);
    const busy = await request('/api/interactions/vote', 'good');
    assert.equal(busy.status, 503); assert.equal(busy.data.code, 'busy'); assert.equal(busy.retryAfter, '2');
    h.setBusy(false);
    assert.equal((await request('/api/interactions/vote', 'good')).data.egg.good, 1);
  });
});
