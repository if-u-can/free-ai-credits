/* Native Apps Script entry points. Secrets are read only from Script Properties. */
var SyncRunner = (function () {
  'use strict';
  function run(rows, env) {
    if (env.paused) return;
    var started = env.now(), count = 0;
    for (var i = 0; i < rows.length && count < 3 && env.now() - started < 180000; i++) {
      if (env.paused || (env.isPaused && env.isPaused())) break;
      var row = rows[i];
      if (row.review_status !== 'APPROVED' || row.reviewed_by !== 'ChatGPT' || ['PENDING', 'RETRY', 'VERIFY_PENDING'].indexOf(row.sync_status) < 0) continue;
      var now = env.now(), iso = new Date(now).toISOString();
      if (row.publish_at && !isNaN(Date.parse(row.publish_at)) && Date.parse(row.publish_at) > now) continue;
      if (row.next_attempt_at && !isNaN(Date.parse(row.next_attempt_at)) && Date.parse(row.next_attempt_at) > now) continue;
      count++;
      var parsed = null, result = null, error = null, originalStatus = row.sync_status;
      try {
        var reviewed = SyncCore.timestamp(row.reviewed_at, 'reviewed_at');
        if (Date.parse(reviewed) > now) SyncCore.fail('reviewed_at cannot be in the future');
        var previousAttempts = Number(row.attempts || 0);
        if (!isFinite(previousAttempts) || previousAttempts < 0 || Math.floor(previousAttempts) !== previousAttempts) SyncCore.fail('Invalid attempts counter');
        row.attempts = previousAttempts < 5 ? previousAttempts + 1 : previousAttempts;
        parsed = SyncCore.parseTask(row, env.hash);
        row.payload_hash = parsed.payload_hash;
        if (row.next_attempt_at) SyncCore.timestamp(row.next_attempt_at, 'next_attempt_at');
        var done = env.getDone(parsed.task_id);
        if (done && done.payload_hash !== parsed.payload_hash) SyncCore.fail('Task ID already has different payload', 'CONFLICT');
        // Reject an ambiguous duplicate before publishing either row.
        rows.forEach(function (other) {
          if (other === row || other.task_id !== parsed.task_id) return;
          var duplicate;
          try { duplicate = SyncCore.parseTask(other, env.hash); } catch (_) { SyncCore.fail('Duplicate task ID has invalid payload', 'CONFLICT'); }
          if (duplicate.payload_hash !== parsed.payload_hash) SyncCore.fail('Duplicate task ID has different payload', 'CONFLICT');
        });
        if (done && done.result === 'NO_CHANGE') {
          result = { result: 'NO_CHANGE', commit_sha: env.github.head(), payload_hash: parsed.payload_hash, detail: 'Completed no-change task replay; current HEAD verified, no patch reapplied' };
        } else if (previousAttempts >= 5) {
          // A completed GitHub write may still need its Sheet journal restored. This path cannot write.
          if (originalStatus !== 'VERIFY_PENDING' || !row.commit_sha) SyncCore.fail('Attempt limit reached; investigate before resetting attempts');
          result = env.github.recover(parsed, env.github.head());
          if (!result) SyncCore.fail('Attempt limit reached and no committed receipt found');
        } else result = env.github.publish(parsed, env.mode, iso);
        row.sync_status = result.result === 'NO_CHANGE' ? 'NO_CHANGE' : 'SYNCED';
        row.commit_sha = result.commit_sha; row.error = ''; row.next_attempt_at = '';
        env.setDone(parsed.task_id, { payload_hash: parsed.payload_hash, result: result.result, commit_sha: result.commit_sha });
      } catch (e) {
        var code = e.code || 'INTERNAL';
        // Internal exceptions, network errors and upstream bodies are never written to Sheets.
        var safeCodes = ['INVALID', 'CONFLICT', 'RULES_CHANGED', 'API_REJECTED', 'PERMISSION', 'RETRY', 'VERIFY_PENDING'];
        var safe = safeCodes.indexOf(code) >= 0 ? e.message : 'Publisher internal failure; inspect configuration';
        error = safe;
        var retryable = code === 'RETRY' || code === 'VERIFY_PENDING';
        row.sync_status = retryable && row.attempts < 5 ? code : 'FAILED';
        row.error = safe;
        row.next_attempt_at = retryable && row.attempts < 5 ? new Date(now + Math.min(3600000, 60000 * Math.pow(2, row.attempts - 1))).toISOString() : '';
        if (code === 'PERMISSION') env.pause();
      }
      row.updated_at = iso;
      try {
        // Final status is the journal's completion marker: metadata and log must be durable first.
        env.save(row);
        env.log({ executed_at: iso, task_id: row.task_id, target: row.target, commit_sha: result ? result.commit_sha : '', result: row.sync_status, detail: error || result.detail, payload_hash: parsed ? parsed.payload_hash : '' });
        if (env.flush) env.flush();
        if (env.finish) env.finish(row);
      } catch (_) {
        row.sync_status = 'VERIFY_PENDING';
        row.error = 'Sheets persistence pending; recover original task before further publishing';
        row.next_attempt_at = '';
        try { if (env.pending) env.pending(row); } catch (_) { /* Original nonterminal state remains eligible if Sheets is unavailable. */ }
        console.log('Sheets persistence pending; this batch stopped safely');
        break;
      }
      if (env.paused) break;
    }
  }
  return { run: run };
})();

