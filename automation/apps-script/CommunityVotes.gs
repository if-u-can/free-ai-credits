/* Independent community storage. Never calls the content publisher or GitHub. */
var CommunityVotes = (function () {
  'use strict';
  var HEADERS = {
    '社区投票': ['egg_id', 'voter_hash', 'vote', 'generation', 'updated_at', 'request_sequence', 'baseline_generation'],
    '投票限流': ['voter_hash', 'window_start', 'hits', 'sequence', 'journal_json', 'updated_at'],
    '社区复核': ['egg_id', 'kind', 'generation', 'review_pending', 'review_requested_at', 'last_verified', 'resolution_id', 'outcome', 'evidence_url', 'notes', 'verified_at', 'resolved_at', 'baseline_generation']
  };
  function fail(code, status, message) { var error = new Error(message); error.code = code; error.status = status; throw error; }
  function integer(value) { return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= 0 && value <= 9007199254740991; }
  function id(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value); }
  function voter(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
  function date(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value; }
  function digest(value) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)); }
  function settings() {
    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty('INTERACTIONS_GOOGLE_SECRET'), bookId = properties.getProperty('SPREADSHEET_ID');
    if (!secret || secret.length < 32 || !bookId || !/^[A-Za-z0-9_-]+$/.test(bookId)) fail('configuration', 503, '社区投票尚未配置。');
    return { properties: properties, secret: secret, bookId: bookId };
  }
  function authenticate(raw, config) {
    if (typeof raw !== 'string' || raw.length > 18000) fail('invalid_request', 400, '请求格式不正确。');
    var envelope; try { envelope = JSON.parse(raw); } catch (_) { fail('invalid_request', 400, '请求格式不正确。'); }
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') fail('authentication', 403, '请求验证失败。');
    var signature = Utilities.base64Encode(Utilities.computeHmacSha256Signature(envelope.payload, config.secret, Utilities.Charset.UTF_8));
    var different = signature.length ^ envelope.signature.length;
    for (var i = 0; i < signature.length; i++) different |= signature.charCodeAt(i) ^ (envelope.signature.charCodeAt(i) || 0);
    if (different) fail('authentication', 403, '请求验证失败。');
    var input; try { input = JSON.parse(envelope.payload); } catch (_) { fail('invalid_request', 400, '请求格式不正确。'); }
    if (!input || input.version !== 1 || ['health', 'stats', 'vote'].indexOf(input.action) < 0 || !integer(input.timestamp) || Math.abs(Date.now() - input.timestamp) > 120000 || !id(input.requestId)) fail('invalid_request', 400, '请求参数或时间无效。');
    if (!Array.isArray(input.ids) || input.ids.length > 60 || !input.ids.every(id) || input.ids.some(function (value, index) { return input.ids.indexOf(value) !== index; }) || !input.dates || typeof input.dates !== 'object' || Array.isArray(input.dates)) fail('invalid_request', 400, '鸡蛋列表无效。');
    if (input.ids.some(function (egg) { return input.dates[egg] !== null && !date(input.dates[egg]); }) || (input.voterHash !== null && !voter(input.voterHash))) fail('invalid_request', 400, '匿名身份或日期无效。');
    if (input.action === 'health' && (input.ids.length || input.voterHash !== null)) fail('invalid_request', 400, '健康检查参数无效。');
    if (input.action !== 'health' && !input.ids.length) fail('invalid_request', 400, '鸡蛋列表不能为空。');
    if (input.action === 'vote' && (!voter(input.voterHash) || !id(input.eggId) || input.ids.length !== 1 || input.ids[0] !== input.eggId || ['good', 'bad'].indexOf(input.vote) < 0)) fail('invalid_vote', 400, '投票参数无效。');
    input.fingerprint = digest(envelope.payload);
    return input;
  }
  function open(config) {
    var book = SpreadsheetApp.openById(config.bookId), tables = {};
    Object.keys(HEADERS).forEach(function (name) {
      var sheet = book.getSheetByName(name), headers = HEADERS[name];
      if (!sheet || sheet.getLastRow() < 1 || JSON.stringify(sheet.getRange(1, 1, 1, headers.length).getValues()[0]) !== JSON.stringify(headers)) fail('storage', 503, '社区投票工作表尚未初始化。');
      var values = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues() : [];
      tables[name] = { sheet: sheet, headers: headers, rows: values.map(function (values, index) {
        var row = { sheetRow: index + 2 };
        headers.forEach(function (key, i) {
          var value = values[i];
          if (Object.prototype.toString.call(value) === '[object Date]') value = ['last_verified', 'verified_at'].indexOf(key) >= 0 ? Utilities.formatDate(value, 'Asia/Shanghai', 'yyyy-MM-dd') : value.toISOString();
          row[key] = value;
        });
        return row;
      }) };
    });
    return tables;
  }
  function save(table, record) {
    var values = table.headers.map(function (key) { return record[key] === undefined || record[key] === null ? '' : record[key]; });
    if (record.sheetRow) table.sheet.getRange(record.sheetRow, 1, 1, table.headers.length).setValues([values]);
    else { table.sheet.appendRow(values); record.sheetRow = table.sheet.getLastRow(); table.rows.push(record); }
  }
  function unique(rows, match) { var found = rows.filter(match); if (found.length > 1) fail('storage', 503, '社区投票数据需要管理员检查。'); return found[0] || null; }
  function state(tables, eggId, create) {
    var table = tables['社区复核'];
    var record = unique(table.rows, function (row) { return row.kind === 'state' && row.egg_id === eggId; });
    if (!record && create) { record = { egg_id: eggId, kind: 'state', generation: 0, review_pending: false, review_requested_at: '', last_verified: '' }; save(table, record); }
    return record;
  }
  function ballots(tables, eggId) { return tables['社区投票'].rows.filter(function (row) { return row.egg_id === eggId; }); }
  function markBaseline(table, eggId, generation) {
    var changed = false;
    table.rows.forEach(function (ballot) {
      if (ballot.egg_id === eggId && ballot.vote === 'bad' && ballot.baseline_generation !== generation) { ballot.baseline_generation = generation; changed = true; }
    });
    if (changed) {
      // One bounded-size marker per ballot; no list of identities in a single cell.
      // A persisted resolution is replayed before accepting any newer vote, so
      // an interrupted batch resumes against the same pre-resolution choices.
      var values = table.rows.map(function (row) { return table.headers.map(function (key) { return row[key] === undefined || row[key] === null ? '' : row[key]; }); });
      table.sheet.getRange(2, 1, values.length, table.headers.length).setValues(values);
    }
  }
  function reconcileResolutions(tables) {
    tables['社区复核'].rows.filter(function (row) { return row.kind === 'resolution'; }).forEach(function (resolution) {
      var current = state(tables, resolution.egg_id, false);
      if (!current || !integer(current.generation) || !integer(resolution.generation) || current.generation < resolution.generation) fail('storage', 503, '复核日志需要管理员检查。');
      if (current.generation !== resolution.generation) return;
      if (resolution.baseline_generation !== resolution.generation + 1) fail('storage', 503, '复核基线代次无效。');
      markBaseline(tables['社区投票'], resolution.egg_id, resolution.baseline_generation);
      // Persist the journal and all baseline markers before the state can advance.
      // If flushing fails, the old generation remains available for reconciliation.
      SpreadsheetApp.flush();
      current.generation++; current.review_pending = false; current.review_requested_at = '';
      current.last_verified = resolution.verified_at; current.baseline_generation = resolution.baseline_generation;
      save(tables['社区复核'], current);
    });
  }
  function replay(tables) {
    // Accepted requests are persisted before ballots. Sequence prevents an old retry
    // from overwriting a later choice, even after an ambiguous Sheet write response.
    tables['投票限流'].rows.forEach(function (rate) {
      var journal = JSON.parse(rate.journal_json || '[]');
      if (!voter(rate.voter_hash) || !integer(rate.sequence) || !Array.isArray(journal)) fail('storage', 503, '投票日志需要管理员检查。');
      journal.forEach(function (entry) {
        if (!id(entry.eggId) || !integer(entry.sequence) || !integer(entry.timestamp) || ['good', 'bad'].indexOf(entry.vote) < 0) fail('storage', 503, '投票日志无效。');
        var table = tables['社区投票'];
        var existing = unique(table.rows, function (row) { return row.egg_id === entry.eggId && row.voter_hash === rate.voter_hash; });
        if (existing && existing.request_sequence >= entry.sequence) return;
        var current = state(tables, entry.eggId, true);
        var ballot = existing || { egg_id: entry.eggId, voter_hash: rate.voter_hash };
        if (!existing || ballot.vote !== entry.vote) { ballot.vote = entry.vote; ballot.generation = current.generation; ballot.updated_at = new Date(entry.timestamp).toISOString(); }
        ballot.request_sequence = entry.sequence; save(table, ballot);
      });
    });
    reconcileResolutions(tables);
    tables['社区复核'].rows.filter(function (row) { return row.kind === 'state'; }).forEach(function (current) {
      if (!integer(current.generation)) fail('storage', 503, '复核代次无效。');
      var votes = ballots(tables, current.egg_id), bad = votes.filter(function (row) { return row.vote === 'bad'; });
      var freshBad = bad.filter(function (row) { return row.generation === current.generation && row.baseline_generation !== current.generation; });
      if (!current.review_pending && freshBad.length >= 3 && bad.length * 5 >= votes.length * 3) {
        current.review_pending = true; current.review_requested_at = new Date().toISOString(); save(tables['社区复核'], current);
      }
    });
  }
  function result(tables, eggId, identity, staticDate) {
    var votes = ballots(tables, eggId), current = state(tables, eggId, false);
    var mine = identity ? unique(votes, function (row) { return row.voter_hash === identity; }) : null;
    var verified = current && current.last_verified || null;
    if (staticDate && (!verified || staticDate > verified)) verified = staticDate;
    return { good: votes.filter(function (row) { return row.vote === 'good'; }).length,
      bad: votes.filter(function (row) { return row.vote === 'bad'; }).length, myVote: mine ? mine.vote : null,
      reviewPending: !!(current && current.review_pending), reviewRequestedAt: current && current.review_requested_at || null, lastVerified: verified };
  }
  function accept(tables, input) {
    var table = tables['投票限流'], now = Date.now(), windowStart = Math.floor(now / 60000) * 60000;
    var rate = unique(table.rows, function (row) { return row.voter_hash === input.voterHash; });
    if (!rate) rate = { voter_hash: input.voterHash, window_start: windowStart, hits: 0, sequence: 0, journal_json: '[]' };
    var entries = JSON.parse(rate.journal_json || '[]');
    var duplicate = entries.filter(function (entry) { return entry.requestId === input.requestId; })[0];
    if (duplicate) {
      if (duplicate.fingerprint !== input.fingerprint) fail('request_conflict', 409, '同一请求标识的内容发生变化。');
      return;
    }
    if (!integer(rate.hits) || !integer(rate.window_start) || !integer(rate.sequence)) fail('storage', 503, '投票限流数据无效。');
    if (rate.window_start !== windowStart) { rate.window_start = windowStart; rate.hits = 0; }
    if (rate.hits >= 20) { var error = new Error('投票太频繁，请稍后再试。'); error.code = 'rate_limited'; error.status = 429; error.retryAfter = Math.max(1, Math.ceil((windowStart + 60000 - now) / 1000)); throw error; }
    rate.hits++; rate.sequence++; rate.updated_at = new Date(now).toISOString();
    // replay() completed first, so pruning an old accepted request cannot drop a ballot.
    entries = entries.filter(function (entry) { return entry.timestamp >= now - 120000; });
    entries.push({ requestId: input.requestId, fingerprint: input.fingerprint, sequence: rate.sequence, timestamp: input.timestamp, eggId: input.eggId, vote: input.vote });
    rate.journal_json = JSON.stringify(entries); save(table, rate);
  }
  function withLock(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) { var error = new Error('社区投票服务忙，请稍后重试。'); error.code = 'busy'; error.status = 503; error.retryAfter = 2; throw error; }
    // Sheets caches writes. Flush the partial journal while the lock is held,
    // including when fn throws, before another process can read/write the rate row.
    try { return fn(); } finally { try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); } }
  }
  function handle(raw) {
    try {
      var config = settings(), input = authenticate(raw, config);
      return withLock(function () {
        var tables = open(config);
        if (input.action === 'health') return { available: true };
        replay(tables);
        if (input.action === 'vote') { accept(tables, input); replay(tables); }
        var output = { available: true };
        if (input.action === 'vote') { output.egg = result(tables, input.eggId, input.voterHash, input.dates[input.eggId]); output.egg.id = input.eggId; }
        else { output.eggs = {}; input.ids.forEach(function (eggId) { output.eggs[eggId] = result(tables, eggId, input.voterHash, input.dates[eggId]); }); }
        return output;
      });
    } catch (error) {
      return { available: false, code: error.code || 'storage', status: error.status || 503,
        message: error.code ? error.message : '社区投票存储暂不可用，请重试。', ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) };
    }
  }
  function setup() {
    return withLock(function () {
      var config = settings(), book = SpreadsheetApp.openById(config.bookId);
      Object.keys(HEADERS).forEach(function (name) {
        var sheet = book.getSheetByName(name) || book.insertSheet(name);
        if (!sheet.getLastRow()) sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
        else if (JSON.stringify(sheet.getRange(1, 1, 1, HEADERS[name].length).getValues()[0]) !== JSON.stringify(HEADERS[name])) throw Error('Header mismatch: ' + name);
      });
      return { configured: true, sheets: Object.keys(HEADERS) };
    });
  }
  function resolve(value) {
    var config = settings();
    var input = value || JSON.parse(config.properties.getProperty('COMMUNITY_REVIEW_RESOLUTION') || 'null');
    if (!input || !id(input.resolutionId) || !id(input.eggId) || !integer(input.expectedGeneration) || ['confirmed', 'corrected', 'unverifiable'].indexOf(input.outcome) < 0 || typeof input.evidenceUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(input.evidenceUrl) || input.evidenceUrl.length > 2000 || typeof input.notes !== 'string' || input.notes.trim().length < 10 || input.notes.length > 4000 || input.notes.startsWith('=') || !date(input.verifiedAt) || input.verifiedAt > new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)) throw Error('Invalid resolution: actual official evidence, date and notes are required');
    return withLock(function () {
      var tables = open(config); replay(tables);
      var table = tables['社区复核'];
      var previous = unique(table.rows, function (row) { return row.kind === 'resolution' && row.resolution_id === input.resolutionId; });
      if (previous) {
        if (previous.egg_id !== input.eggId || previous.generation !== input.expectedGeneration || previous.outcome !== input.outcome || previous.evidence_url !== input.evidenceUrl || previous.notes !== input.notes || previous.verified_at !== input.verifiedAt) throw Error('Resolution ID reused with different evidence');
        return { resolved: true, generation: previous.generation + 1 };
      }
      var current = state(tables, input.eggId, false);
      if (!current || !current.review_pending || current.generation !== input.expectedGeneration) throw Error('Review is not pending or expected generation is stale');
      if (current.last_verified && input.verifiedAt < current.last_verified) throw Error('Resolution date cannot go backwards');
      save(table, { egg_id: input.eggId, kind: 'resolution', generation: input.expectedGeneration, resolution_id: input.resolutionId, outcome: input.outcome,
        evidence_url: input.evidenceUrl, notes: input.notes, verified_at: input.verifiedAt, resolved_at: new Date().toISOString(), baseline_generation: input.expectedGeneration + 1 });
      reconcileResolutions(tables);
      return { resolved: true, generation: input.expectedGeneration + 1 };
    });
  }
  function listReviews() {
    return withLock(function () { var tables = open(settings()); replay(tables); return tables['社区复核'].rows.filter(function (row) { return row.kind === 'state' && row.review_pending; }).map(function (row) { return { eggId: row.egg_id, generation: row.generation, requestedAt: row.review_requested_at, lastVerified: row.last_verified || null }; }); });
  }
  return { handle: handle, setup: setup, resolve: resolve, listReviews: listReviews };
})();

function doPost(event) {
  return ContentService.createTextOutput(JSON.stringify(CommunityVotes.handle(event && event.postData && event.postData.contents))).setMimeType(ContentService.MimeType.JSON);
}
function setupCommunityVotes() { return CommunityVotes.setup(); }
function listCommunityReviews() { var result = CommunityVotes.listReviews(); console.log(JSON.stringify(result)); return result; }
function resolveCommunityReview(value) { return CommunityVotes.resolve(value); }
