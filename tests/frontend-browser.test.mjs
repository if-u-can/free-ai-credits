import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch {}

test('real page combines filters, retains votes across rendering, persists eaten and fits narrow screens', { skip: !playwright }, async () => {
  const root = path.resolve(import.meta.dirname, '..');
  let online = true, finishVote, voteCount = 0, captcha = false, lastVote;
  const records = {};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/interactions')) {
      res.setHeader('content-type', 'application/json');
      if (!online) { res.statusCode = 503; return res.end(JSON.stringify({ available: false })); }
      if (url.pathname.endsWith('/config')) return res.end(JSON.stringify({ available: true, ...(captcha ? { turnstileSiteKey: 'test-sitekey' } : {}) }));
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); voteCount++; lastVote = body;
        finishVote = () => { records[body.eggId] = { ...records[body.eggId], good: 4, myVote: body.vote, reviewPending: true }; res.end(JSON.stringify({ available: true, egg: { id: body.eggId, ...records[body.eggId] } })); };
        return;
      }
      const eggs = {};
      for (const id of url.searchParams.get('ids').split(',')) eggs[id] = records[id] ||= { good: 3, bad: 1, myVote: null, reviewPending: false, reviewRequestedAt: null, lastVerified: '2026-10-09' };
      return res.end(JSON.stringify({ available: true, eggs }));
    }
    try {
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const content = await readFile(path.join(root, filename));
      const ext = path.extname(filename);
      res.setHeader('content-type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.webp': 'image/webp' })[ext] || 'application/octet-stream');
      res.end(content);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => document.querySelector('.vote-good:not(:disabled)'));
    const first = page.locator('.egg-interaction').first();
    const id = await first.getAttribute('data-egg-id');
    await first.locator('[data-egg-action=eaten]').click();
    await page.locator('[data-eaten-filter=eaten]').click();
    assert.equal(await page.locator('.eggcard').count(), 1);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.vote-good:not(:disabled)'));
    await page.locator('[data-eaten-filter=eaten]').click();
    assert.equal(await page.locator('.eggcard').count(), 1, 'saved stable ID survives reload');
    const card = page.locator('.egg-interaction[data-egg-id="' + id + '"]');
    await card.locator('.vote-good').click();
    await page.waitForFunction(() => document.querySelector('.egg-action-message').textContent.includes('正在提交'));
    await page.locator('[data-filter=premium]').click();
    await page.locator('[data-filter=all]').click();
    assert.equal(await card.locator('.vote-good').isDisabled(), true);
    finishVote();
    await page.waitForFunction(() => document.querySelector('.vote-good .vote-count').textContent === '4');
    assert.equal(await card.locator('.vote-good').getAttribute('aria-pressed'), 'true');
    assert.equal(voteCount, 1);
    assert.match(await page.locator('#review-count').textContent(), /1/);
    await page.locator('#search').fill('no-such-platform');
    assert.equal(await page.locator('.eggcard').count(), 0);
    assert.equal(await page.locator('#search').evaluate(input => document.activeElement === input), true);
    await page.locator('#search').fill('');
    await page.locator('[data-eaten-filter=uneaten]').click();
    assert.equal(await page.locator('.egg-interaction[data-egg-id="' + id + '"]').count(), 0);
    await page.locator('[data-eaten-filter=all]').click();
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow at ' + width);
      const action = await page.locator('.egg-action').first().boundingBox();
      assert.ok(action.height >= 44);
    }
    online = false;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.interaction-service-message').textContent.includes('暂不可用'));
    assert.equal(await page.locator('.vote-good .vote-count').first().textContent(), '—');
    await page.locator('[data-eaten-filter=eaten]').click();
    assert.equal(await page.locator('.eggcard').count(), 1);
    online = true;
    await page.locator('[data-interaction-retry]').click();
    await page.waitForFunction(() => document.querySelector('.vote-good:not(:disabled)'));
    assert.equal(await page.locator('.vote-good .vote-count').first().textContent(), '4');
    // A controlled captcha fixture records the real frontend widget contract;
    // it does not load or solve a live challenge.
    captcha = true;
    await page.addInitScript(() => {
      window.captchaRenders = 0;
      window.turnstile = { render(box, options) { window.captchaOptions = options; return ++window.captchaRenders; }, remove() {} };
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.vote-good:not(:disabled)'));
    await page.locator('[data-eaten-filter=eaten]').click();
    await card.locator('.vote-bad').click();
    await page.waitForFunction(() => window.captchaOptions);
    assert.equal(await page.evaluate(() => window.captchaOptions.action), 'egg-vote', 'backend verifies this captcha action');
    assert.equal(await card.locator('.vote-good').isDisabled(), true);
    await page.evaluate(() => window.captchaOptions['error-callback']());
    await page.waitForFunction(() => !document.querySelector('.vote-good').disabled);
    assert.equal(voteCount, 1, 'captcha error does not post an unverified vote');
    assert.match(await card.locator('.egg-action-message').textContent(), /验证失败/);
    await card.locator('.vote-bad').click();
    await page.waitForFunction(() => window.captchaRenders === 2);
    await page.evaluate(() => window.captchaOptions.callback('fresh-test-token'));
    await page.waitForFunction(() => document.querySelector('.egg-action-message').textContent.includes('正在提交'));
    assert.equal(await card.locator('.vote-good').isDisabled(), true, 'fresh token remains busy until server confirmation');
    await new Promise(resolve => { const poll = () => voteCount === 2 ? resolve() : setTimeout(poll, 10); poll(); });
    assert.equal(lastVote.turnstileToken, 'fresh-test-token');
    finishVote();
    await page.waitForFunction(() => !document.querySelector('.vote-bad').disabled);
    assert.equal(await card.locator('.vote-bad').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
