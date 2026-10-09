/* Pure validation and field-level merging. No network or Apps Script services. */
var SyncCore = (function () {
  'use strict';
  var PATHS = { 'egg.upsert': 'data/eggs.json', 'report.set': 'data/reports.json', 'archive.upsert': 'data/report-archive.json', 'test.write': 'tests/automation-write-test.txt' };
  function fail(message, code) { var e = new Error(message); e.code = code || 'INVALID'; throw e; }
  function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (object(v)) return '{' + Object.keys(v).sort().map(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') fail('Invalid object key');
      return JSON.stringify(k) + ':' + canonical(v[k]);
    }).join(',') + '}';
    return JSON.stringify(v);
  }
  function equal(a, b) { return canonical(a === undefined ? null : a) === canonical(b === undefined ? null : b); }
  function copy(v) { return JSON.parse(JSON.stringify(v)); }
  function required(v, fields) { fields.forEach(function (k) { if (v[k] === undefined || v[k] === null || v[k] === '') fail('required field: ' + k); }); }
  function id(v) { if (typeof v !== 'string' || !v.trim() || v.length > 200 || /[\r\n]/.test(v)) fail('Invalid record id'); }
  function beijingDate(now) { return new Date(Date.parse(now) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
  function date(v) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) fail('Invalid date'); }
  function timestamp(v, label) { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || !/(Z|[+-]\d{2}:\d{2})$/.test(v) || isNaN(Date.parse(v))) fail('Invalid ' + label); return new Date(v).toISOString(); }
  function url(v) { return typeof v === 'string' && /^https:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/.test(v); }
  function parseTask(row, hash) {
    required(row, ['task_id', 'operation', 'target', 'payload_json']);
    id(row.task_id);
    if (!PATHS[row.operation] || row.target !== PATHS[row.operation]) fail('Invalid operation or target');
    var payload;
    try { payload = JSON.parse(row.payload_json); } catch (_) { fail('Invalid payload JSON'); }
    if (!object(payload)) fail('payload JSON must be an object');
    var publish = row.publish_at ? timestamp(row.publish_at, 'publish_at') : '';
    var task = { task_id: row.task_id, operation: row.operation, target: row.target, payload: payload, publish_at: publish };
    task.payload_hash = hash(canonical({ operation: task.operation, target: task.target, payload: payload, publish_at: publish }));
    task.receipt_path = 'automation/receipts/' + hash(task.task_id) + '.json';
    return task;
  }
  function validateEvidence(payload, currentRules) {
    if (!object(payload.rules) || payload.rules.grading_sha !== currentRules.grading_sha || payload.rules.content_sha !== currentRules.content_sha) fail('Repository rules changed; review again', 'RULES_CHANGED');
    var e = payload.evidence;
    if (!object(e) || e.verified !== true || !Array.isArray(e.urls) || !e.urls.length || !e.urls.every(url)) fail('Verified official evidence required');
    timestamp(e.checked_at, 'evidence.checked_at');
  }
  function patch(current, desired, expected, identity) {
    if (!object(desired) || !object(expected)) fail('record and expected objects required');
    var out = copy(current || {}), changed = false;
    Object.keys(desired).forEach(function (key) {
      if (key === identity) return;
      var value = desired[key];
      if (key === 'quality_breakdown' && object(value) && object(out[key])) value = Object.assign({}, out[key], value);
      if (key === 'review_history') {
        if (!Array.isArray(value)) fail('review_history must be an array');
        if (Array.isArray(out[key]) && (value.length < out[key].length || !out[key].every(function (old, index) { return equal(old, value[index]); }))) fail('review_history must preserve prior entries');
      }
      if (equal(out[key], value)) return;
      if (current && !Object.prototype.hasOwnProperty.call(expected, key)) fail('expected value required for ' + key);
      if (current && !equal(out[key], expected[key])) fail('Field conflict: ' + key, 'CONFLICT');
      out[key] = copy(value); changed = true;
    });
    if (!current && identity) out[identity] = desired[identity];
    return { record: out, changed: changed || !current };
  }
  function unique(records, key, value) { var found = records.filter(function (r) { return r[key] === value; }); if (found.length > 1) fail('Repository duplicate ' + key, 'CONFLICT'); return found[0] || null; }
  function validateEgg(r) {
    id(r.id);
    required(r, ['id', 'name', 'type', 'description', 'status', 'credits', 'models', 'requirements', 'discovered_at', 'verification_note', 'url', 'official_source_url', 'payment_required', 'source_type', 'grade_reason', 'quality_score']);
    if (['active', 'pending', 'expired', 'unverifiable', 'excluded'].indexOf(r.status) < 0) fail('Invalid status');
    if (r.status !== 'active' && r.grade !== null) fail('Non-active egg grade must be null');
    if (r.status === 'active') {
      if (['super', 'premium', 'normal'].indexOf(r.grade) < 0) fail('Active egg grade required');
      required(r, ['verified_at', 'claim_url']); date(r.verified_at);
      if (!url(r.claim_url)) fail('Valid claim_url required');
    }
    if (!Array.isArray(r.models) || !r.models.length || !r.models.every(function (m) { return typeof m === 'string' && m.trim(); })) fail('models array required');
    if (typeof r.quality_score !== 'number' || !isFinite(r.quality_score) || r.quality_score < 0 || r.quality_score > 100) fail('Invalid quality_score');
    if (r.quality_breakdown !== undefined) {
      if (!object(r.quality_breakdown)) fail('Invalid quality_breakdown');
      var caps = { free_api_value: 35, model_usefulness: 25, claim_convenience: 25, validity_and_limits: 15 }, total = 0;
      Object.keys(caps).forEach(function (key) { var n = r.quality_breakdown[key]; if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > caps[key]) fail('Invalid quality_breakdown: ' + key); total += n; });
      if (total !== r.quality_score) fail('quality_breakdown sum must equal quality_score');
    }
    date(r.discovered_at); if (!url(r.url) || !url(r.official_source_url)) fail('Official URLs required');
  }
  function validateReport(r) {
    required(r, ['date', 'title', 'summary']); date(r.date);
    if (!Array.isArray(r.highlights) || !r.highlights.every(function (x) { return typeof x === 'string'; }) || typeof r.tip !== 'string' || typeof r.title !== 'string' || typeof r.summary !== 'string') fail('Report highlights and tip required');
  }
  function archiveMerge(archive, record, expected, eggs, completed) {
    if (!Array.isArray(archive.entries)) fail('Archive entries required');
    required(record, ['id', 'kind']);
    id(record.id);
    if (['morning', 'evening', 'super'].indexOf(record.kind) < 0) fail('Invalid archive kind');
    var current = unique(archive.entries, 'id', record.id);
    if (current && (record.kind !== current.kind || (record.date && record.date !== current.date) || (record.egg_id && record.egg_id !== current.egg_id))) fail('Archive identity conflict', 'CONFLICT');
    var merged = patch(current, record, expected, 'id');
    var r = merged.record; validateReport(r);
    if (completed !== true) fail('completed:true required for report publication');
    var duplicate = archive.entries.some(function (e) { return e.id !== r.id && (r.kind === 'super' ? e.kind === 'super' && e.egg_id === r.egg_id : e.kind === r.kind && e.date === r.date); });
    if (duplicate) fail('Archive duplicate date/kind or egg_id', 'CONFLICT');
    if (r.kind === 'super') {
      required(r, ['egg_id', 'official_source_url', 'claim_url']);
      var linked = unique(eggs.eggs, 'id', r.egg_id);
      var historicalCorrection = current && ['expired', 'unverifiable', 'excluded'].indexOf(r.status) >= 0 && linked && r.status === linked.status;
      if (!historicalCorrection && (!linked || linked.status !== 'active' || linked.grade !== 'super')) fail('Linked egg must be active + super');
      if (!url(r.official_source_url) || !url(r.claim_url)) fail('Super official URLs required');
    }
    if (merged.changed) { if (current) archive.entries[archive.entries.indexOf(current)] = r; else archive.entries.push(r); }
    return merged.changed;
  }
  function merge(task, input, currentRules, now) {
    var p = task.payload, files = copy(input), changes = {};
    if (task.operation === 'test.write') {
      if (typeof p.content !== 'string' || !Object.prototype.hasOwnProperty.call(p, 'expected') || (p.expected !== null && typeof p.expected !== 'string')) fail('content and expected required');
      var text = files[task.target] === undefined ? null : files[task.target];
      if (text === p.content) return changes;
      if (text !== p.expected) fail('Test file conflict', 'CONFLICT');
      changes[task.target] = p.content; return changes;
    }
    validateEvidence(p, currentRules);
    if (!object(p.record)) fail('record required');
    if (task.operation === 'egg.upsert') {
      required(p.record, ['id']); id(p.record.id); var eggs = files[task.target];
      if (!eggs || !Array.isArray(eggs.eggs)) fail('Repository eggs array required');
      var old = unique(eggs.eggs, 'id', p.record.id); var m = patch(old, p.record, p.expected, 'id'); validateEgg(m.record);
      if (m.changed) { if (old) eggs.eggs[eggs.eggs.indexOf(old)] = m.record; else eggs.eggs.push(m.record); changes[task.target] = eggs; }
    } else if (task.operation === 'archive.upsert') {
      if (archiveMerge(files[task.target], p.record, p.expected, files['data/eggs.json'], p.completed)) changes[task.target] = files[task.target];
    } else if (task.operation === 'report.set') {
      if (['morning', 'evening'].indexOf(p.slot) < 0) fail('Invalid slot');
      required(p, ['archive_id']); id(p.archive_id); validateReport(p.record); if (p.completed !== true) fail('completed:true required');
      var reports = files[task.target], previous = reports[p.slot] || null;
      if (previous && previous.date && p.record.date < previous.date) fail('Latest report date cannot go backwards', 'CONFLICT');
      var desired = Object.assign({}, previous || {}, p.record);
      if (!equal(previous, desired) && !equal(previous, p.expected)) fail('Report slot conflict', 'CONFLICT');
      if (!equal(previous, desired)) { reports[p.slot] = desired; changes[task.target] = reports; }
      var ar = Object.assign({}, p.record, { id: p.archive_id, kind: p.slot });
      var archive = files['data/report-archive.json'];
      if (archiveMerge(archive, ar, p.expected || {}, files['data/eggs.json'], p.completed)) changes['data/report-archive.json'] = archive;
    }
    Object.keys(changes).forEach(function (path) { if (path !== 'data/reports.json') changes[path].updated_at = beijingDate(now); changes[path] = JSON.stringify(changes[path], null, 2) + '\n'; });
    return changes;
  }
  return { parseTask: parseTask, canonical: canonical, equal: equal, merge: merge, fail: fail, timestamp: timestamp, paths: PATHS };
})();
