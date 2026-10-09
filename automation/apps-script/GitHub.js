/* GitHub REST atomic commits. Inject request/hash/decode for Node tests. */
var SyncGitHub = (function () {
  'use strict';
  function create(options) {
    function api(method, path, body, missing) {
      var response;
      try { response = options.request(method, path, body); } catch (_) { SyncCore.fail('GitHub transport unavailable', 'RETRY'); }
      var status = response.status;
      if (status >= 200 && status < 300) return response.data;
      if (status === 404 && missing) return null;
      if (status === 401 || status === 403) SyncCore.fail('GitHub permission denied; publisher paused', 'PERMISSION');
      if (status === 429 || status >= 500) SyncCore.fail('GitHub temporarily unavailable (HTTP ' + status + ')', 'RETRY');
      if (status === 409 || status === 422) SyncCore.fail('GitHub reference conflict (HTTP ' + status + ')', 'REF_CONFLICT');
      SyncCore.fail('GitHub request rejected (HTTP ' + status + ')', 'API_REJECTED');
    }
    function head() { return api('GET', '/git/ref/heads/main').object.sha; }
    function read(path, ref, optional) {
      var value = api('GET', '/contents/' + encodeURIComponent(path).replace(/%2F/g, '/') + '?ref=' + encodeURIComponent(ref), null, optional);
      if (!value) return null;
      if (value.type !== 'file' || value.encoding !== 'base64' || typeof value.sha !== 'string' || typeof value.content !== 'string') SyncCore.fail('Unsupported repository file response');
      return { sha: value.sha, text: options.decode(value.content) };
    }
    function json(file) { try { return JSON.parse(file.text); } catch (_) { SyncCore.fail('Invalid repository JSON'); } }
    function currentRules(ref) {
      return { grading_sha: read('docs/EGG_GRADING.md', ref).sha, content_sha: read('docs/CONTENT_GUIDE.md', ref).sha };
    }
    function verify(task, receipt, commit, receiptSha) {
      if (receipt.task_id !== task.task_id || receipt.payload_hash !== task.payload_hash) SyncCore.fail('Task ID already has different payload', 'CONFLICT');
      if (!Array.isArray(receipt.targets) || !receipt.targets.length || !receipt.blobShas || receipt.targets.indexOf(task.target) < 0) SyncCore.fail('Invalid repository receipt', 'CONFLICT');
      var allowed = [task.target]; if (task.operation === 'report.set') allowed.push('data/report-archive.json');
      try {
        var committedReceipt = read(task.receipt_path, commit);
        if (committedReceipt.sha !== receiptSha) SyncCore.fail('Receipt verification mismatch', 'VERIFY_PENDING');
        receipt.targets.forEach(function (path) {
          if (allowed.indexOf(path) < 0 || typeof receipt.blobShas[path] !== 'string') SyncCore.fail('Invalid receipt target', 'CONFLICT');
          if (read(path, commit).sha !== receipt.blobShas[path]) SyncCore.fail('Committed content verification mismatch', 'VERIFY_PENDING');
        });
      } catch (e) {
        if (e.code === 'PERMISSION' || e.code === 'CONFLICT') throw e;
        SyncCore.fail('Commit exists; readback verification pending', 'VERIFY_PENDING');
      }
      return { result: 'SUCCESS', commit_sha: commit, payload_hash: task.payload_hash, detail: 'Committed files and receipt verified' };
    }
    function recover(task, ref) {
      var file = read(task.receipt_path, ref, true); if (!file) return null;
      var receipt = json(file);
      if (receipt.task_id !== task.task_id || receipt.payload_hash !== task.payload_hash) SyncCore.fail('Task ID already has different payload', 'CONFLICT');
      var history = api('GET', '/commits?path=' + encodeURIComponent(task.receipt_path) + '&sha=' + encodeURIComponent(ref) + '&per_page=1');
      if (!history.length || !history[0].sha) SyncCore.fail('Receipt creator verification pending', 'VERIFY_PENDING');
      return verify(task, receipt, history[0].sha, file.sha);
    }
    function publish(task, mode, now) {
      if ((mode === 'TEST' && task.operation !== 'test.write') || (mode === 'PRODUCTION' && task.operation === 'test.write') || ['TEST', 'PRODUCTION'].indexOf(mode) < 0) SyncCore.fail('Operation is not allowed in this mode');
      for (var attempt = 0; attempt < 3; attempt++) {
        var ref = head();
        var rules = task.operation === 'test.write' ? {} : currentRules(ref);
        var recovered = recover(task, ref); if (recovered) return recovered;
        var paths = task.operation === 'test.write' ? [task.target] : ['data/eggs.json', 'data/reports.json', 'data/report-archive.json'];
        var files = {}, originalShas = {};
        paths.forEach(function (p) { var f = read(p, ref, task.operation === 'test.write'); originalShas[p] = f ? f.sha : null; files[p] = f ? (task.operation === 'test.write' ? f.text : json(f)) : null; });
        var changes = SyncCore.merge(task, files, rules, now), changedPaths = Object.keys(changes).sort();
        if (!changedPaths.length) return { result: 'NO_CHANGE', commit_sha: ref, payload_hash: task.payload_hash, detail: 'Current HEAD already contains desired values; no commit created' };
        var base = api('GET', '/git/commits/' + ref).tree.sha;
        var blobShas = {}, entries = [];
        changedPaths.forEach(function (p) {
          var sha = api('POST', '/git/blobs', { content: changes[p], encoding: 'utf-8' }).sha;
          blobShas[p] = sha; entries.push({ path: p, mode: '100644', type: 'blob', sha: sha });
        });
        var targets = task.operation === 'report.set' ? ['data/reports.json', 'data/report-archive.json'] : [task.target];
        targets.forEach(function (p) { if (!blobShas[p]) blobShas[p] = originalShas[p]; });
        var receipt = { version: 1, task_id: task.task_id, payload_hash: task.payload_hash, operation: task.operation, targets: targets, blobShas: blobShas, created_at: now };
        var receiptSha = api('POST', '/git/blobs', { content: JSON.stringify(receipt, null, 2) + '\n', encoding: 'utf-8' }).sha;
        entries.push({ path: task.receipt_path, mode: '100644', type: 'blob', sha: receiptSha });
        var tree = api('POST', '/git/trees', { base_tree: base, tree: entries }).sha;
        var commit = api('POST', '/git/commits', { message: 'Sheets publish ' + task.task_id, tree: tree, parents: [ref] }).sha;
        try { api('PATCH', '/git/refs/heads/main', { sha: commit, force: false }); }
        catch (e) {
          if (e.code === 'REF_CONFLICT') { if (attempt < 2) continue; SyncCore.fail('Concurrent main changes; retry later', 'RETRY'); }
          if (e.code === 'PERMISSION') throw e;
          // A lost HTTP response can hide a successful ref update. Recover before merging again.
          SyncCore.fail('Commit response uncertain; receipt verification pending', 'VERIFY_PENDING');
        }
        return verify(task, receipt, commit, receiptSha);
      }
      SyncCore.fail('Concurrent main changes; retry later', 'RETRY');
    }
    return { publish: publish, head: head, recover: recover };
  }
  return { create: create };
})();
