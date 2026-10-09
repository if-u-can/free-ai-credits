import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../submit.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
const config = () => new Response(JSON.stringify({ enabled: true, siteKey: 'public-site-key' }));
const issue = () => new Response(JSON.stringify({ ok: true, issue_url: 'https://github.com/if-u-can/free-ai-credits/issues/42', issue_number: 42 }), { status: 201 });

// Execute the real page script. Only DOM and external network/challenge boundaries are substituted.
function page(fetcher = async url => url.endsWith('/config') ? config() : issue()) {
  function element(id) {
    return { id, textContent: '', style: {}, hidden: true, disabled: id === 'send', children: [], handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      appendChild(child) { this.children.push(child); }, remove() {},
      setAttribute(name, value) { this[name] = value; },
    };
  }
  const nodes = Object.fromEntries(['submission', 'send', 'state', 'captcha', 'result', 'retry'].map(id => [id, element(id)]));
  const fields = { provider: '测试平台', category: '官方模型厂商 / 推理平台', claim_url: 'https://example.com/free', credits: '$5', models: '', requirements: '', details: '这是足够长的官方活动说明。', website: '' };
  let resets = 0, options, challengeResets = 0;
  nodes.submission.reportValidity = () => true;
  nodes.submission.reset = () => { resets++; };
  const document = { querySelector: selector => nodes[selector.slice(1)], createElement: () => element(''), head: element('head') };
  const window = { turnstile: { render(_box, settings) { options = settings; return 'widget'; }, reset() { challengeResets++; } } };
  const requests = [];
  const timers = new Map(); let timerId = 0;
  const context = vm.createContext({ document, window, URL, AbortController, crypto: globalThis.crypto,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    FormData: class { entries() { return Object.entries(fields)[Symbol.iterator](); } },
    fetch: async (url, init) => { requests.push({ url, init }); return fetcher(url, init); },
  });
  vm.runInContext(script, context);
  return { nodes, fields, requests, get resets() { return resets; }, get challengeResets() { return challengeResets; },
    async ready() { await tick(); const loader = document.head.children.at(-1); assert.ok(loader, 'challenge script loaded'); loader.onload(); },
    get options() { return options; },
    verify(value = 'verified-token') { options.callback(value); },
    expire() { options['expired-callback'](); },
    challengeError() { options['error-callback'](); },
    submit() { return nodes.submission.handlers.submit({ preventDefault() {} }); },
    retry() { return nodes.retry.handlers.click(); },
    timeout() { const callback = timers.values().next().value; assert.ok(callback, 'pending work has a timeout'); callback(); },
  };
}

test('submission is enabled only while a challenge token is valid', async () => {
  const p = page(); await p.ready();
  assert.equal(p.nodes.send.disabled, true);
  p.verify(); assert.equal(p.nodes.send.disabled, false);
  p.expire(); assert.equal(p.nodes.send.disabled, true);
  await p.submit(); assert.equal(p.requests.filter(r => r.init?.method === 'POST').length, 0);
});

test('parallel submit events create one request and preserve the busy state', async () => {
  let finish;
  const p = page(async url => url.endsWith('/config') ? config() : new Promise(resolve => { finish = resolve; }));
  await p.ready(); p.verify();
  const first = p.submit(); await tick();
  p.verify('new-token'); assert.equal(p.nodes.send.disabled, true);
  p.submit(); await tick();
  assert.equal(p.requests.filter(r => r.init?.method === 'POST').length, 1);
  finish(issue()); await first;
});

test('non-JSON service errors retain the form and give a usable retry message', async () => {
  const p = page(async url => url.endsWith('/config') ? config() : new Response('<html>Bad gateway</html>', { status: 502 }));
  await p.ready(); p.verify(); await p.submit();
  assert.equal(p.resets, 0); assert.equal(p.nodes.send.disabled, true);
  assert.match(p.nodes.state.textContent, /稍后|重试|确认/);
  assert.doesNotMatch(p.nodes.state.textContent, /JSON|Unexpected|SyntaxError/);
  p.verify('retry-token'); await p.submit();
  assert.equal(p.requests.filter(r => r.init?.method === 'POST').length, 2);
});

