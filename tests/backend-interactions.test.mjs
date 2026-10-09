import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';

const catalogue = JSON.parse(readFileSync(new URL('../data/eggs.json', import.meta.url))).eggs;
const eggId = catalogue[0].id;
const origin = 'https://freeegg.iffy.site';
const googleURL = 'https://script.google.com/macros/s/test_deployment/exec';
const googleSecret = 'test-only-google-signing-key-at-least-32-bytes';
const identitySecret = 'test-only-anonymous-secret-at-least-32-bytes';
const environment = () => ({ INTERACTIONS_GOOGLE_URL: googleURL, INTERACTIONS_GOOGLE_SECRET: googleSecret,
  INTERACTIONS_ID_SECRET: identitySecret, ASSETS: { fetch: () => new Response('static') } });
const state = extra => ({ good: 1, bad: 0, myVote: 'good', reviewPending: false,
  reviewRequestedAt: null, lastVerified: catalogue[0].verified_at ?? null, ...extra });
async function call(env, path, { method = 'GET', ip = '203.0.113.1', body, headers = {} } = {}) {
  const response = await worker.fetch(new Request(origin + path, { method, headers: {
    'CF-Connecting-IP': ip, ...(method === 'POST' ? { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } : {}), ...headers
  }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), env);
  return { response, data: await response.json() };
}
const vote = (env, choice = 'good', ip = '203.0.113.1', headers = {}) => call(env, '/api/interactions/vote', { method: 'POST', ip, body: { eggId, vote: choice }, headers });
const get = env => call(env, '/api/interactions?ids=' + eggId);
async function withGoogle(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = original; }
}
function signedPayload(url, init) {
  assert.equal(String(url), googleURL); assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  const envelope = JSON.parse(init.body);
  assert.equal(envelope.signature, createHmac('sha256', googleSecret).update(envelope.payload, 'utf8').digest('base64'));
  const payload = JSON.parse(envelope.payload);
  assert.equal(payload.version, 1); assert.ok(Math.abs(payload.timestamp - Date.now()) < 2000);
  assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
  assert.ok(!envelope.payload.includes('203.0.113.1'));
  assert.ok(!envelope.payload.includes(googleSecret)); assert.ok(!envelope.payload.includes(identitySecret));
  return payload;
}

test('only a healthy signed Google response enables interactions; missing configuration never returns fake counts', async () => {
  let requests = 0;
  await withGoogle(async (url, init) => { requests++; assert.equal(signedPayload(url, init).action, 'health'); return Response.json({ available: true }); }, async () => {
    assert.equal((await call(environment(), '/api/interactions/config')).data.available, true);
    for (const missing of ['INTERACTIONS_GOOGLE_URL', 'INTERACTIONS_GOOGLE_SECRET', 'INTERACTIONS_ID_SECRET']) {
      const env = environment(); delete env[missing];
      assert.equal((await call(env, '/api/interactions/config')).data.available, false);
      const result = await get(env);
      assert.equal(result.response.status, 503); assert.equal(result.data.available, false); assert.equal(result.data.eggs, undefined);
    }
    assert.equal(requests, 1);
  });
});

test('stats transport signs exact IDs, catalogue dates and an anonymous server HMAC identity', async () => {
  await withGoogle(async (url, init) => {
    const payload = signedPayload(url, init);
    assert.equal(payload.action, 'stats'); assert.deepEqual(payload.ids, [eggId]);
    assert.deepEqual(payload.dates, { [eggId]: catalogue[0].verified_at ?? null });
    assert.equal(payload.voterHash, createHmac('sha256', identitySecret).update('egg-voter-v1:203.0.113.1').digest('hex'));
    return Response.json({ available: true, eggs: { [eggId]: state() }, privateMetadata: 'not-for-browser' });
  }, async () => {
    const result = await get(environment());
    assert.equal(result.response.status, 200); assert.deepEqual(result.data, { available: true, eggs: { [eggId]: state() } });
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
  });
});

test('votes are acknowledged only after Google confirms the requested persisted vote', async () => {
  await withGoogle(async (url, init) => {
    const payload = signedPayload(url, init);
    assert.equal(payload.action, 'vote'); assert.equal(payload.eggId, eggId); assert.equal(payload.vote, 'bad');
    return Response.json({ available: true, egg: { id: eggId, ...state({ good: 0, bad: 1, myVote: 'bad' }) } });
  }, async () => {
    const result = await vote(environment(), 'bad');
    assert.equal(result.response.status, 200); assert.deepEqual([result.data.egg.good, result.data.egg.bad, result.data.egg.myVote], [0, 1, 'bad']);
    assert.equal(catalogue[0].status, 'expired');
  });
});

