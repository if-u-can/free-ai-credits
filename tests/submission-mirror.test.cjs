'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const headers = ['issue_number', 'issue_url', 'title', 'submitted_at', 'issue_updated_at', 'issue_state', 'submission_body', 'review_status', 'review_notes', 'mirrored_at'];
const marker = '<!-- freeegg-website-submission -->';
function issue(number, overrides = {}) {
  return { number, html_url: `https://github.com/if-u-can/free-ai-credits/issues/${number}`, title: `Submission ${number}`, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:01:00Z', state: 'open', body: marker + '\nA submission', ...overrides };
}
const feed = (issues, has_more = false, source_latest_updated_at = issues.length ? '2026-10-09T00:01:00Z' : null) => ({ issues, has_more, source_latest_updated_at });
function harness(options = {}) {
  const rows = options.rows || [headers.slice()];
  const properties = { SPREADSHEET_ID: 'private-sheet', ...options.properties };
  const requests = [], logs = [], triggers = options.triggers || [];
  let fetchCount = 0, flushCount = 0, releases = 0, time = Date.parse('2026-10-09T01:00:00Z');
  const sheet = {
    getLastRow: () => rows.length,
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, ri) => Array.from({ length: nc }, (_, ci) => rows[r - 1 + ri]?.[c - 1 + ci] ?? '')),
        setValues(values) {
          values.forEach((valuesRow, ri) => { rows[r - 1 + ri] ||= []; valuesRow.forEach((v, ci) => { rows[r - 1 + ri][c - 1 + ci] = v; }); });
        },
        setValue(value) { rows[r - 1] ||= []; rows[r - 1][c - 1] = value; }
      };
    }
  };
  class Clock extends Date { static now() { return time; } }
  const context = {
    console: { log: value => logs.push(value) }, Date: Clock,
    PropertiesService: { getScriptProperties: () => ({
      getProperty(name) { assert.notEqual(name, 'GITHUB_TOKEN', 'mirror must never access publisher token'); return properties[name] ?? null; },
      setProperty: (name, value) => { properties[name] = value; },
      deleteProperty: name => { delete properties[name]; }
    }) },
    SpreadsheetApp: {
      openById(id) { assert.equal(id, 'private-sheet'); return { getSheetByName: name => name === '投稿审核' && !options.missingSheet ? sheet : null }; },
      flush() { flushCount++; if (options.flushError) throw new Error('private-storage-error'); }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => !options.busy, releaseLock: () => { releases++; } }) },
    UrlFetchApp: { fetch(url, request) {
      requests.push({ url, request });
      if (options.onFetch) options.onFetch({ fetchCount, rows, advance: n => { time += n; } });
      const response = options.responses?.[fetchCount++] || { status: 200, data: feed([]) };
      if (response.error) throw new Error(response.error);
      return { getResponseCode: () => response.status, getContentText: () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data) };
    } },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger(handler) { let minutes; return { timeBased() { return this; }, everyMinutes(value) { minutes = value; return this; }, create() { triggers.push({ getHandlerFunction: () => handler, minutes }); } }; }
    }
  };
  vm.createContext(context);
  const filename = path.join(__dirname, '../automation/apps-script/SubmissionMirror.js');
  if (fs.existsSync(filename)) vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { context, rows, properties, requests, logs, triggers, releases: () => releases, flushCount: () => flushCount };
}
function run(h) { assert.equal(typeof h.context.runIssueMirror, 'function', 'standalone mirror entry point exists'); return h.context.runIssueMirror(); }

test('mirrors only marked website Issues, ignores PRs, and deduplicates repeated issue numbers', () => {
  const h = harness({ responses: [{ status: 200, data: feed([issue(1), issue(2, { body: 'Manual issue' }), issue(3, { pull_request: { url: 'pr' } }), issue(1)]) }] });
  const result = run(h);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.rows[1].slice(0, 9), [1, 'https://github.com/if-u-can/free-ai-credits/issues/1', 'Submission 1', '2026-10-09T00:00:00Z', '2026-10-09T00:01:00Z', 'open', marker + '\nA submission', 'PENDING', '']);
  assert.equal(h.requests[0].request.method, 'get');
  assert.equal(Object.keys(h.requests[0].request.headers).some(key => /authorization/i.test(key)), false);
  assert.equal(h.requests[0].url, 'https://freeegg.iffy.site/api/submissions/review-feed?page=1');
  assert.equal(h.releases(), 1);
});

