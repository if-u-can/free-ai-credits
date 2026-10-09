'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const SECRET = 'test-only-private-key-at-least-32-characters';
const NAMES = ['社区投票', '投票限流', '社区复核'];
const plain = value => JSON.parse(JSON.stringify(value));
function harness(existing) {
  const database = existing || { sheets: new Map(), properties: new Map([['SPREADSHEET_ID', 'existing-book'], ['INTERACTIONS_GOOGLE_SECRET', SECRET]]), fail: null };
  let now = Date.parse('2026-10-09T08:00:00Z'), busy = false, released = 0, flushes = 0, buffered = false;
  const cache = new Map(), events = [];
  function write(sheet, values, action) {
    if (values.some(row => row.some(value => typeof value === 'string' && value.length > 50000))) throw Error('Cell exceeds Sheets limit');
    if (database.fail?.(sheet, values, action)) throw Error('Injected Sheets failure');
  }
  const view = target => cache.get(target.name) || target.rows;
  function edit(target) { if (buffered && !cache.has(target.name)) cache.set(target.name, plain(target.rows)); return view(target); }
  function flushPending() { for (const [name, rows] of cache) database.sheets.get(name).rows = plain(rows); cache.clear(); }
  function sheet(target) {
    const name = target.name;
    return { getLastRow() { return view(target).length; }, getRange(row, col, count = 1, width = 1) {
      return { getValues() { return Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => view(target)[row - 1 + i]?.[col - 1 + j] ?? '')); },
        setValues(values) { write(name, values, 'set'); const rows = edit(target); values.forEach((values, i) => { rows[row - 1 + i] ||= []; values.forEach((value, j) => { rows[row - 1 + i][col - 1 + j] = plain(value); }); }); return this; } };
    }, appendRow(values) { write(name, [values], 'append'); edit(target).push(plain(values)); return this; } };
  }
  const book = { getSheetByName: name => database.sheets.has(name) ? sheet(database.sheets.get(name)) : null, insertSheet(name) { const value = { name, rows: [], getLastRow() { return this.rows.length; } }; database.sheets.set(name, value); return sheet(value); } };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = { console, Date: ClockDate, JSON, Object, Array, String, Number, Math, Error, RegExp, isFinite,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => database.properties.get(key) || null, setProperty: (key, value) => database.properties.set(key, value), deleteProperty: key => database.properties.delete(key) }) },
    SpreadsheetApp: { openById(id) { assert.equal(id, 'existing-book'); return book; }, flush() { flushes++; events.push('flush'); if (database.fail?.('flush', [], 'flush')) throw Error('Injected flush failure'); flushPending(); } },
    LockService: { getScriptLock: () => ({ tryLock: () => !busy, releaseLock: () => { released++; events.push('release'); } }) },
    Utilities: { Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      formatDate: value => new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 10),
      computeHmacSha256Signature: (text, key) => [...crypto.createHmac('sha256', key).update(text, 'utf8').digest()],
      computeDigest: (algorithm, text) => [...crypto.createHash('sha256').update(text, 'utf8').digest()],
      base64Encode: bytes => Buffer.from(bytes.map(n => (n + 256) % 256)).toString('base64') },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) } };
  vm.createContext(context);
  const file = path.join(__dirname, '../automation/apps-script/CommunityVotes.gs');
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const hash = n => crypto.createHash('sha256').update(String(n)).digest('hex');
  function payload(action, extra = {}) { return { version: 1, action, timestamp: now, requestId: crypto.randomUUID(), voterHash: action === 'health' ? null : hash('one'), ids: action === 'health' ? [] : ['egg-one'], dates: action === 'health' ? {} : { 'egg-one': '2026-10-09' }, ...extra }; }
  function post(value, modify) { const raw = JSON.stringify(value); const envelope = { payload: raw, signature: crypto.createHmac('sha256', SECRET).update(raw).digest('base64') }; if (modify) modify(envelope); return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(envelope) } }).text); }
  function install() { assert.ok(context.CommunityVotes, 'Google community vote implementation exists'); context.setupCommunityVotes(); }
  function vote(voter, choice = 'bad', extra = {}) { return post(payload('vote', { voterHash: hash(voter), eggId: 'egg-one', vote: choice, ...extra })); }
  return { context, database, post, payload, install, vote, hash, events, flushPending, bufferWrites: value => { buffered = value; }, advance: ms => { now += ms; }, setBusy: value => { busy = value; }, get flushes() { return flushes; }, get released() { return released; } };
}

module.exports = { harness, NAMES };