test('unverified success payload never clears entered fields or displays a success result', async () => {
  const p = page(async url => url.endsWith('/config') ? config() : new Response(JSON.stringify({ ok: true, issue_url: 'https://github.com/if-u-can/free-ai-credits/issues/fake', issue_number: 42 }), { status: 201 }));
  await p.ready(); p.verify(); await p.submit();
  assert.equal(p.resets, 0); assert.notEqual(p.nodes.result.style.display, 'block');
  assert.match(p.nodes.state.textContent, /确认|重试|失败/);
});

test('config service failure offers a same-page retry without losing fields', async () => {
  let attempts = 0;
  const p = page(async () => ++attempts === 1 ? new Response('', { status: 503 }) : config());
  await tick(); assert.equal(p.nodes.retry.hidden, false);
  await p.retry(); await p.ready(); p.verify();
  assert.equal(p.nodes.send.disabled, false); assert.equal(p.resets, 0);
});

test('challenge errors can restart verification without reloading the form', async () => {
  const p = page(); await p.ready(); p.verify(); p.challengeError();
  assert.equal(p.nodes.send.disabled, true); assert.equal(p.nodes.retry.hidden, false);
  await p.retry(); assert.equal(p.challengeResets, 1); assert.equal(p.resets, 0);
  p.verify(); assert.equal(p.nodes.send.disabled, false);
});

test('confirmed issue success clears the form and leaves submission waiting for new verification', async () => {
  const p = page(); await p.ready(); p.verify(); await p.submit();
  assert.equal(p.resets, 1); assert.equal(p.nodes.result.style.display, 'block');
  assert.equal(p.nodes.result.children[0].href, 'https://github.com/if-u-can/free-ai-credits/issues/42');
  assert.equal(p.nodes.send.disabled, true); assert.equal(p.challengeResets, 1);
});

test('Turnstile requests the submission action expected by the server', async () => {
  const p = page(); await p.ready();
  assert.equal(p.options.action, 'submission');
});

test('duplicate receipts show the existing review issue instead of claiming a new submission', async () => {
  const p = page(async url => url.endsWith('/config') ? config() : new Response(JSON.stringify({ ok: true, duplicate: true, issue_url: 'https://github.com/if-u-can/free-ai-credits/issues/42', issue_number: 42 })));
  await p.ready(); p.verify(); await p.submit();
  assert.match(p.nodes.result.textContent, /已有|已经.*投稿|重复/);
  assert.equal(p.nodes.result.children[0].href, 'https://github.com/if-u-can/free-ai-credits/issues/42');
});

test('a stalled config request can time out and reconnect without reloading', async () => {
  let attempts = 0;
  const p = page(async (_url, init) => ++attempts > 1 ? config() : new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  p.timeout(); await tick();
  assert.equal(p.nodes.retry.hidden, false); assert.equal(p.nodes.send.disabled, true);
  await p.retry(); await p.ready(); p.verify();
  assert.equal(p.nodes.send.disabled, false);
});

test('a stalled challenge script exposes retry and ignores its late load event', async () => {
  const p = page(); await tick(); p.timeout();
  assert.equal(p.nodes.retry.hidden, false);
  await p.ready();
  assert.equal(p.options, undefined); assert.equal(p.nodes.send.disabled, true);
  await p.retry(); await p.ready(); p.verify();
  assert.equal(p.nodes.send.disabled, false);
});

test('a stalled submission preserves fields and permits verification for another attempt', async () => {
  const p = page(async (url, init) => url.endsWith('/config') ? config() : new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  await p.ready(); p.verify(); const pending = p.submit(); p.timeout(); await pending;
  assert.equal(p.resets, 0); assert.equal(p.nodes.send.disabled, true);
  assert.match(p.nodes.state.textContent, /超时|重试/);
  p.verify(); assert.equal(p.nodes.send.disabled, false);
});
