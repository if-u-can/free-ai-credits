'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const context = { console, Date, JSON, Object, Array, String, Number, Math, Error, RegExp, isFinite };
vm.createContext(context);
for (const file of ['Core.js', 'GitHub.js', 'Code.js']) {
  const filename = path.join(__dirname, '../automation/apps-script', file);
  if (fs.existsSync(filename)) vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
}
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const rules = { grading_sha: 'grading', content_sha: 'content' };
const evidence = { verified: true, urls: ['https://official.example/offer'], checked_at: '2026-10-09T00:00:00Z' };
function task(operation, target, payload, id = 'task-one') {
  return { task_id: id, operation, target, payload_json: JSON.stringify(payload), publish_at: '', review_status: 'APPROVED', reviewed_by: 'ChatGPT', reviewed_at: '2026-10-08T23:00:00Z', sync_status: 'PENDING', attempts: 0 };
}
const egg = { id: 'egg', name: 'API', type: '官方平台', description: 'Free API', status: 'active', grade: 'normal', credits: '$5', models: ['model'], requirements: 'email', discovered_at: '2026-10-09', verified_at: '2026-10-09', verification_note: 'verified', url: 'https://official.example/offer', official_source_url: 'https://official.example/offer', claim_url: 'https://official.example/signup', payment_required: 'no', source_type: 'official', grade_reason: 'small credits', quality_score: 40 };
const data = () => ({ 'data/eggs.json': { updated_at: '2026-10-08', eggs: [{ ...egg, future: { keep: true } }], unknown: 7 }, 'data/reports.json': { morning: null, evening: null, unknown: true }, 'data/report-archive.json': { entries: [{ id: 'old', kind: 'morning', date: '2026-10-08', title: 'old', unknown: 8 }], unknown: 'keep' } });
function parsed(t) { return context.SyncCore.parseTask(t, hash); }
function merge(t, files = data()) { return plain(context.SyncCore.merge(parsed(t), files, rules, '2026-10-09T01:00:00Z')); }

test('malformed JSON, missing fields, target mismatch and status grading fail before writes', () => {
  assert.ok(context.SyncCore, 'SyncCore is implemented');
  assert.throws(() => parsed({ ...task('egg.upsert', 'data/eggs.json', {}), payload_json: '{' }), /JSON/);
  assert.throws(() => parsed(task('egg.upsert', 'elsewhere', {})), /target/);
  assert.throws(() => merge(task('egg.upsert', 'data/eggs.json', { record: { id: 'new' }, expected: {}, rules, evidence })), /required/);
  assert.throws(() => merge(task('egg.upsert', 'data/eggs.json', { record: { id: 'egg', status: 'pending' }, expected: { status: 'active' }, rules, evidence })), /grade/);
  assert.throws(() => merge(task('egg.upsert', 'data/eggs.json', { record: { id: 'egg', grade: 'super' }, expected: { grade: 'normal' }, rules, evidence: { verified: false } })), /evidence/);
});
test('patch preserves unknown fields, requires expected, and is naturally no-op', () => {
  const t = task('egg.upsert', 'data/eggs.json', { record: { id: 'egg', description: 'Updated' }, expected: { description: 'Free API' }, rules, evidence });
  const changes = merge(t);
  const changed = JSON.parse(changes['data/eggs.json']);
  assert.equal(changed.unknown, 7); assert.deepEqual(changed.eggs[0].future, { keep: true });
  assert.throws(() => merge(t, { ...data(), 'data/eggs.json': { eggs: [{ ...egg, description: 'Someone else' }] } }), /conflict/);
  assert.throws(() => merge(task('egg.upsert', 'data/eggs.json', { record: { id: 'egg', description: 'Updated' }, expected: {}, rules, evidence })), /expected/);
  assert.deepEqual(merge(t, { ...data(), 'data/eggs.json': changed }), {});
  assert.throws(() => context.SyncCore.merge(parsed(t), data(), { ...rules, grading_sha: 'changed' }, '2026-10-09'), /rules/);
});
test('report latest and archive change atomically, preserve history and prevent date rollback', () => {
  const record = { date: '2026-10-09', title: 'Real report', summary: 'Verified', highlights: ['one'], tip: '' };
  const t = task('report.set', 'data/reports.json', { slot: 'morning', record, archive_id: '2026-10-09-morning', expected: null, completed: true, rules, evidence });
  const changes = merge(t);
  assert.deepEqual(Object.keys(changes).sort(), ['data/report-archive.json', 'data/reports.json']);
  const archive = JSON.parse(changes['data/report-archive.json']);
  assert.equal(archive.entries[0].unknown, 8); assert.equal(archive.unknown, 'keep'); assert.equal(archive.entries[1].id, '2026-10-09-morning');
  assert.throws(() => merge({ ...t, payload_json: JSON.stringify({ ...JSON.parse(t.payload_json), completed: false }) }), /completed/);
  assert.throws(() => merge(t, { ...data(), 'data/reports.json': { morning: { ...record, date: '2026-10-10' } } }), /date|conflict/);
});
test('archive deduplicates daily slots and super egg, and validates linked active super', () => {
  const record = { id: 'super-egg', kind: 'super', date: '2026-10-09', title: 'Super', summary: 'Verified', highlights: [], tip: '', egg_id: 'egg', official_source_url: egg.official_source_url, claim_url: egg.claim_url };
  const t = task('archive.upsert', 'data/report-archive.json', { record, expected: {}, completed: true, rules, evidence });
  assert.throws(() => merge(t), /super/);
  const files = data(); files['data/eggs.json'].eggs[0].grade = 'super';
  assert.equal(JSON.parse(merge(t, files)['data/report-archive.json']).entries.length, 2);
  files['data/report-archive.json'].entries.push({ ...record, id: 'different' });
  assert.throws(() => merge(t, files), /duplicate/);
});

