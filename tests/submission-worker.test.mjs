import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
const origin = 'https://freeegg.iffy.site';
const env = { GITHUB_TOKEN: 'private-github-token', TURNSTILE_SECRET: 'private-turnstile-secret', TURNSTILE_SITE_KEY: 'public-site-key', SUBMISSION_RATE_LIMITER: { limit: async () => ({ success: true }) }, ASSETS: { fetch: () => new Response('asset') } };
const valid = { provider: 'Example AI', claim_url: 'https://example.com/free', category: '官方模型厂商 / 推理平台', details: 'Official API credits for individual users.', turnstile_token: 'challenge-token' };
const issue = { number: 42, html_url: 'https://github.com/if-u-can/free-ai-credits/issues/42' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const request = (form = valid, headers = {}) => new Request(origin + '/api/submissions', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.42', ...headers }, body: JSON.stringify(form) });

async function run(req, handler = () => json(issue), bindings = env) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    if (String(url).includes('turnstile')) return json({ success: true, hostname: 'freeegg.iffy.site', action: 'submission' });
    return handler(String(url), options);
  };
  try { const response = await worker.fetch(req, bindings); return { response, data: await response.json(), calls }; }
  finally { globalThis.fetch = original; }
}

test('rejects a chunked multibyte body larger than 8192 bytes before verification', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...valid, details: '蛋'.repeat(3000) }));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const req = new Request(origin + '/api/submissions', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  const result = await run(req);
  assert.equal(result.response.status, 413);
  assert.equal(result.calls.length, 0);
});

test('rejects JSON lookalike media type before creating an issue', async () => {
  const result = await run(request(valid, { 'content-type': 'application/json-invalid' }));
  assert.equal(result.response.status, 415);
  assert.equal(result.calls.length, 0);
});

test('a valid token for a different action cannot create an issue', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return json({ success: true, hostname: 'freeegg.iffy.site', action: 'login' }); };
  try { assert.equal((await worker.fetch(request(), env)).status, 403); assert.equal(calls.length, 1); }
  finally { globalThis.fetch = original; }
});

test('malformed GitHub JSON returns a safe service error', async () => {
  const result = await run(request(), () => new Response('upstream-private-error', { status: 201 }));
  assert.equal(result.response.status, 502);
  assert.equal(JSON.stringify(result.data).includes('upstream-private-error'), false);
});

test('a GitHub URL with a forged issue suffix is rejected', async () => {
  const result = await run(request(), (url, options) => options.method === 'POST' ? json({ ...issue, html_url: issue.html_url + '/evil' }, 201) : json([]));
  assert.equal(result.response.status, 502);
});

test('sequential retries reuse the existing issue for a URL with a changed fragment', async () => {
  let stored = null, writes = 0;
  const backend = (url, options) => {
    if (options.method === 'POST') { writes++; stored = { ...issue, ...JSON.parse(options.body) }; return json(stored, 201); }
    return json(stored ? [stored] : []);
  };
  const first = await run(request(), backend);
  const retry = await run(request({ ...valid, claim_url: valid.claim_url + '#signup' }), backend);
  assert.equal(first.response.status, 201);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.issue_url, issue.html_url);
  assert.equal(writes, 1);
  assert.match(stored.body, /^<!-- freeegg-website-submission -->\n<!-- freeegg-submission-id: [a-f0-9]{64} -->/);
});

