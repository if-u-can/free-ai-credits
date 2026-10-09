/* Public submission review feed -> private review tab. No publishing or token use. */
var ISSUE_MIRROR_HEADERS = ['issue_number', 'issue_url', 'title', 'submitted_at', 'issue_updated_at', 'issue_state', 'submission_body', 'review_status', 'review_notes', 'mirrored_at'];
var ISSUE_MIRROR_REPOSITORY = 'if-u-can/free-ai-credits';
var ISSUE_MIRROR_FEED_URL = 'https://freeegg.iffy.site/api/submissions/review-feed';

function issueMirrorValidWatermark_(value) {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !isNaN(Date.parse(value)));
}

function issueMirrorSettings_() {
  var properties = PropertiesService.getScriptProperties();
  var id = properties.getProperty('SPREADSHEET_ID');
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Set SPREADSHEET_ID in Script Properties');
  return { properties: properties, spreadsheetId: id };
}

function issueMirrorSheet_(settings) {
  var sheet = SpreadsheetApp.openById(settings.spreadsheetId).getSheetByName('投稿审核');
  if (!sheet) throw new Error('Missing sheet: 投稿审核');
  var actual = sheet.getRange(1, 1, 1, ISSUE_MIRROR_HEADERS.length).getValues()[0];
  if (actual.some(function (value, i) { return value !== ISSUE_MIRROR_HEADERS[i]; })) throw new Error('Header mismatch: 投稿审核');
  return sheet;
}

function checkIssueMirrorConfiguration() {
  issueMirrorSheet_(issueMirrorSettings_());
  var result = { repository: ISSUE_MIRROR_REPOSITORY, sheet: '投稿审核', reads: 'Public submission review feed; no GitHub token', intervalMinutes: 5 };
  console.log(JSON.stringify(result));
  return result;
}

// Read-only health check: reports boundary evidence, never payloads, values or exception text.
function diagnoseIssueMirror() {
  var result = { status: 'RETRY', stage: 'settings', httpStatus: null, isArray: null, resultCount: null, missingFields: [] };
  try {
    var settings = issueMirrorSettings_();
    result.stage = 'sheet'; issueMirrorSheet_(settings);
    result.stage = 'fetch';
    var response = UrlFetchApp.fetch(ISSUE_MIRROR_FEED_URL + '?page=1', {
      method: 'get',
      headers: { Accept: 'application/json' },
      muteHttpExceptions: true,
      followRedirects: false
    });
    result.stage = 'response';
    var code = response.getResponseCode();
    result.httpStatus = Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
    if (result.httpStatus !== 200) throw new Error('Diagnostic HTTP failure');
    result.stage = 'parse';
    var data = JSON.parse(response.getContentText()), issues = data && data.issues;
    result.isArray = Array.isArray(issues);
    if (!result.isArray) throw new Error('Diagnostic payload failure');
    result.resultCount = Math.min(issues.length, 100);
    result.stage = 'payload';
    if (typeof data.has_more !== 'boolean') result.missingFields.push('has_more');
    if (!issueMirrorValidWatermark_(data.source_latest_updated_at)) result.missingFields.push('source_latest_updated_at');
    if (issues.length) {
      var issue = issues[0] || {};
      result.missingFields = result.missingFields.concat(['number', 'html_url', 'title', 'created_at', 'updated_at', 'state', 'body'].filter(function (field) { return !Object.prototype.hasOwnProperty.call(issue, field); }));
    }
    if (!result.missingFields.length) result.status = 'OK';
  } catch (_) { /* The fixed stage and HTTP code are the only failure evidence exposed. */ }
  console.log(JSON.stringify(result));
  return result;
}

function issueMirrorCell_(value) {
  var text = value == null ? '' : String(value);
  // Google Sheets cells allow 50,000 characters. Keep oversized issue bodies reviewable.
  if (text.length > 45000) text = text.slice(0, 45000) + '\n[Truncated; see issue_url for the full submission]';
  return /^\s*[=+\-@]/.test(text) ? "'" + text : text;
}