var SYNC_QUEUE_HEADERS = ['task_id', 'operation', 'target', 'payload_json', 'review_status', 'publish_at', 'sync_status', 'error', 'attempts', 'next_attempt_at', 'commit_sha', 'payload_hash', 'reviewed_by', 'reviewed_at', 'updated_at'];
var SYNC_LOG_HEADERS = ['executed_at', 'task_id', 'target', 'commit_sha', 'result', 'detail', 'payload_hash'];
var SYNC_REPOSITORY = 'if-u-can/free-ai-credits';

function syncHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8).map(function (n) { return ('0' + ((n + 256) % 256).toString(16)).slice(-2); }).join('');
}

function syncSettings_() {
  var properties = PropertiesService.getScriptProperties();
  var token = properties.getProperty('GITHUB_TOKEN'), id = properties.getProperty('SPREADSHEET_ID'), mode = properties.getProperty('MODE');
  if (!token || !id || !/^[A-Za-z0-9_-]+$/.test(id) || ['TEST', 'PRODUCTION'].indexOf(mode) < 0) throw new Error('Set GITHUB_TOKEN, SPREADSHEET_ID and MODE=TEST/PRODUCTION in Script Properties');
  if (mode === 'PRODUCTION' && properties.getProperty('PRODUCTION_READY') !== 'A,B,C') throw new Error('Production requires completed acceptance A, B, C and PRODUCTION_READY=A,B,C');
  var paused = properties.getProperty('PAUSED');
  if (paused !== 'true' && paused !== 'false') throw new Error('Set PAUSED=true or false in Script Properties');
  return { properties: properties, token: token, spreadsheetId: id, mode: mode, paused: paused === 'true' };
}

function syncSheets_(settings) {
  var book = SpreadsheetApp.openById(settings.spreadsheetId);
  var queue = book.getSheetByName('待发布队列'), log = book.getSheetByName('发布日志');
  function check(sheet, headers, label) {
    if (!sheet) throw new Error('Missing sheet: ' + label);
    var actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (!SyncCore.equal(actual, headers)) throw new Error('Header mismatch: ' + label);
  }
  check(queue, SYNC_QUEUE_HEADERS, '待发布队列'); check(log, SYNC_LOG_HEADERS, '发布日志');
  return { queue: queue, log: log };
}

function checkConfiguration() {
  var settings = syncSettings_(); syncSheets_(settings);
  var result = { repository: SYNC_REPOSITORY, branch: 'main', mode: settings.mode, paused: settings.paused, sheets: 'Headers verified; GitHub token presence only (no network request)' };
  console.log(JSON.stringify(result)); return result;
}