test('duplicate detection reads later issue pages and excludes pull requests', async () => {
  let writes = 0;
  const legacy = { ...issue, body: '<!-- freeegg-website-submission -->\n## 官方链接\nhttps://example.com/free\n\n## 类型\n其他（待评估）' };
  const result = await run(request(), (url, options) => {
    if (options.method === 'POST') { writes++; return json(issue, 201); }
    if (url.includes('page=2')) return json([legacy]);
    return json([{ ...legacy, pull_request: {} }], 200, { link: '<https://api.github.com/repos/if-u-can/free-ai-credits/issues?state=all&per_page=100&page=2>; rel="next"' });
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.duplicate, true);
  assert.equal(writes, 0);
});

test('failed duplicate read prevents blind issue writes and hides secrets', async () => {
  let writes = 0;
  const result = await run(request(), (url, options) => { if (options.method === 'POST') writes++; return json({ message: env.GITHUB_TOKEN }, 403); });
  assert.equal(result.response.status, 503);
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
});

test('an unresponsive challenge server is aborted and cannot create an issue', async () => {
  const originalFetch = globalThis.fetch, originalTimer = globalThis.setTimeout;
  let aborted = false;
  globalThis.setTimeout = callback => originalTimer(callback, 1);
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    assert.ok(String(url).includes('turnstile'));
    options.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  try { assert.equal((await worker.fetch(request(), env)).status, 403); assert.equal(aborted, true); }
  finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimer; }
});

test('a committed Issue with a lost response is recovered by retry without another create', async () => {
  const originalTimer = globalThis.setTimeout;
  let stored = null, writes = 0;
  const backend = (url, options) => {
    if (options.method !== 'POST') return json(stored ? [stored] : []);
    writes++;
    stored = { ...issue, ...JSON.parse(options.body) };
    return { status: 201, ok: true, headers: new Headers(), json: () => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) };
  };
  globalThis.setTimeout = callback => originalTimer(callback, 1);
  try {
    const result = await run(request(), backend);
    assert.equal(result.response.status, 502);
    assert.equal(result.data.ok, undefined);
    const retry = await run(request(), backend);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.data.duplicate, true);
    assert.equal(retry.data.issue_url, issue.html_url);
    assert.equal(writes, 1);
  } finally { globalThis.setTimeout = originalTimer; }
});

test('cross-origin, invalid URLs and incomplete challenge configuration do not write', async () => {
  assert.equal((await run(request(valid, { origin: 'https://attacker.example' }))).response.status, 403);
  assert.equal((await run(request({ ...valid, claim_url: 'https://user:password@example.com' }))).response.status, 400);
  const response = await worker.fetch(request(), { ...env, GITHUB_TOKEN: '' });
  assert.equal(response.status, 503);
  const config = await worker.fetch(new Request(origin + '/api/submissions/config'), { ...env, GITHUB_TOKEN: '' });
  assert.deepEqual(await config.json(), { enabled: false, siteKey: null });
});

test('missing rate limiter leaves config disabled and refuses public submissions', async () => {
  const bindings = { ...env, SUBMISSION_RATE_LIMITER: undefined };
  const result = await run(request(), undefined, bindings);
  assert.equal(result.response.status, 503);
  const config = await worker.fetch(new Request(origin + '/api/submissions/config'), bindings);
  assert.deepEqual(await config.json(), { enabled: false, siteKey: null });
});

test('rate-limited client receives Retry-After before external requests', async () => {
  const keys = [];
  const result = await run(request(valid, { 'CF-Connecting-IP': '203.0.113.42', 'X-Forwarded-For': '198.51.100.1' }), undefined, { ...env, SUBMISSION_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } });
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get('retry-after'), '60');
  assert.deepEqual(keys, ['203.0.113.42']);
  assert.equal(result.calls.length, 0);
});

test('limiter service failure and missing trusted IP stop upstream requests', async () => {
  const failed = await run(request(valid, { 'CF-Connecting-IP': '203.0.113.42' }), undefined, { ...env, SUBMISSION_RATE_LIMITER: { limit: async () => { throw new Error(env.GITHUB_TOKEN); } } });
  assert.equal(failed.response.status, 503);
  assert.equal(JSON.stringify(failed.data).includes(env.GITHUB_TOKEN), false);
  assert.equal(failed.calls.length, 0);
  const req = request(); req.headers.delete('CF-Connecting-IP');
  const noIp = await run(req, (url, options) => options.method === 'POST' ? json(issue, 201) : json([]));
  assert.equal(noIp.response.status, 403);
  assert.equal(noIp.calls.length, 0);
});