test('updates closed/open source metadata while preserving concurrent manual review edits', () => {
  const row = [1, 'url', 'Old', 'created', 'updated', 'open', 'body', 'PENDING', 'old note', 'before'];
  const h = harness({ rows: [headers.slice(), row], responses: [{ status: 200, data: feed([issue(1, { state: 'closed', title: 'Updated' })]) }], onFetch: () => { row[7] = 'REJECTED'; row[8] = 'Reviewer note'; } });
  run(h);
  assert.equal(row[2], 'Updated'); assert.equal(row[5], 'closed');
  assert.equal(row[7], 'REJECTED'); assert.equal(row[8], 'Reviewer note');
  h.context.runIssueMirror();
  assert.equal(h.rows.length, 2);
});

test('escapes all untrusted formula-like strings and bounds long body cells', () => {
  const h = harness({ responses: [{ status: 200, data: feed([issue(4, { title: ' \t=IMPORTXML("evil")', html_url: '+cmd', created_at: '-1', updated_at: '@evil', body: '=SUM(1)\n' + marker + 'x'.repeat(60000) })]) }] });
  run(h);
  assert.equal(h.rows[1][1], "'+cmd"); assert.equal(h.rows[1][2], "' \t=IMPORTXML(\"evil\")");
  assert.equal(h.rows[1][3], "'-1"); assert.equal(h.rows[1][4], "'@evil");
  assert.ok(h.rows[1][6].startsWith("'=SUM(1)")); assert.ok(h.rows[1][6].length < 50000);
});

test('bounded partial pagination keeps checkpoint and restarts without duplicate sheet rows', () => {
  const page = Array.from({ length: 100 }, (_, i) => issue(i + 1));
  const h = harness({ properties: { ISSUE_MIRROR_SINCE: '2026-10-08T00:00:00Z' }, responses: Array.from({ length: 5 }, () => ({ status: 200, data: feed(page, true) })) });
  assert.equal(run(h).status, 'PARTIAL');
  assert.equal(h.requests.length, 5); assert.equal(h.rows.length, 101);
  assert.equal(h.properties.ISSUE_MIRROR_SINCE, '2026-10-08T00:00:00Z');
  assert.equal(run(h).status, 'COMPLETE');
  assert.match(h.requests[5].url, /page=1/);
  assert.match(h.requests[5].url, /since=2026-10-08T00%3A00%3A00Z/);
  assert.equal(h.properties.ISSUE_MIRROR_SINCE, '2026-10-09T00:59:59.000Z');
});

test('upstream errors keep checkpoint unchanged, return safe retry, and release the lock', () => {
  const h = harness({ responses: [{ status: 200, data: feed(Array.from({ length: 100 }, (_, i) => issue(i + 1)), true) }, { status: 403, data: { message: 'raw-private-error' } }] });
  const failed = run(h);
  assert.equal(failed.status, 'RETRY');
  assert.equal(failed.stage, 'response'); assert.equal(failed.httpStatus, 403);
  assert.equal(h.properties.ISSUE_MIRROR_SINCE, undefined);
  assert.equal(h.logs.some(line => line.includes('raw-private-error')), false);
  assert.equal(h.releases(), 1);
  run(h);
  assert.match(h.requests[2].url, /page=1/);
});

