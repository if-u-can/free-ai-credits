'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, NAMES } = require('./google-community-fixture.cjs');

test('explicit setup reuses the existing book; health cannot create or fake storage', () => {
  const h = harness(); assert.ok(h.context.CommunityVotes);
  assert.equal(h.post(h.payload('health')).available, false);
  assert.equal(h.database.sheets.size, 0);
  h.install(); h.context.setupCommunityVotes();
  assert.deepEqual([...h.database.sheets.keys()], NAMES);
  assert.equal(h.post(h.payload('health')).available, true);
});
test('tampered signature, stale time, invalid action and lock contention never write votes', () => {
  const h = harness(); h.install();
  assert.equal(h.post(h.payload('vote'), value => { value.signature = 'forged'; }).available, false);
  assert.equal(h.post(h.payload('stats', { timestamp: 0 })).available, false);
  assert.equal(h.post(h.payload('resolve')).available, false);
  h.setBusy(true); const busy = h.vote('one'); assert.equal(busy.status, 503); assert.equal(busy.code, 'busy');
  assert.equal(h.database.sheets.get('社区投票').getLastRow(), 1);
});
test('one persistent ballot per network survives script recreation, supports change and same-vote replay', () => {
  const h = harness(); h.install();
  assert.equal(h.vote('one', 'good').egg.good, 1);
  assert.equal(h.vote('one', 'good').egg.good, 1);
  const changed = h.vote('one', 'bad'); assert.equal(changed.egg.good, 0); assert.equal(changed.egg.bad, 1);
  const recreated = harness(h.database); const result = recreated.post(recreated.payload('stats', { voterHash: h.hash('one') }));
  assert.equal(result.eggs['egg-one'].myVote, 'bad'); assert.equal(result.eggs['egg-one'].bad, 1);
  assert.equal(h.database.sheets.get('社区投票').getLastRow(), 2);
});
test('request replay does not consume quota or overwrite a newer choice; changed request ID payload is rejected', () => {
  const h = harness(); h.install(); const first = h.payload('vote', { eggId: 'egg-one', vote: 'good' });
  h.post(first); h.vote('one', 'bad');
  const replay = h.post(first); assert.equal(replay.egg.myVote, 'bad'); assert.equal(replay.egg.bad, 1);
  assert.equal(h.post({ ...first, vote: 'bad' }).available, false);
  for (let i = 0; i < 18; i++) assert.equal(h.vote('one', 'bad').available, true);
  assert.equal(h.vote('one', 'good').status, 429);
  h.advance(60000); assert.equal(h.vote('one', 'good').available, true);
});
test('partial vote write reconciles review on stats and retry without another ballot or rate hit', () => {
  const h = harness(); h.install(); h.vote('one'); h.vote('two');
  const third = h.payload('vote', { voterHash: h.hash('three'), eggId: 'egg-one', vote: 'bad' });
  let failed = false;
  h.database.fail = (sheet, rows) => sheet === '社区复核' && rows[0]?.[3] === true && !failed ? (failed = true) : false;
  assert.equal(h.post(third).available, false);
  assert.equal(h.database.sheets.get('社区投票').getLastRow(), 4);
  h.database.fail = null;
  assert.equal(h.post(h.payload('stats')).eggs['egg-one'].reviewPending, true);
  assert.equal(h.post(third).egg.bad, 3);
  assert.equal(h.database.sheets.get('社区投票').getLastRow(), 4);
});
test('rate journal accepted before ballot failure resumes on retry and lost flush cannot duplicate vote', () => {
  const h = harness(); h.install(); const value = h.payload('vote', { eggId: 'egg-one', vote: 'good' });
  let failed = false; h.database.fail = sheet => sheet === '社区投票' && !failed ? (failed = true) : false;
  assert.equal(h.post(value).available, false); h.database.fail = null;
  assert.equal(h.post(value).egg.good, 1);
  failed = false; h.database.fail = sheet => sheet === 'flush' && !failed ? (failed = true) : false;
  const second = h.payload('vote', { voterHash: h.hash('two'), eggId: 'egg-one', vote: 'good' });
  assert.equal(h.post(second).available, false); h.database.fail = null;
  assert.equal(h.post(second).egg.good, 2);
});
test('three bad below sixty percent do not queue; null identity only reads public confirmed totals', () => {
  const h = harness(); h.install(); for (let i = 0; i < 3; i++) h.vote('good-' + i, 'good');
  for (let i = 0; i < 3; i++) h.vote('bad-' + i);
  const result = h.post(h.payload('stats', { voterHash: null })).eggs['egg-one'];
  assert.equal(result.good, 3); assert.equal(result.bad, 3); assert.equal(result.myVote, null); assert.equal(result.reviewPending, false);
  assert.equal(h.vote('bad-four').egg.reviewPending, false);
  assert.equal(h.vote('bad-five').egg.reviewPending, true);
});
test('manual evidence-backed resolution advances generation and baseline; stale resolution cannot clear new review', () => {
  const h = harness(); h.install(); ['a', 'b', 'c'].forEach(id => h.vote(id));
  const resolution = { resolutionId: 'review-one', eggId: 'egg-one', expectedGeneration: 0, outcome: 'confirmed', evidenceUrl: 'https://official.example/offer', notes: 'Read current grading/content rules and verified current official terms.', verifiedAt: '2026-10-09' };
  assert.equal(h.context.resolveCommunityReview(resolution).generation, 1);
  assert.equal(h.context.resolveCommunityReview(resolution).generation, 1);
  h.vote('a'); h.vote('b', 'good'); h.vote('b');
  assert.equal(h.post(h.payload('stats')).eggs['egg-one'].reviewPending, false);
  h.vote('d'); h.vote('e'); assert.equal(h.vote('f').egg.reviewPending, true);
  assert.throws(() => h.context.resolveCommunityReview({ ...resolution, resolutionId: 'stale-review' }), /generation|stale/i);
  assert.equal(h.post(h.payload('stats')).eggs['egg-one'].reviewPending, true);
});
test('resolution log written before state failure is recovered without clearing the next generation twice', () => {
  const h = harness(); h.install(); ['a', 'b', 'c'].forEach(id => h.vote(id));
  const resolution = { resolutionId: 'recover-review', eggId: 'egg-one', expectedGeneration: 0, outcome: 'confirmed', evidenceUrl: 'https://official.example/offer', notes: 'Read latest official rules and checked actual eligibility and API offering.', verifiedAt: '2026-10-09' };
  let failed = false; h.database.fail = (name, rows, action) => name === '社区复核' && action === 'set' && rows[0]?.[2] === 1 && !failed ? (failed = true) : false;
  assert.throws(() => h.context.resolveCommunityReview(resolution)); h.database.fail = null;
  assert.equal(h.post(h.payload('stats')).eggs['egg-one'].reviewPending, false);
  assert.equal(h.context.resolveCommunityReview(resolution).generation, 1);
  const logs = h.database.sheets.get('社区复核').rows.filter(row => row[1] === 'resolution'); assert.equal(logs.length, 1);
});
test('real Sheets Date cells are normalized to ISO timestamps and Beijing calendar dates', () => {
  const h = harness(); h.install(); ['a', 'b', 'c'].forEach(id => h.vote(id));
  const states = h.database.sheets.get('社区复核').rows;
  states[1][4] = new Date('2026-10-09T08:00:00Z');
  states[1][5] = new Date('2026-10-09T00:00:00+08:00');
  const result = h.post(h.payload('stats', { dates: { 'egg-one': null } })).eggs['egg-one'];
  assert.equal(result.lastVerified, '2026-10-09');
  assert.equal(result.reviewRequestedAt, '2026-10-09T08:00:00.000Z');
});
test('failed ballot flushes accepted journal before lock release and cannot overwrite a later writer', () => {
  const first = harness(); first.install(); first.bufferWrites(true);
  let failed = false; first.database.fail = name => name === '社区投票' && !failed ? (failed = true) : false;
  assert.equal(first.vote('one', 'good').available, false);
  assert.deepEqual(first.events.slice(-2), ['flush', 'release']);
  first.database.fail = null;
  const second = harness(first.database);
  assert.equal(second.post(second.payload('stats')).eggs['egg-one'].good, 1, 'next process recovers the durable journal');
  assert.equal(second.vote('one', 'bad').egg.bad, 1);
  first.flushPending();
  assert.equal(first.database.sheets.get('投票限流').rows[1][2], 2, 'no late old cache rolls back later rate hits');
  assert.equal(second.post(second.payload('stats')).eggs['egg-one'].bad, 1);
});
test('750 bad identities clear without oversized cells, recover interrupted baseline and only new bad identities requeue', () => {
  const h = harness(); h.install(); ['a', 'b', 'c'].forEach(id => h.vote(id));
  const table = h.database.sheets.get('社区投票');
  for (let i = 3; i < 750; i++) table.rows.push(['egg-one', h.hash('large-' + i), 'bad', 0, '2026-10-09T08:00:00.000Z', 1, '']);
  const resolution = { resolutionId: 'large-review', eggId: 'egg-one', expectedGeneration: 0, outcome: 'confirmed', evidenceUrl: 'https://official.example/offer', notes: 'Read current official sources and checked current eligibility and API usage.', verifiedAt: '2026-10-09' };
  let failed = false; h.database.fail = (name, rows, action) => {
    if (name === '社区投票' && action === 'set' && rows.some(row => row[6] === 1) && !failed) {
      // Emulate an ambiguous bulk write that persisted only some marker rows.
      table.rows.slice(1, 376).forEach(row => { row[6] = 1; }); failed = true; return true;
    }
    return false;
  };
  assert.throws(() => h.context.resolveCommunityReview(resolution));
  assert.equal(table.rows.slice(1).filter(row => row[6] === 1).length, 375);
  h.database.fail = null;
  assert.equal(h.post(h.payload('stats')).eggs['egg-one'].reviewPending, false);
  assert.equal(h.context.resolveCommunityReview(resolution).generation, 1);
  assert.equal(table.rows.length, 751);
  assert.equal(table.rows.slice(1).every(row => row[6] === 1), true);
  h.vote('a', 'good'); h.vote('a', 'bad');
  assert.equal(h.post(h.payload('stats')).eggs['egg-one'].reviewPending, false);
  h.vote('new-a'); h.vote('new-b'); assert.equal(h.vote('new-c').egg.reviewPending, true);
});
test('baseline markers become durable before advancing review generation in a cached write session', () => {
  const h = harness(); h.install(); ['a', 'b', 'c'].forEach(id => h.vote(id)); h.bufferWrites(true);
  h.database.fail = (name, rows, action) => {
    if (name === '社区复核' && action === 'set' && rows[0]?.[2] === 1) {
      assert.equal(h.database.sheets.get('社区投票').rows.slice(1).every(row => row[6] === 1), true, 'state cannot advance ahead of durable ballot baseline');
    }
    return false;
  };
  const resolution = { resolutionId: 'cached-baseline', eggId: 'egg-one', expectedGeneration: 0, outcome: 'confirmed', evidenceUrl: 'https://official.example/offer', notes: 'Read current official sources and checked eligibility and actual API offering.', verifiedAt: '2026-10-09' };
  assert.equal(h.context.resolveCommunityReview(resolution).generation, 1);
});