test('no Issue POST starts after the overall upstream time budget expires', async () => {
  const originalNow = Date.now;
  let now = originalNow(), writes = 0;
  Date.now = () => now;
  try {
    const result = await run(request(), (url, options) => {
      if (options.method === 'POST') { writes++; return json(issue, 201); }
      now += 21000;
      return json([]);
    });
    assert.equal(result.response.status, 502);
    assert.equal(writes, 0);
  } finally { Date.now = originalNow; }
});

test('concurrent same-isolate submissions share one Issue create and recover after it settles', async () => {
  const originalFetch = globalThis.fetch;
  let writes = 0, stored = null;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('turnstile')) return json({ success: true, hostname: 'freeegg.iffy.site', action: 'submission' });
    if (options.method !== 'POST') return json(stored ? [stored] : []);
    writes++;
    await new Promise(resolve => setTimeout(resolve, 5));
    stored = { ...issue, ...JSON.parse(options.body) };
    return json(stored, 201);
  };
  try {
    const responses = await Promise.all([worker.fetch(request(), env), worker.fetch(request(), env)]);
    const receipts = await Promise.all(responses.map(response => response.json()));
    assert.equal(writes, 1);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
    assert.equal(receipts.filter(receipt => receipt.duplicate).length, 1);
    const later = await worker.fetch(request(), env);
    assert.equal(later.status, 200);
    assert.equal((await later.json()).duplicate, true);
    assert.equal(writes, 1);
  } finally { globalThis.fetch = originalFetch; }
});

const feedRequest = (query = '', method = 'GET') => new Request(origin + '/api/submissions/review-feed' + query, { method, headers: { 'CF-Connecting-IP': '203.0.113.42' } });
const feedIssue = { ...issue, title: '[投稿] Example AI', created_at: '2026-10-09T02:00:00Z', updated_at: '2026-10-09T03:00:00Z', state: 'open', body: '<!-- freeegg-website-submission -->\n## 官方链接\nhttps://example.com/free\n' };

test('review feed uses public GitHub read with only rate binding and whitelists Issue fields', async () => {
  const bindings = { SUBMISSION_RATE_LIMITER: env.SUBMISSION_RATE_LIMITER };
  const result = await run(feedRequest('?page=2&since=2026-10-09T00%3A00%3A00.000Z'), () => json([
    { ...feedIssue, user: { email: 'not-in-feed@example.com' }, internal_note: 'omit-extra-field' },
    { ...feedIssue, number: 43, html_url: 'https://github.com/if-u-can/free-ai-credits/issues/43', pull_request: {} },
    { ...feedIssue, number: 44, html_url: 'https://github.com/if-u-can/free-ai-credits/issues/44', body: 'Other public issue' }
  ], 200, { link: '<https://api.github.com/repos/if-u-can/free-ai-credits/issues?page=3>; rel="next"' }), bindings);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, { issues: [feedIssue], has_more: true, source_latest_updated_at: '2026-10-09T03:00:00Z' });
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.calls.length, 1);
  const call = result.calls[0], url = new URL(call.url);
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.authorization, undefined);
  assert.equal(url.origin + url.pathname, 'https://api.github.com/repos/if-u-can/free-ai-credits/issues');
  assert.equal(url.searchParams.get('state'), 'all');
  assert.equal(url.searchParams.get('sort'), 'updated');
  assert.equal(url.searchParams.get('direction'), 'asc');
  assert.equal(url.searchParams.get('per_page'), '100');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('since'), '2026-10-09T00:00:00.000Z');
});

test('review feed retains pagination even when the current page contains no submissions', async () => {
  const result = await run(feedRequest(), () => json([{ ...feedIssue, body: 'Other public issue' }], 200, { link: '<https://api.github.com/repos/if-u-can/free-ai-credits/issues?page=2>; rel="next"' }));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, { issues: [], has_more: true, source_latest_updated_at: '2026-10-09T03:00:00Z' });
});