test('read-only diagnostic reports safe public API evidence without sheet writes or payload logging', () => {
  const h = harness({ responses: [{ status: 200, data: feed([issue(1, { title: 'DO-NOT-LOG-TITLE', body: marker + 'DO-NOT-LOG-BODY' })]) }] });
  assert.equal(typeof h.context.diagnoseIssueMirror, 'function');
  const result = h.context.diagnoseIssueMirror();
  assert.equal(result.status, 'OK'); assert.equal(result.stage, 'payload');
  assert.equal(result.httpStatus, 200); assert.equal(result.isArray, true);
  assert.equal(result.resultCount, 1);
  assert.deepEqual(Array.from(result.missingFields), []);
  assert.equal(h.rows.length, 1); assert.equal(h.flushCount(), 0);
  assert.equal(h.properties.ISSUE_MIRROR_SINCE, undefined);
  assert.equal(h.requests[0].url, 'https://freeegg.iffy.site/api/submissions/review-feed?page=1');
  assert.equal(h.logs.join('').includes('DO-NOT-LOG'), false);
});

test('diagnostic distinguishes HTTP failures, fetch exceptions, bad JSON and missing fields safely', () => {
  for (const [response, stage, code, isArray, missing] of [
    [{ status: 403, data: { message: 'RAW-SECRET' } }, 'response', 403, null, []],
    [{ error: 'RAW-SECRET' }, 'fetch', null, null, []],
    [{ status: 200, data: 'RAW-SECRET' }, 'parse', 200, null, []],
    [{ status: 200, data: feed([{ number: 1 }]) }, 'payload', 200, true, ['html_url', 'title', 'created_at', 'updated_at', 'state', 'body']]
  ]) {
    const h = harness({ responses: [response] });
    assert.equal(typeof h.context.diagnoseIssueMirror, 'function');
    const result = h.context.diagnoseIssueMirror();
    assert.equal(result.status, 'RETRY'); assert.equal(result.stage, stage);
    assert.equal(result.httpStatus, code); assert.equal(result.isArray, isArray);
    assert.deepEqual(Array.from(result.missingFields), missing);
    assert.equal(h.logs.join('').includes('RAW-SECRET'), false);
    assert.equal(h.rows.length, 1);
  }
});

test('relay has_more controls pagination even for empty filtered pages or 100 final results', () => {
  const h = harness({ responses: [
    { status: 200, data: feed([], true) },
    { status: 200, data: feed([issue(101)], true) },
    { status: 200, data: feed(Array.from({ length: 100 }, (_, i) => issue(i + 1)), false) }
  ] });
  assert.equal(run(h).status, 'COMPLETE');
  assert.equal(h.requests.length, 3); assert.equal(h.rows.length, 102);
  assert.equal(h.requests.every(request => request.url.startsWith('https://freeegg.iffy.site/api/submissions/review-feed?')), true);
});

test('concurrent issue updates moving between offset pages force reconciliation before checkpoint advancement', () => {
  const oldCheckpoint = '2026-10-08T00:00:00Z';
  const h = harness({ properties: { ISSUE_MIRROR_SINCE: oldCheckpoint }, responses: [
    { status: 200, data: feed(Array.from({ length: 100 }, (_, i) => issue(i + 1)), true) },
    { status: 200, data: feed([issue(1, { updated_at: '2026-10-09T01:00:01Z' })], false, '2026-10-09T01:00:01Z') },
    { status: 200, data: feed([issue(101)]) }
  ] });
  assert.equal(run(h).status, 'PARTIAL');
  assert.equal(h.properties.ISSUE_MIRROR_SINCE, oldCheckpoint);
  assert.equal(run(h).status, 'COMPLETE');
  assert.equal(h.rows.some(row => row[0] === 101), true);
  assert.match(h.requests[2].url, /page=1/);
});

test('filtered-out raw Issue movement prevents checkpoint even when relay issues is empty', () => {
  const oldCheckpoint = '2026-10-08T00:00:00Z';
  const h = harness({ properties: { ISSUE_MIRROR_SINCE: oldCheckpoint }, responses: [
    { status: 200, data: feed([], true, '2026-10-09T00:01:00Z') },
    { status: 200, data: feed([], false, '2026-10-09T01:00:01Z') },
    { status: 200, data: feed([issue(101)]) }
  ] });
  assert.equal(run(h).status, 'PARTIAL');
  assert.equal(h.properties.ISSUE_MIRROR_SINCE, oldCheckpoint);
  assert.equal(run(h).status, 'COMPLETE');
  assert.equal(h.rows.some(row => row[0] === 101), true);
  assert.match(h.requests[2].url, /page=1/);
});