function runIssueMirror() {
  // Sharing the publisher's ScriptLock prevents two automation runs editing this book together.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { status: 'BUSY' };
  var stage = 'settings', httpStatus = null;
  try {
    var started = Date.now(), settings = issueMirrorSettings_();
    stage = 'sheet';
    var sheet = issueMirrorSheet_(settings);
    var properties = settings.properties;
    var since = properties.getProperty('ISSUE_MIRROR_SINCE') || '', changedDuringScan = false;
    var byNumber = Object.create(null), lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (values, i) {
        if (values[0] && !byNumber[String(values[0])]) byNumber[String(values[0])] = i + 2;
      });
    }
    for (var requests = 0; requests < 5 && Date.now() - started < 180000; requests++) {
      var url = ISSUE_MIRROR_FEED_URL + '?page=' + (requests + 1);
      if (since) url += '&since=' + encodeURIComponent(since);
      stage = 'fetch'; httpStatus = null;
      var response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Accept: 'application/json' },
        muteHttpExceptions: true,
        followRedirects: false
      });
      stage = 'response';
      var code = response.getResponseCode();
      httpStatus = Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
      if (httpStatus !== 200) throw new Error('Mirror upstream unavailable');
      stage = 'parse';
      var data = JSON.parse(response.getContentText()), issues = data && data.issues;
      if (!Array.isArray(issues) || typeof data.has_more !== 'boolean' || !issueMirrorValidWatermark_(data.source_latest_updated_at)) throw new Error('Invalid review feed response');
      // The raw-page watermark includes manual Issues and PRs removed by the feed filter.
      if (data.source_latest_updated_at !== null && Date.parse(data.source_latest_updated_at) >= started) changedDuringScan = true;
      stage = 'write';
      for (var i = 0; i < issues.length; i++) {
        if (Date.now() - started >= 180000) return { status: 'PARTIAL' };
        var issue = issues[i];
        if (!issue || issue.pull_request || typeof issue.body !== 'string' || issue.body.indexOf('<!-- freeegg-website-submission -->') < 0) continue;
        if (!Number.isSafeInteger(issue.number) || issue.number < 1 || ['open', 'closed'].indexOf(issue.state) < 0) throw new Error('Invalid issue metadata');
        var source = [issue.number, issueMirrorCell_(issue.html_url), issueMirrorCell_(issue.title), issueMirrorCell_(issue.created_at), issueMirrorCell_(issue.updated_at), issueMirrorCell_(issue.state), issueMirrorCell_(issue.body)];
        var rowNumber = byNumber[String(issue.number)];
        var mirroredAt = new Date(Date.now()).toISOString();
        if (rowNumber) {
          // Never write the editable review columns, even if a person edits them during fetch.
          sheet.getRange(rowNumber, 1, 1, 7).setValues([source]);
          sheet.getRange(rowNumber, 10).setValue(mirroredAt);
        } else {
          rowNumber = ++lastRow;
          sheet.getRange(rowNumber, 1, 1, ISSUE_MIRROR_HEADERS.length).setValues([source.concat(['PENDING', '', mirroredAt])]);
          byNumber[String(issue.number)] = rowNumber;
        }
      }
      // Failed or partial scans restart page one; mutable offset pages must not skip old rows.
      stage = 'flush'; SpreadsheetApp.flush();
      if (!data.has_more) {
        // Issues updated during this scan can move between pages. Reconcile again before advancing.
        if (changedDuringScan) return { status: 'PARTIAL' };
        // GitHub since is exclusive and timestamps have second resolution: overlap one second.
        stage = 'checkpoint'; properties.setProperty('ISSUE_MIRROR_SINCE', new Date(started - 1000).toISOString());
        return { status: 'COMPLETE' };
      }
    }
    // More than five upstream pages require manual reconciliation before advancing.
    // Keep the checkpoint unchanged until one entire scan finishes.
    return { status: 'PARTIAL' };
  } catch (_) {
    // Do not log GitHub response bodies, Sheet content, configuration values or credentials.
    var result = { status: 'RETRY', stage: stage, httpStatus: httpStatus };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function installIssueMirrorTrigger() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Automation busy; retry mirror installation');
  try {
    checkIssueMirrorConfiguration();
    ScriptApp.getProjectTriggers().filter(function (trigger) { return trigger.getHandlerFunction() === 'runIssueMirror'; }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
    ScriptApp.newTrigger('runIssueMirror').timeBased().everyMinutes(5).create();
  } finally { lock.releaseLock(); }
}

function stopIssueMirrorTrigger() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Automation busy; retry stopping the mirror');
  try {
    ScriptApp.getProjectTriggers().filter(function (trigger) { return trigger.getHandlerFunction() === 'runIssueMirror'; }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  } finally { lock.releaseLock(); }
}