function runSync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var settings = syncSettings_(); if (settings.paused) return;
    var started = Date.now(), sheets = syncSheets_(settings);
    if (sheets.queue.getLastRow() <= 1) return;
    var values = sheets.queue.getRange(2, 1, sheets.queue.getLastRow() - 1, SYNC_QUEUE_HEADERS.length).getValues();
    var rows = values.map(function (values, index) {
      var row = { sheetRow: index + 2, sourceValues: values.slice() };
      SYNC_QUEUE_HEADERS.forEach(function (key, i) { row[key] = values[i] instanceof Date ? values[i].toISOString() : values[i]; }); return row;
    });
    var github = SyncGitHub.create({
      hash: syncHash_,
      decode: function (encoded) { return Utilities.newBlob(Utilities.base64Decode(encoded.replace(/\s/g, ''))).getDataAsString('UTF-8'); },
      request: function (method, path, body) {
        if (Date.now() - started >= 180000) SyncCore.fail('Run time budget reached', 'RETRY');
        var options = { method: method.toLowerCase(), headers: { Authorization: 'Bearer ' + settings.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, muteHttpExceptions: true, followRedirects: false };
        if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
        var response = UrlFetchApp.fetch('https://api.github.com/repos/' + SYNC_REPOSITORY + path, options);
        var data = {}; try { data = JSON.parse(response.getContentText()); } catch (_) { /* Never expose upstream body. */ }
        return { status: response.getResponseCode(), data: data };
      }
    });
    function sourceUnchanged(row) {
      var current = sheets.queue.getRange(row.sheetRow, 1, 1, SYNC_QUEUE_HEADERS.length).getValues()[0];
      var sourceKeys = ['task_id', 'operation', 'target', 'payload_json', 'review_status', 'publish_at', 'reviewed_by', 'reviewed_at'];
      return !sourceKeys.some(function (key) { var index = SYNC_QUEUE_HEADERS.indexOf(key); return !SyncCore.equal(current[index] instanceof Date ? current[index].toISOString() : current[index], row.sourceValues[index] instanceof Date ? row.sourceValues[index].toISOString() : row.sourceValues[index]); });
    }
    function writeResult(row, keys) {
      keys.forEach(function (key) { sheets.queue.getRange(row.sheetRow, SYNC_QUEUE_HEADERS.indexOf(key) + 1).setValue(row[key]); });
    }
    var env = {
      mode: settings.mode, paused: false, hash: syncHash_, now: Date.now, github: github,
      isPaused: function () { return settings.properties.getProperty('PAUSED') === 'true'; },
      getDone: function (id) { var raw = settings.properties.getProperty('DONE_' + syncHash_(id)); return raw ? JSON.parse(raw) : null; },
      setDone: function (id, value) { // Receipt already persists successful writes; only no-change needs a local ledger.
        if (value.result === 'NO_CHANGE') settings.properties.setProperty('DONE_' + syncHash_(id), JSON.stringify(value));
      },
      save: function (row) {
        if (!sourceUnchanged(row)) return;
        // Write only result columns; never overwrite the reviewed payload or a concurrent human edit.
        writeResult(row, ['commit_sha', 'payload_hash', 'error', 'attempts', 'next_attempt_at', 'updated_at']);
      },
      log: function (entry) {
        if (['SYNCED', 'NO_CHANGE'].indexOf(entry.result) >= 0 && sheets.log.getLastRow() > 1) {
          var logged = sheets.log.getRange(2, 1, sheets.log.getLastRow() - 1, SYNC_LOG_HEADERS.length).getValues();
          if (logged.some(function (values) { return values[1] === entry.task_id && values[3] === entry.commit_sha && values[6] === entry.payload_hash && ['SYNCED', 'NO_CHANGE'].indexOf(values[4]) >= 0; })) return;
        }
        sheets.log.appendRow(SYNC_LOG_HEADERS.map(function (key) { return entry[key] || ''; }));
      },
      finish: function (row) { if (sourceUnchanged(row)) writeResult(row, ['sync_status']); },
      flush: function () { SpreadsheetApp.flush(); },
      pending: function (row) { if (sourceUnchanged(row)) writeResult(row, ['sync_status', 'error', 'next_attempt_at']); },
      pause: function () { settings.properties.setProperty('PAUSED', 'true'); env.paused = true; }
    };
    SyncRunner.run(rows, env);
  } finally { lock.releaseLock(); }
}

function installMinuteTrigger() {
  checkConfiguration();
  var lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) throw new Error('Publisher busy; retry installation');
  try {
    ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'runSync'; }).forEach(function (t) { ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('runSync').timeBased().everyMinutes(1).create();
  } finally { lock.releaseLock(); }
}

function stopSync() {
  PropertiesService.getScriptProperties().setProperty('PAUSED', 'true');
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'runSync'; }).forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

function runSelfTests() {
  function rejects(f, code) { try { f(); } catch (e) { if (e.code === code) return; throw new Error('Self-test wrong error'); } throw new Error('Self-test expected rejection'); }
  var row = { task_id: 'self-test', operation: 'test.write', target: 'tests/automation-write-test.txt', payload_json: '{', publish_at: '' };
  rejects(function () { SyncCore.parseTask(row, syncHash_); }, 'INVALID');
  row.payload_json = JSON.stringify({ content: 'new', expected: 'old' });
  rejects(function () { SyncCore.merge(SyncCore.parseTask(row, syncHash_), { 'tests/automation-write-test.txt': 'someone else' }, {}, new Date().toISOString()); }, 'CONFLICT');
  console.log('2 local self-tests passed; no GitHub or Sheet writes'); return { passed: 2 };
}