test('missing or malformed raw-page watermark keeps checkpoint unchanged and diagnostic safe', () => {
  for (const source_latest_updated_at of [undefined, 'PRIVATE-INVALID', 12, '2026-10-09T01:00:00']) {
    const data = { issues: [], has_more: false, source_latest_updated_at };
    const h = harness({ responses: [{ status: 200, data }], properties: { ISSUE_MIRROR_SINCE: '2026-10-08T00:00:00Z' } });
    assert.equal(run(h).status, 'RETRY');
    assert.equal(h.properties.ISSUE_MIRROR_SINCE, '2026-10-08T00:00:00Z');
    const diagnostic = harness({ responses: [{ status: 200, data }] });
    const result = diagnostic.context.diagnoseIssueMirror();
    assert.equal(result.status, 'RETRY');
    assert.deepEqual(Array.from(result.missingFields), ['source_latest_updated_at']);
    assert.equal(diagnostic.logs.join('').includes('PRIVATE-INVALID'), false);
  }
});

test('malformed upstream data or failed sheet flush never advances checkpoint', () => {
  for (const options of [
    { responses: [{ status: 200, data: '{not-json' }] },
    { responses: [{ status: 200, data: { message: 'unexpected' } }] },
    { responses: [{ status: 200, data: { issues: [issue(1)] } }] },
    { responses: [{ status: 200, data: { issues: [issue(1)], has_more: 'false' } }] },
    { responses: [{ status: 200, data: feed([issue(1)]) }], flushError: true }
  ]) {
    const h = harness({ ...options, properties: { ISSUE_MIRROR_SINCE: '2026-10-08T00:00:00Z' } });
    assert.equal(run(h).status, 'RETRY');
    assert.equal(h.properties.ISSUE_MIRROR_SINCE, '2026-10-08T00:00:00Z');
    assert.equal(h.releases(), 1);
  }
});

test('runtime budget and shared publisher lock avoid overlapping or unbounded reads', () => {
  const busy = harness({ busy: true }); assert.equal(run(busy).status, 'BUSY'); assert.equal(busy.requests.length, 0);
  const h = harness({ responses: [{ status: 200, data: feed(Array.from({ length: 100 }, (_, i) => issue(i + 1)), true) }], onFetch: ({ advance }) => advance(180000) });
  assert.equal(run(h).status, 'PARTIAL'); assert.equal(h.requests.length, 1);
  assert.equal(h.properties.ISSUE_MIRROR_SINCE, undefined);
});

test('configuration validates the private tab; install/stop only manage the mirror trigger', () => {
  const publisher = { getHandlerFunction: () => 'runSync' };
  const oldMirror = { getHandlerFunction: () => 'runIssueMirror' };
  const h = harness({ triggers: [publisher, oldMirror] });
  assert.equal(typeof h.context.checkIssueMirrorConfiguration, 'function');
  assert.equal(h.context.checkIssueMirrorConfiguration().sheet, '投稿审核');
  assert.equal(h.requests.length, 0);
  h.context.installIssueMirrorTrigger();
  assert.equal(h.triggers.length, 2); assert.ok(h.triggers.includes(publisher));
  assert.equal(h.triggers.find(t => t !== publisher).minutes, 5);
  h.context.stopIssueMirrorTrigger(); assert.deepEqual(h.triggers, [publisher]);
  assert.equal(h.properties.PAUSED, undefined);
  const missing = harness({ missingSheet: true }); assert.throws(() => missing.context.checkIssueMirrorConfiguration(), /投稿审核/);
  const wrong = harness({ rows: [['wrong']] }); assert.throws(() => wrong.context.checkIssueMirrorConfiguration(), /Header/);
});
