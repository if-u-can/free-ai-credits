import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
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

test('prerendered page paginates after combined filters and preserves a hidden vote response', { skip: !playwright }, async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const sample = JSON.parse(await readFile(path.join(root, 'data/eggs.json'), 'utf8')).eggs.find(egg => egg.status === 'active');
  const eggs = Array.from({ length: 16 }, (_, i) => ({ ...sample, id: 'fixture-' + (i + 1), name: 'Fixture ' + String(i + 1).padStart(2, '0'), status: 'active', grade: 'normal', quality_score: 50 }));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'freeegg-prerender-test-'));
  let browser, server, finishVote, postCount = 0;
  const records = Object.fromEntries(eggs.map(egg => [egg.id, { good: 3, bad: 1, myVote: null, reviewPending: false, reviewRequestedAt: null, lastVerified: '2026-10-09' }]));
  try {
    await mkdir(path.join(temp, 'scripts'));
    await mkdir(path.join(temp, 'data'));
    await copyFile(path.join(root, 'scripts/prerender.py'), path.join(temp, 'scripts/prerender.py'));
    await copyFile(path.join(root, 'index.html'), path.join(temp, 'index.html'));
    await copyFile(path.join(root, 'sitemap.xml'), path.join(temp, 'sitemap.xml'));
    await writeFile(path.join(temp, 'data/eggs.json'), JSON.stringify({ eggs, updated_at: '2026-10-10' }));
    execFileSync(process.env.PYTHON_EXECUTABLE || 'python', [path.join(temp, 'scripts/prerender.py')], { encoding: 'utf8' });
    const html = await readFile(path.join(temp, 'index.html'), 'utf8');
    assert.equal((html.match(/class="seo-egg"/g) || []).length, 16, 'real prerender script writes the fixture catalog');
    assert.equal((html.match(/<!--SEO:START-->/g) || []).length, 1);
    assert.match(await readFile(path.join(temp, 'sitemap.xml'), 'utf8'), /<lastmod>2026-10-10<\/lastmod>/);
    // Repeated workflow runs must preserve hooks and exactly one static block.
    execFileSync(process.env.PYTHON_EXECUTABLE || 'python', [path.join(temp, 'scripts/prerender.py')], { encoding: 'utf8' });
    assert.equal(await readFile(path.join(temp, 'index.html'), 'utf8'), html);
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/interactions')) {
        res.setHeader('content-type', 'application/json');
        if (url.pathname.endsWith('/config')) return res.end(JSON.stringify({ available: true }));
        if (req.method === 'POST') {
          let raw = ''; for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw); postCount++;
          finishVote = () => {
            records[body.eggId] = { ...records[body.eggId], good: 4, myVote: body.vote, reviewPending: true, reviewRequestedAt: '2026-10-10T00:00:00.000Z' };
            res.end(JSON.stringify({ available: true, egg: { id: body.eggId, ...records[body.eggId] } }));
          };
          return;
        }
        const requested = Object.fromEntries(url.searchParams.get('ids').split(',').map(id => [id, records[id]]));
        return res.end(JSON.stringify({ available: true, eggs: requested }));
      }
      try {
        const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const content = filename === 'index.html' ? html : filename === 'data/eggs.json' ? JSON.stringify({ eggs, updated_at: '2026-10-10' }) : await readFile(path.join(root, filename));
        res.setHeader('content-type', ({ '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.webp': 'image/webp' })[path.extname(filename)] || 'application/octet-stream');
        res.end(content);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => document.querySelector('.vote-good:not(:disabled)'));
    assert.equal(await page.locator('.eggcard').count(), 12, 'default collapse limits visible cards');
    assert.equal(await page.locator('.seo-egg').count(), 0, 'JS replaces static cards with live interaction cards');
    const target = page.locator('[data-egg-id="fixture-13"]');
    await page.locator('#morebtn').click();
    assert.equal(await page.locator('.eggcard').count(), 16);
    await target.locator('[data-egg-action=eaten]').click();
    await target.locator('.vote-good').click();
    await page.waitForFunction(() => document.querySelector('[data-egg-id="fixture-13"] .egg-action-message').textContent.includes('正在提交'));
    await page.locator('#morebtn').click();
    assert.equal(await target.count(), 0, 'collapse hides the in-flight card');
    assert.equal(await page.locator('.eggcard').count(), 12);
    assert.ok(finishVote, 'server received the pending request');
    finishVote();
    await page.waitForFunction(() => document.querySelector('#review-list').textContent.includes('Fixture 13'));
    await page.locator('#morebtn').click();
    assert.equal(await target.locator('.vote-good .vote-count').textContent(), '4');
    assert.equal(await target.locator('.vote-good').getAttribute('aria-pressed'), 'true');
    assert.equal(postCount, 1, 'rendering never duplicates the ballot');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.vote-good:not(:disabled)'));
    assert.equal(await target.count(), 0, 'refresh restores default collapse');
    await page.locator('[data-eaten-filter=eaten]').click();
    assert.equal(await page.locator('.eggcard').count(), 1, 'filter the full catalog before taking the first twelve');
    assert.equal(await target.locator('.vote-good .vote-count').textContent(), '4');
    assert.equal(await page.locator('#morebtn').count(), 0);
    await page.locator('[data-filter=premium]').click();
    assert.equal(await page.locator('.eggcard').count(), 0);
    await page.locator('[data-filter=normal]').click();
    assert.equal(await page.locator('.eggcard').count(), 1);
    await page.locator('#search').fill('Fixture 13');
    assert.equal(await target.count(), 1);
    assert.equal(await page.locator('#search').evaluate(input => document.activeElement === input), true);
    await page.locator('[data-eaten-filter=uneaten]').click();
    assert.equal(await page.locator('.eggcard').count(), 0);
    await page.locator('[data-eaten-filter=all]').click();
    await page.locator('#search').fill('Fixture');
    assert.equal(await page.locator('.eggcard').count(), 16, 'search results retain main behavior without pagination');
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'merged page fits ' + width);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