test('client cookies, UUIDs and forwarded headers cannot change the trusted voter identity', async () => {
  const seen = [];
  await withGoogle(async (url, init) => {
    seen.push(signedPayload(url, init).voterHash);
    return Response.json({ available: true, egg: { id: eggId, ...state() } });
  }, async () => {
    await vote(environment(), 'good', '203.0.113.1', { cookie: 'visitor=one', 'x-forwarded-for': '198.51.100.1' });
    await vote(environment(), 'good', '203.0.113.1', { cookie: 'visitor=two', 'x-forwarded-for': '198.51.100.2' });
    assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
    const result = await vote(environment(), 'good', '', { 'x-forwarded-for': '198.51.100.1' });
    assert.equal(result.response.status, 503); assert.equal(result.data.code, 'identity_unavailable'); assert.equal(seen.length, 2);
  });
});

test('Google HTML, authentication redirects, outages, timeout and malformed responses fail closed', async () => {
  const failures = [
    () => new Response('<html>Google sign-in</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('', { status: 302, headers: { location: 'https://accounts.google.com' } }),
    () => new Response('private upstream error', { status: 500 }),
    () => { throw new DOMException('private timeout', 'TimeoutError'); },
    () => Response.json({ available: true, eggs: {} }),
    () => Response.json({ available: true, eggs: { [eggId]: state({ good: -1 }) } }),
    () => Response.json({ available: true, eggs: { [eggId]: state({ reviewPending: 'false' }) } }),
    () => Response.json({ available: true, eggs: { [eggId]: state({ lastVerified: '<script>' }) } })
  ];
  for (const failure of failures) await withGoogle(async () => failure(), async () => {
    const result = await get(environment());
    assert.equal(result.response.status, 503); assert.equal(result.data.code, 'unavailable'); assert.equal(result.data.eggs, undefined);
    assert.ok(!JSON.stringify(result.data).includes('private'));
  });
});

test('wrong vote or wrong egg acknowledgements are rejected instead of showing success', async () => {
  for (const egg of [{ id: eggId, ...state({ myVote: 'bad' }) }, { id: 'fake', ...state() }]) {
    await withGoogle(async () => Response.json({ available: true, egg }), async () => {
      assert.equal((await vote(environment(), 'good')).response.status, 503);
    });
  }
});

test('persistent Google rate limits and script-lock busy responses retain safe retry semantics', async () => {
  for (const [failure, status, code, retry] of [
    [{ available: false, code: 'rate_limited', status: 429, retryAfter: 25, message: 'private sheet info' }, 429, 'rate_limited', '25'],
    [{ available: false, code: 'busy', status: 503, retryAfter: 5 }, 503, 'busy', '5'],
    [{ available: false, code: 'signature_invalid', status: 403, message: 'private auth info' }, 503, 'unavailable', null]
  ]) {
    await withGoogle(async () => Response.json(failure), async () => {
      const result = await vote(environment());
      assert.equal(result.response.status, status); assert.equal(result.data.code, code);
      assert.equal(result.response.headers.get('retry-after'), retry); assert.ok(!JSON.stringify(result.data).includes('private'));
    });
  }
});

test('untrusted upstream URLs and incomplete optional Turnstile configuration are unavailable', async () => {
  await withGoogle(async () => { throw Error('must not contact an untrusted endpoint'); }, async () => {
    for (const url of ['http://script.google.com/macros/s/id/exec', 'https://evil.example/macros/s/id/exec', 'https://script.google.com.evil.example/macros/s/id/exec', 'https://name:secret@script.google.com/macros/s/id/exec', 'https://script.google.com/macros/s/id/exec?secret=value']) {
      const env = { ...environment(), INTERACTIONS_GOOGLE_URL: url };
      assert.equal((await call(env, '/api/interactions/config')).data.available, false);
      assert.equal((await get(env)).response.status, 503);
    }
    const env = { ...environment(), INTERACTIONS_TURNSTILE_SITE_KEY: 'site' };
    assert.equal((await call(env, '/api/interactions/config')).data.available, false);
  });
});

test('bad inputs, origins and oversized UTF-8 bodies are rejected before contacting Google', async () => {
  let contacted = 0;
  await withGoogle(async () => { contacted++; throw Error('must not forward invalid requests'); }, async () => {
    const cases = [
      [{ body: { eggId: 'fake', vote: 'good' } }, 400], [{ body: { eggId, vote: 'up' } }, 400], [{ body: [] }, 400], [{ body: '{' }, 400],
      [{ body: { eggId, vote: 'good' }, headers: { origin: 'https://evil.example' } }, 403],
      [{ body: { eggId, vote: 'good' }, headers: { 'sec-fetch-site': 'cross-site' } }, 403],
      [{ body: '{}', headers: { 'content-type': 'application/json-invalid' } }, 415],
      [{ body: 'x'.repeat(5000) }, 413], [{ body: { eggId, vote: 'good', padding: '蛋'.repeat(1400) } }, 413]
    ];
    for (const [options, status] of cases) {
      const result = await call(environment(), '/api/interactions/vote', { method: 'POST', ...options });
      assert.equal(result.response.status, status); assert.ok(result.data.code);
    }
    assert.equal((await call(environment(), '/api/interactions?ids=' + Array(61).fill(eggId).join(','))).response.status, 400);
    assert.equal((await call(environment(), '/api/interactions')).response.status, 400);
    assert.equal((await call(environment(), '/api/interactions/vote')).response.status, 405);
    assert.equal(contacted, 0);
  });
});

test('optional Turnstile rejects wrong hostname or action before Google vote transport', async () => {
  const env = { ...environment(), INTERACTIONS_TURNSTILE_SITE_KEY: 'site', INTERACTIONS_TURNSTILE_SECRET: 'test-only-secret' };
  let googleWrites = 0;
  for (const validation of [{ success: true, hostname: 'evil.example', action: 'egg-vote' }, { success: true, hostname: 'freeegg.iffy.site', action: 'submission' }, { success: true, hostname: 'freeegg.iffy.site', action: 'egg-vote' }]) {
    await withGoogle(async (url, init) => {
      if (String(url).includes('challenges.cloudflare.com')) return Response.json(validation);
      googleWrites++; signedPayload(url, init); return Response.json({ available: true, egg: { id: eggId, ...state() } });
    }, async () => {
      const result = await call(env, '/api/interactions/vote', { method: 'POST', body: { eggId, vote: 'good', turnstileToken: 'token' } });
      assert.equal(result.response.status, validation.hostname === 'freeegg.iffy.site' && validation.action === 'egg-vote' ? 200 : 403);
    });
  }
  assert.equal(googleWrites, 1);
});

test('existing submission API and static assets remain independent of Google setup', async () => {
  const env = environment();
  assert.equal((await call(env, '/api/submissions/config')).data.enabled, false);
  const response = await worker.fetch(new Request(origin + '/index.html'), env);
  assert.equal(await response.text(), 'static');
});

test('health failures disable config and never expose upstream secrets or site keys', async () => {
  const env = { ...environment(), INTERACTIONS_TURNSTILE_SITE_KEY: 'site', INTERACTIONS_TURNSTILE_SECRET: 'test-only-turnstile' };
  for (const result of [{ available: false, code: 'busy', status: 503 }, '<html>private configuration</html>']) {
    await withGoogle(async () => typeof result === 'string' ? new Response(result) : Response.json(result), async () => {
      assert.deepEqual((await call(env, '/api/interactions/config')).data, { available: false });
    });
  }
  await withGoogle(async () => Response.json({ available: true }), async () => {
    assert.deepEqual((await call(env, '/api/interactions/config')).data, { available: true, turnstileSiteKey: 'site' });
  });
});

test('anonymous stats are allowed without trusted IP but still require confirmed Google counts', async () => {
  await withGoogle(async (url, init) => {
    const payload = signedPayload(url, init); assert.equal(payload.voterHash, null);
    return Response.json({ available: true, eggs: { [eggId]: state({ myVote: null }) } });
  }, async () => {
    const result = await call(environment(), '/api/interactions?ids=' + eggId, { ip: '' });
    assert.equal(result.response.status, 200); assert.equal(result.data.eggs[eggId].myVote, null);
  });
});

test('oversized upstream output cannot masquerade as valid storage data', async () => {
  await withGoogle(async () => Response.json({ available: true, eggs: { [eggId]: state() }, padding: 'x'.repeat(65536) }), async () => {
    const result = await get(environment()); assert.equal(result.response.status, 503); assert.equal(result.data.eggs, undefined);
  });
});