test('review feed uses configured token once and never falls back after rejection', async () => {
  const result = await run(feedRequest(), () => json({ message: env.GITHUB_TOKEN }, 401));
  assert.equal(result.response.status, 502);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].headers.authorization, 'Bearer ' + env.GITHUB_TOKEN);
  assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
  assert.equal(result.data.code, 'UPSTREAM_HTTP');
  assert.equal(result.data.upstream_status, 401);
});

test('review feed bounds query parameters and cannot fetch caller-supplied URLs', async () => {
  for (const query of ['?page=0', '?page=6', '?page=1.5', '?page=1&page=2', '?since=invalid', '?since=2026-02-30T00%3A00%3A00Z', '?url=https://attacker.example', '?page=']) {
    const result = await run(feedRequest(query));
    assert.equal(result.response.status, 400, query);
    assert.equal(result.calls.length, 0, query);
  }
  const result = await run(feedRequest('', 'POST'));
  assert.equal(result.response.status, 405);
  assert.equal(result.calls.length, 0);
});

test('review feed requires trusted IP and a working rate binding', async () => {
  const missing = await run(feedRequest(), undefined, {});
  assert.equal(missing.response.status, 503);
  assert.equal(missing.calls.length, 0);
  const req = feedRequest(); req.headers.delete('CF-Connecting-IP');
  const noIp = await run(req);
  assert.equal(noIp.response.status, 403);
  assert.equal(noIp.calls.length, 0);
  const keys = [];
  const limited = await run(feedRequest(), undefined, { SUBMISSION_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('retry-after'), '60');
  assert.deepEqual(keys, ['review-feed:203.0.113.42']);
  assert.equal(limited.calls.length, 0);
  const broken = await run(feedRequest(), undefined, { SUBMISSION_RATE_LIMITER: { limit: async () => { throw Error('private-service-error'); } } });
  assert.equal(broken.response.status, 503);
  assert.equal(JSON.stringify(broken.data).includes('private-service-error'), false);
  assert.equal(broken.calls.length, 0);
});

test('review feed rejects malformed upstream data and spoofed Issue URLs without leaking it', async () => {
  for (const data of [{ message: env.GITHUB_TOKEN }, [{ ...feedIssue, html_url: 'https://attacker.example/42' }]]) {
    const result = await run(feedRequest(), () => json(data));
    assert.equal(result.response.status, 502);
    assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
    assert.equal(JSON.stringify(result.data).includes('attacker.example'), false);
  }
  const limited = await run(feedRequest(), () => json({ message: env.GITHUB_TOKEN }, 403));
  assert.equal(limited.response.status, 503);
  assert.equal(JSON.stringify(limited.data).includes(env.GITHUB_TOKEN), false);
  assert.equal(limited.data.code, 'UPSTREAM_HTTP');
  assert.equal(limited.data.upstream_status, 403);
});

test('review feed exposes newer raw source movements even when manual Issues and PRs are filtered out', async () => {
  const result = await run(feedRequest(), () => json([
    feedIssue,
    { ...feedIssue, updated_at: '2026-10-09T04:00:00Z', body: 'Manual public Issue updated during pagination' },
    { ...feedIssue, updated_at: '2026-10-09T05:00:00Z', pull_request: {} }
  ]));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.issues, [feedIssue]);
  assert.equal(result.data.source_latest_updated_at, '2026-10-09T05:00:00Z');
  const empty = await run(feedRequest(), () => json([]));
  assert.equal(empty.data.source_latest_updated_at, null);
});

test('review feed refuses invalid timestamps on unmarked source rows instead of hiding missing movement evidence', async () => {
  const result = await run(feedRequest(), () => json([{ ...feedIssue, updated_at: '2026-02-30T00:00:00Z', body: 'Manual public Issue' }]));
  assert.equal(result.response.status, 502);
  assert.equal(result.data.source_latest_updated_at, undefined);
  assert.equal(result.data.code, 'INVALID_SOURCE_TIMESTAMP');
});