// In-memory GitHub object database. All writes use the same REST routes as production.
function fakeGitHub() {
  let head = 'initial', seq = 0;
  const blobs = {}, trees = {}, commits = {}, requests = [];
  const initialFiles = { ...Object.fromEntries(Object.entries(data()).map(([p, v]) => [p, JSON.stringify(v, null, 2) + '\n'])), 'docs/EGG_GRADING.md': 'grading rules', 'docs/CONTENT_GUIDE.md': 'content rules', 'tests/automation-write-test.txt': 'before' };
  function blob(content) { const sha = hash(content); blobs[sha] = content; return sha; }
  function external(p, content) { const files = { ...commits[head].files, [p]: blob(content) }; const sha = 'external-' + (++seq); commits[sha] = { files, tree: 'tree-' + sha }; trees[commits[sha].tree] = files; head = sha; }
  commits[head] = { files: Object.fromEntries(Object.entries(initialFiles).map(([p, v]) => [p, blob(v)])), tree: 'tree-initial' }; trees['tree-initial'] = commits[head].files;
  let conflict = 0, lostResponse = false, verificationFailure = false, status = 0;
  const request = (method, route, body) => {
    requests.push({ method, route, body });
    if (status) return { status, data: { message: 'DO NOT LOG secret upstream response' } };
    if (method === 'GET' && route === '/git/ref/heads/main') return { status: 200, data: { object: { sha: head } } };
    if (method === 'GET' && route.startsWith('/git/commits/')) { const c = commits[route.slice('/git/commits/'.length)]; return { status: 200, data: { tree: { sha: c.tree } } }; }
    if (method === 'GET' && route.startsWith('/contents/')) {
      const [p, query] = route.slice('/contents/'.length).split('?'); const ref = decodeURIComponent(new URLSearchParams(query).get('ref')); const sha = commits[ref].files[decodeURIComponent(p)];
      if (verificationFailure && ref !== 'initial' && p.startsWith('automation/receipts/')) { verificationFailure = false; return { status: 503, data: {} }; }
      return sha ? { status: 200, data: { sha, content: Buffer.from(blobs[sha]).toString('base64'), encoding: 'base64', type: 'file' } } : { status: 404, data: {} };
    }
    if (method === 'GET' && route.startsWith('/commits?')) { const p = new URLSearchParams(route.split('?')[1]).get('path'); const creator = Object.entries(commits).filter(([_, c]) => c.files[p]).find(([sha, c]) => !c.parent || !commits[c.parent].files[p]); return { status: 200, data: creator ? [{ sha: creator[0] }] : [] }; }
    if (method === 'POST' && route === '/git/blobs') return { status: 201, data: { sha: blob(body.content) } };
    if (method === 'POST' && route === '/git/trees') { const sha = 'tree-' + (++seq); trees[sha] = { ...trees[body.base_tree] }; body.tree.forEach(e => { trees[sha][e.path] = e.sha; }); return { status: 201, data: { sha } }; }
    if (method === 'POST' && route === '/git/commits') { const sha = 'commit-' + (++seq); commits[sha] = { files: trees[body.tree], tree: body.tree, parent: body.parents[0] }; return { status: 201, data: { sha } }; }
    if (method === 'PATCH' && route === '/git/refs/heads/main') {
      assert.equal(body.force, false);
      if (conflict-- > 0) { external('other.json', 'someone else'); return { status: 409, data: {} }; }
      if (commits[body.sha].parent !== head) return { status: 422, data: {} };
      head = body.sha; if (lostResponse) { lostResponse = false; throw new Error('network secret'); } return { status: 200, data: {} };
    }
    throw new Error('Unexpected route ' + method + ' ' + route);
  };
  return { request, requests, external, get head() { return head; }, get content() { return Object.fromEntries(Object.entries(commits[head].files).map(([p,s]) => [p, blobs[s]])); }, set conflict(v) { conflict = v; }, set lostResponse(v) { lostResponse = v; }, set verificationFailure(v) { verificationFailure = v; }, set status(v) { status = v; } };
}
function client(fake) { return context.SyncGitHub.create({ request: fake.request, hash, decode: s => Buffer.from(s.replace(/\s/g, ''), 'base64').toString('utf8') }); }
function writeTask(content='after', expected='before', id='test-task') { return parsed(task('test.write', 'tests/automation-write-test.txt', { content, expected }, id)); }
test('transaction commits receipt, retries non-fast-forward, and preserves unrelated changes', () => {
  const fake = fakeGitHub(); fake.conflict = 1;
  const result = client(fake).publish(writeTask(), 'TEST', '2026-10-09T00:00:00Z');
  assert.equal(result.result, 'SUCCESS'); assert.equal(fake.content['other.json'], 'someone else'); assert.equal(fake.content['tests/automation-write-test.txt'], 'after');
  assert.equal(fake.requests.filter(r => r.method === 'PATCH').length, 2);
});
test('same receipt replay never rolls later updates back; different payload is rejected', () => {
  const fake = fakeGitHub(), github = client(fake); const first = github.publish(writeTask(), 'TEST', '2026-10-09T00:00:00Z');
  fake.external('tests/automation-write-test.txt', 'newer'); const calls = fake.requests.length;
  const replay = github.publish(writeTask(), 'TEST', '2026-10-09T01:00:00Z');
  assert.equal(replay.commit_sha, first.commit_sha); assert.equal(fake.content['tests/automation-write-test.txt'], 'newer');
  assert.equal(fake.requests.slice(calls).filter(r => r.method !== 'GET').length, 0);
  assert.throws(() => github.publish(writeTask('different'), 'TEST', '2026-10-09'), /different payload/);
});
test('ambiguous commit and failed readback recover using committed receipt without second write', () => {
  for (const failure of ['lostResponse', 'verificationFailure']) {
    const fake = fakeGitHub(); fake[failure] = true; const github = client(fake);
    assert.throws(() => github.publish(writeTask(), 'TEST', '2026-10-09'), e => e.code === 'VERIFY_PENDING');
    const patches = fake.requests.filter(r => r.method === 'PATCH').length;
    assert.equal(github.publish(writeTask(), 'TEST', '2026-10-09').result, 'SUCCESS');
    assert.equal(fake.requests.filter(r => r.method === 'PATCH').length, patches);
  }
});
test('test mode confines writes, checks expected and returns no change without commit', () => {
  const fake = fakeGitHub(); const github = client(fake);
  assert.throws(() => github.publish(writeTask('after', 'stale'), 'TEST', '2026-10-09'), /conflict/);
  assert.equal(github.publish(writeTask('before'), 'TEST', '2026-10-09').result, 'NO_CHANGE');
  assert.equal(fake.requests.filter(r => r.method === 'POST').length, 0);
  assert.throws(() => github.publish(parsed(task('egg.upsert','data/eggs.json',{})), 'TEST', '2026-10-09'), /mode/);
});
test('permission and rate failures expose only safe codes', () => {
  for (const [status, code] of [[401,'PERMISSION'],[403,'PERMISSION'],[429,'RETRY'],[503,'RETRY']]) {
    const fake = fakeGitHub(); fake.status = status;
    assert.throws(() => client(fake).publish(writeTask(), 'TEST', '2026-10-09'), e => e.code === code && !e.message.includes('secret'));
  }
});
test('queue idle performs no GitHub requests; scheduling, max three, duplicate IDs and permission stop', () => {
  assert.ok(context.SyncRunner, 'SyncRunner is implemented');
  const fake = fakeGitHub(), saved = {}, logs = [];
  const env = { now: () => Date.parse('2026-10-09T00:00:00Z'), mode: 'TEST', paused: false, hash, github: client(fake), getDone: id => saved[id], setDone: (id,v) => { saved[id]=v; }, save: () => {}, log: l => logs.push(l), pause: () => { env.paused = true; } };
  context.SyncRunner.run([], env); assert.equal(fake.requests.length, 0);
  const unapproved = task('test.write','tests/automation-write-test.txt',{},'unapproved'); unapproved.review_status = 'DRAFT';
  context.SyncRunner.run([unapproved],env); assert.equal(fake.requests.length,0);
  const t = task('test.write','tests/automation-write-test.txt',{content:'after', expected:'before'},'duplicate');
  context.SyncRunner.run([t,{...t}],env);
  context.SyncRunner.run([{...t,sync_status:'PENDING',payload_json:'{"content":"different","expected":"before"}'}],env);
  assert.equal(logs[0].result,'SYNCED'); assert.equal(logs[1].result,'SYNCED'); assert.equal(logs[2].result,'FAILED');
  assert.equal(fake.requests.filter(r=>r.method==='PATCH').length,1);
  const idleCalls=fake.requests.length; t.sync_status='PENDING'; context.SyncRunner.run([t],env); assert.equal(fake.requests.filter(r=>r.method==='PATCH').length,1);
  fake.status=403; const denied=task('test.write','tests/automation-write-test.txt',{content:'x',expected:'after'},'denied'); const after={...denied,task_id:'after-denied'};
  context.SyncRunner.run([denied,after],env); assert.equal(env.paused,true); assert.equal(denied.sync_status,'FAILED'); assert.equal(after.sync_status,'PENDING');
});
test('queue processes at most three, respects publish/retry times and time budget', () => {
  const fake = fakeGitHub(), logs=[], saved={}, rows=[]; let now=Date.parse('2026-10-09T00:00:00Z');
  const env={now:()=>now, mode:'TEST',paused:false,hash,github:client(fake),getDone:id=>saved[id],setDone:(id,v)=>saved[id]=v,save:()=>{},log:l=>logs.push(l),pause:()=>{env.paused=true;}};
  for(let i=0;i<4;i++) rows.push(task('test.write','tests/automation-write-test.txt',{content:'before',expected:'before'},'limit-'+i));
  const future={...rows[0],task_id:'future',publish_at:'2026-10-09T01:00:00Z'};
  const later={...rows[0],task_id:'later',next_attempt_at:'2026-10-09T01:00:00Z'};
  context.SyncRunner.run([future,later,...rows],env);
  assert.equal(logs.length,3); assert.equal(rows[3].sync_status,'PENDING'); assert.equal(future.sync_status,'PENDING'); assert.equal(later.sync_status,'PENDING');
  const before=fake.requests.length; env.now=()=>{now+=180000;return now;}; context.SyncRunner.run([rows[3]],env); assert.equal(fake.requests.length,before);
});
test('temporary API errors use scheduled exponential retry, exhaust five and never sleep', () => {
  const fake=fakeGitHub();fake.status=429;const logs=[];let now=Date.parse('2026-10-09T00:00:00Z');
  const env={now:()=>now,mode:'TEST',paused:false,hash,github:client(fake),getDone:()=>null,setDone:()=>{},save:()=>{},log:l=>logs.push(l),pause:()=>{env.paused=true;}};
  const row=task('test.write','tests/automation-write-test.txt',{content:'after',expected:'before'},'rate');
  for(let i=1;i<=5;i++) { context.SyncRunner.run([row],env);assert.equal(row.attempts,i); if(i<5){assert.equal(row.sync_status,'RETRY'); assert.equal(Date.parse(row.next_attempt_at)-now,60000*Math.pow(2,i-1)); now=Date.parse(row.next_attempt_at);} }
  assert.equal(row.sync_status,'FAILED');assert.equal(fake.requests.length,5); assert.equal(env.paused,false);
  row.sync_status='PENDING';context.SyncRunner.run([row],env);assert.equal(fake.requests.length,5);
});
test('different-payload duplicate rows fail before any network writes', () => {
  const fake=fakeGitHub(),logs=[];const env={now:()=>Date.parse('2026-10-09T00:00:00Z'),mode:'TEST',paused:false,hash,github:client(fake),getDone:()=>null,setDone:()=>{},save:()=>{},log:l=>logs.push(l),pause:()=>{env.paused=true;}};
  const first=task('test.write','tests/automation-write-test.txt',{content:'after',expected:'before'},'ambiguous');
  const second={...first,payload_json:JSON.stringify({content:'different',expected:'before'})};
  context.SyncRunner.run([first,second],env);assert.equal(first.sync_status,'FAILED');assert.equal(second.sync_status,'FAILED');assert.equal(fake.requests.length,0);
});
test('no-change ledger replay cannot undo a later update and changed payload is rejected', () => {
  const fake=fakeGitHub(),saved={},logs=[];const env={now:()=>Date.parse('2026-10-09T00:00:00Z'),mode:'TEST',paused:false,hash,github:client(fake),getDone:id=>saved[id],setDone:(id,v)=>saved[id]=v,save:()=>{},log:l=>logs.push(l),pause:()=>{env.paused=true;}};
  const row=task('test.write','tests/automation-write-test.txt',{content:'before',expected:'before'},'nochange');context.SyncRunner.run([row],env);
  fake.external('tests/automation-write-test.txt','later');row.sync_status='PENDING';context.SyncRunner.run([row],env);assert.equal(row.sync_status,'NO_CHANGE');assert.equal(fake.content['tests/automation-write-test.txt'],'later');
  row.sync_status='PENDING';row.payload_json=JSON.stringify({content:'other',expected:'later'});context.SyncRunner.run([row],env);assert.equal(row.sync_status,'FAILED');assert.equal(fake.requests.filter(r=>r.method==='POST').length,0);
});
test('atomic report receipt verifies latest even when only archive required a change', () => {
  const fake=fakeGitHub();const record={date:'2026-10-09',title:'Real report',summary:'Verified',highlights:['one'],tip:''};
  fake.external('data/reports.json',JSON.stringify({morning:record,evening:null}));
  const actualRules={grading_sha:hash('grading rules'),content_sha:hash('content rules')};
  const t=parsed(task('report.set','data/reports.json',{slot:'morning',record,archive_id:'2026-10-09-morning',expected:record,completed:true,rules:actualRules,evidence}));
  const result=client(fake).publish(t,'PRODUCTION','2026-10-09T00:00:00Z');assert.equal(result.result,'SUCCESS');
  const receipt=JSON.parse(fake.content[t.receipt_path]);assert.deepEqual(receipt.targets,['data/reports.json','data/report-archive.json']);
  assert.equal(client(fake).publish(t,'PRODUCTION','2026-10-09T01:00:00Z').commit_sha,result.commit_sha);
});
test('conflict rereads current same-field change without overwriting, and retries stop after three refs', () => {
  const fake=fakeGitHub(),original=fake.request;let once=true;
  fake.request=(method,route,body)=>{if(once&&method==='PATCH'){once=false;fake.external('tests/automation-write-test.txt','someone else');return {status:422,data:{}};}return original(method,route,body);};
  assert.throws(()=>client(fake).publish(writeTask(),'TEST','2026-10-09'),/conflict/);assert.equal(fake.content['tests/automation-write-test.txt'],'someone else');
  const busy=fakeGitHub();busy.conflict=10;assert.throws(()=>client(busy).publish(writeTask(),'TEST','2026-10-09'),e=>e.code==='RETRY');assert.equal(busy.requests.filter(r=>r.method==='PATCH').length,3);
});
test('historical super correction is allowed while new inactive super publication is rejected', () => {
  const files=data();files['data/eggs.json'].eggs[0]={...egg,status:'expired',grade:null};
  const old={id:'super-old',kind:'super',date:'2026-10-08',title:'Old',summary:'Old offer',highlights:[],tip:'',egg_id:'egg',official_source_url:egg.official_source_url,claim_url:egg.claim_url,status:'active'};
  files['data/report-archive.json'].entries.push(old);
  const t=task('archive.upsert','data/report-archive.json',{record:{id:old.id,kind:'super',date:old.date,status:'expired'},expected:{status:'active'},completed:true,rules,evidence});
  assert.equal(JSON.parse(merge(t,files)['data/report-archive.json']).entries[1].status,'expired');
  assert.throws(()=>merge(task('archive.upsert','data/report-archive.json',{record:{...old,id:'new-super',status:'expired'},expected:{},completed:true,rules,evidence}),files),/duplicate|super/);
});
function nativeMocks(rows = [], faults = {}) {
  const props={GITHUB_TOKEN:'private-token-never-log',SPREADSHEET_ID:'book-id',MODE:'TEST',PAUSED:'false'}, writes=[],printed=[];
  const queueValues=[plain(context.SYNC_QUEUE_HEADERS),...rows.map(row=>context.SYNC_QUEUE_HEADERS.map(k=>row[k]??''))],logValues=[plain(context.SYNC_LOG_HEADERS)];
  let setCalls=0;
  function sheet(values){return {getLastRow:()=>values.length,getRange:(r,c,n=1,m=1)=>({getValues:()=>values.slice(r-1,r-1+n).map(row=>row.slice(c-1,c-1+m)),setValue:value=>{
    setCalls++;if(faults.saveAt===setCalls){delete faults.saveAt;throw new Error('Transient Sheets save secret');}
    if(faults.finalStatus&&c===7&&value==='SYNCED'){delete faults.finalStatus;throw new Error('Transient final status');}
    writes.push([r,c,value]);values[r-1][c-1]=value;
  }}),appendRow:row=>{
    if(faults.logBefore){delete faults.logBefore;throw new Error('Transient Sheets log secret');}
    values.push(plain(row));if(faults.logAfter){delete faults.logAfter;throw new Error('Ambiguous append secret');}
  }};}
  const queue=sheet(queueValues),log=sheet(logValues),triggers=[{getHandlerFunction:()=> 'runSync'},{getHandlerFunction:()=> 'unrelated'}];let locked=false,fetches=0;
  context.PropertiesService={getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=v;}})};
  context.SpreadsheetApp={openById:id=>({getSheetByName:name=>name==='待发布队列'?queue:name==='发布日志'?log:null}),flush:()=>{if(faults.flush){delete faults.flush;throw new Error('Transient flush secret');}}};
  context.LockService={getScriptLock:()=>({tryLock:()=>{if(locked)return false;locked=true;return true;},releaseLock:()=>{locked=false;}})};
  context.ScriptApp={getProjectTriggers:()=>triggers.slice(),deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),newTrigger:handler=>({timeBased:()=>({everyMinutes:n=>({create:()=>{assert.equal(n,1);triggers.push({getHandlerFunction:()=>handler});}})})})};
  context.Utilities={DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,s)=>[...crypto.createHash('sha256').update(s).digest()].map(n=>n>127?n-256:n),base64Decode:s=>Buffer.from(s,'base64'),newBlob:b=>({getDataAsString:()=>b.toString('utf8')})};
  context.UrlFetchApp={fetch:()=>{fetches++;throw new Error('Unexpected real request');}};
  context.console={log:s=>printed.push(s)};
  return {props,writes,printed,triggers,queueValues,logValues,get fetches(){return fetches;},get locked(){return locked;}};
}
test('native configuration, local smoke tests, unique trigger and stop preserve token privacy',()=>{
  const native=nativeMocks();assert.equal(context.checkConfiguration().mode,'TEST');assert.equal(context.runSelfTests().passed,2);
  context.installMinuteTrigger();context.installMinuteTrigger();assert.equal(native.triggers.filter(t=>t.getHandlerFunction()==='runSync').length,1);
  delete native.props.GITHUB_TOKEN;assert.throws(()=>context.installMinuteTrigger(),/Set GITHUB_TOKEN/);assert.equal(native.triggers.length,2);
  native.props.GITHUB_TOKEN='private-token-never-log';native.props.MODE='PRODUCTION';assert.throws(()=>context.checkConfiguration(),/acceptance/);
  native.props.PRODUCTION_READY='A,B,C';assert.equal(context.checkConfiguration().mode,'PRODUCTION');context.stopSync();assert.equal(native.props.PAUSED,'true');assert.equal(native.triggers.length,1);assert.equal(native.triggers[0].getHandlerFunction(),'unrelated');
  assert.equal(native.fetches,0);assert.equal(native.printed.join(' ').includes('private-token-never-log'),false);assert.equal(native.locked,false);
});
test('native idle, paused and invalid JSON paths never fetch GitHub and preserve original payload',()=>{
  let native=nativeMocks();context.runSync();assert.equal(native.fetches,0);assert.equal(native.locked,false);
  const row=task('test.write','tests/automation-write-test.txt',{},'invalid-json');row.payload_json='{';native=nativeMocks([row]);context.runSync();
  assert.equal(native.fetches,0);assert.equal(native.queueValues[1][3],'{');assert.equal(native.queueValues[1][6],'FAILED');assert.equal(native.logValues[1][4],'FAILED');assert.equal(native.locked,false);
  native=nativeMocks([row]);native.props.PAUSED='true';context.runSync();assert.equal(native.writes.length,0);assert.equal(native.fetches,0);
});
test('approved queue requires actual reviewed_at and refuses future audit timestamps',()=>{
  for(const reviewed_at of ['', 'not-time','2026-10-09T01:00:00Z']) {
    const fake=fakeGitHub(),row={...task('test.write','tests/automation-write-test.txt',{content:'after',expected:'before'}),reviewed_at};
    const env={now:()=>Date.parse('2026-10-09T00:00:00Z'),mode:'TEST',paused:false,hash,github:client(fake),getDone:()=>null,setDone:()=>{},save:()=>{},log:()=>{},pause:()=>{}};
    context.SyncRunner.run([row],env);assert.equal(row.sync_status,'FAILED');assert.equal(fake.requests.length,0);
  }
});
test('record IDs, quality breakdown caps and totals, history retention and Beijing dates',()=>{
  const p={record:{id:'egg',description:'changed'},expected:{description:egg.description},rules,evidence};
  const t=task('egg.upsert','data/eggs.json',p);
  assert.equal(JSON.parse(merge(t)['data/eggs.json']).updated_at,'2026-10-09');
  assert.equal(JSON.parse(context.SyncCore.merge(parsed(t),data(),rules,'2026-10-08T23:00:00Z')['data/eggs.json']).updated_at,'2026-10-09');
  for(const id of [1,{},'  '])assert.throws(()=>merge(task('egg.upsert','data/eggs.json',{...p,record:{id}})),/id/);
  const score={free_api_value:20,model_usefulness:10,claim_convenience:5,validity_and_limits:5};
  const qualityTask=task('egg.upsert','data/eggs.json',{record:{id:'egg',quality_breakdown:score},expected:{quality_breakdown:null},rules,evidence});
  assert.ok(merge(qualityTask));
  for(const quality_breakdown of [{...score,free_api_value:36},{...score,model_usefulness:26},{...score,claim_convenience:26},{...score,validity_and_limits:16},{...score,free_api_value:19},{...score,free_api_value:'20'}])assert.throws(()=>merge(task('egg.upsert','data/eggs.json',{record:{id:'egg',quality_breakdown},expected:{quality_breakdown:null},rules,evidence})),/quality/);
  const files=data();files['data/eggs.json'].eggs[0].review_history=[{date:'2026-10-08',result:'Actual prior review',unknown:1}];
  assert.throws(()=>merge(task('egg.upsert','data/eggs.json',{record:{id:'egg',review_history:[]},expected:{review_history:files['data/eggs.json'].eggs[0].review_history},rules,evidence}),files),/history/);
  const prior=files['data/eggs.json'].eggs[0].review_history;
  const appended=[...prior,{date:'2026-10-09',result:'New actual review'}];
  const appendedEgg=JSON.parse(merge(task('egg.upsert','data/eggs.json',{record:{id:'egg',review_history:appended},expected:{review_history:prior},rules,evidence}),files)['data/eggs.json']).eggs[0];assert.deepEqual(appendedEgg.review_history,appended);
  files['data/eggs.json'].eggs[0].quality_breakdown={...score,unknown:'keep'};
  const quality=JSON.parse(merge(task('egg.upsert','data/eggs.json',{record:{id:'egg',quality_breakdown:{...score,free_api_value:21},quality_score:41},expected:{quality_breakdown:files['data/eggs.json'].eggs[0].quality_breakdown,quality_score:40},rules,evidence}),files)['data/eggs.json']).eggs[0];assert.equal(quality.quality_breakdown.unknown,'keep');
});
test('pause during a running batch prevents publishing the next task',()=>{
  const fake=fakeGitHub();let stopped=false;const logs=[];
  const env={now:()=>Date.parse('2026-10-09T00:00:00Z'),mode:'TEST',paused:false,hash,github:client(fake),getDone:()=>null,setDone:()=>{},save:()=>{},log:l=>{logs.push(l);stopped=true;},pause:()=>{},isPaused:()=>stopped};
  const rows=[task('test.write','tests/automation-write-test.txt',{content:'before',expected:'before'},'stop-first'),task('test.write','tests/automation-write-test.txt',{content:'after',expected:'before'},'stop-next')];
  context.SyncRunner.run(rows,env);assert.equal(logs.length,1);assert.equal(rows[1].sync_status,'PENDING');
});
function attachNativeGitHub(fake) {
  context.UrlFetchApp.fetch=(url,options)=>{
    const uri=new URL(url),route=uri.pathname.replace('/repos/if-u-can/free-ai-credits','')+uri.search;
    const response=fake.request(options.method.toUpperCase(),route,options.payload?JSON.parse(options.payload):null);
    return {getResponseCode:()=>response.status,getContentText:()=>JSON.stringify(response.data)};
  };
}
test('native transient metadata save failure recovers real commit before terminal status',()=>{
  const fake=fakeGitHub(),row=task('test.write','tests/automation-write-test.txt',{content:'after',expected:'before'},'save-failure');
  const native=nativeMocks([row],{saveAt:2});attachNativeGitHub(fake);
  assert.doesNotThrow(()=>context.runSync());assert.notEqual(native.queueValues[1][6],'SYNCED');assert.equal(fake.content['tests/automation-write-test.txt'],'after');assert.equal(native.locked,false);
  context.runSync();assert.equal(native.queueValues[1][6],'SYNCED');assert.ok(native.queueValues[1][10]);assert.equal(native.logValues.length,2);assert.equal(fake.requests.filter(r=>r.method==='PATCH').length,1);
  const statusWrites=native.writes.filter(([r,c,v])=>r===2&&c===7&&v==='SYNCED');assert.equal(statusWrites.length,1);
});
test('native log and final-status failures leave recoverable state and deduplicate the restored log',()=>{
  for(const fault of ['logBefore','logAfter','finalStatus','flush']) {
    const fake=fakeGitHub(),row=task('test.write','tests/automation-write-test.txt',{content:'after',expected:'before'},'log-failure-'+fault);
    const native=nativeMocks([row],{[fault]:true});attachNativeGitHub(fake);
    assert.doesNotThrow(()=>context.runSync());assert.notEqual(native.queueValues[1][6],'SYNCED');assert.ok(native.queueValues[1][10]);
    context.runSync();assert.equal(native.queueValues[1][6],'SYNCED');assert.equal(native.logValues.length,2);assert.equal(native.logValues[1][3],native.queueValues[1][10]);assert.equal(fake.requests.filter(r=>r.method==='PATCH').length,1);
    assert.equal(native.logValues.some(r=>r.join(' ').includes('secret')),false);
    native.queueValues[1][6]='PENDING';context.runSync();assert.equal(native.logValues.length,2);assert.equal(fake.requests.filter(r=>r.method==='PATCH').length,1);
  }
});
test('confirmed commit with five attempts restores only its Sheet journal without more GitHub writes',()=>{
  const fake=fakeGitHub(),row=task('test.write','tests/automation-write-test.txt',{content:'after',expected:'before'},'journal-at-limit');row.attempts=4;
  const native=nativeMocks([row],{finalStatus:true});attachNativeGitHub(fake);context.runSync();
  assert.equal(native.queueValues[1][6],'VERIFY_PENDING');assert.equal(native.queueValues[1][8],5);assert.ok(native.queueValues[1][10]);
  const calls=fake.requests.length;context.runSync();assert.equal(native.queueValues[1][6],'SYNCED');assert.equal(native.logValues.length,2);
  assert.equal(fake.requests.slice(calls).some(r=>r.method!=='GET'),false);assert.equal(fake.requests.filter(r=>r.method==='PATCH').length,1);
});