test('review feed diagnostics identify invalid arrays and submission metadata without echoing payloads', async () => {
  for (const [data, code] of [[{ message: env.GITHUB_TOKEN }, 'INVALID_SOURCE_ARRAY'], [[{ ...feedIssue, html_url: 'https://attacker.example/private-note' }], 'INVALID_SUBMISSION_METADATA']]) {
    const result = await run(feedRequest(), () => json(data));
    assert.equal(result.response.status, 502);
    assert.equal(result.data.code, code);
    assert.equal(result.data.upstream_status, undefined);
    assert.deepEqual(Object.keys(result.data).sort(), ['code', 'message']);
    assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
    assert.equal(JSON.stringify(result.data).includes('private-note'), false);
  }
});

test('review feed distinguishes JSON and request exceptions using fixed safe codes', async () => {
  const malformed = await run(feedRequest(), () => new Response('private upstream text ' + env.GITHUB_TOKEN));
  assert.equal(malformed.response.status, 502);
  assert.equal(malformed.data.code, 'UPSTREAM_JSON');
  const failed = await run(feedRequest(), () => { throw new TypeError('private request error ' + env.GITHUB_TOKEN); });
  assert.equal(failed.response.status, 502);
  assert.equal(failed.data.code, 'UPSTREAM_REQUEST');
  for (const result of [malformed, failed]) {
    assert.deepEqual(Object.keys(result.data).sort(), ['code', 'message']);
    assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
    assert.equal(JSON.stringify(result.data).includes('private'), false);
  }
});

test('review feed reports an aborted upstream request as timeout without raw exception content', async () => {
  const originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = callback => originalTimer(callback, 1);
  try {
    const result = await run(feedRequest(), (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('private timeout ' + env.GITHUB_TOKEN, 'AbortError')), { once: true })));
    assert.equal(result.response.status, 502);
    assert.equal(result.data.code, 'UPSTREAM_TIMEOUT');
    assert.deepEqual(Object.keys(result.data).sort(), ['code', 'message']);
    assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
    assert.equal(JSON.stringify(result.data).includes('private'), false);
  } finally { globalThis.setTimeout = originalTimer; }
});

test('upstream requests use Cloudflare-compatible manual redirects', async () => {
  const result = await run(feedRequest(), (url, options) => {
    if (options.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of follow or manual');
    return json([]);
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.calls[0].redirect, 'manual');
});

test('review feed rejects an upstream redirect and never sends authorization to its destination', async () => {
  const result = await run(feedRequest(), () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/capture' } }));
  assert.equal(result.response.status, 502);
  assert.equal(result.data.code, 'UPSTREAM_HTTP');
  assert.equal(result.data.upstream_status, 302);
  assert.equal(result.calls.length, 1);
  assert.equal(new URL(result.calls[0].url).hostname, 'api.github.com');
  assert.equal(result.calls[0].headers.authorization, 'Bearer ' + env.GITHUB_TOKEN);
  assert.equal(result.calls[0].redirect, 'manual');
  assert.equal(JSON.stringify(result.data).includes('attacker.example'), false);
  assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
});

test('Turnstile redirects are rejected before any Issue request', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), ...options }); return new Response(null, { status: 302, headers: { location: 'https://attacker.example/challenge' } }); };
  try {
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 403);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).hostname, 'challenges.cloudflare.com');
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(JSON.stringify(await response.json()).includes(env.TURNSTILE_SECRET), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Issue creation redirects are rejected without forwarding the GitHub credential', async () => {
  const result = await run(request(), (url, options) => options.method === 'POST' ? new Response(null, { status: 307, headers: { location: 'https://attacker.example/create' } }) : json([]));
  assert.equal(result.response.status, 502);
  assert.equal(result.calls.length, 3);
  assert.ok(result.calls.every(call => call.redirect === 'manual'));
  assert.ok(result.calls.every(call => !call.url.includes('attacker.example')));
  assert.equal(result.data.code, undefined);
  assert.equal(JSON.stringify(result.data).includes(env.GITHUB_TOKEN), false);
});
