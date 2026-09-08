'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTeamsClient, SPAN_LIMIT, DEPTH_GREEN } = require('../lib/teams');

function memoryStore() {
  const db = new Map();
  return {
    async readTSV(p) { return db.get(p) || []; },
    async appendTSV(p, row) {
      const cur = db.get(p) || [];
      db.set(p, [...cur, row]);
    },
    async rewriteTSV(p, fn) {
      const cur = db.get(p) || [];
      db.set(p, fn(cur));
    },
    auditLog: { log() {} }
  };
}

test('Teams client - team creation, member management, work queue, and move transitions', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);

  // 1. Create a team
  const tRes = await teams.saveTeam({
    title: 'Viva Testing',
    org: 'Viva Valentia',
    owner: 'ARCHITECT',
    recipient: 'Sam',
    cadence: 'weekly, Friday'
  });
  assert.ok(tRes.success);
  assert.ok(tRes.id.startsWith('TM'));

  // 2. Add members
  const m1 = await teams.saveMember({
    teamId: tRes.id,
    name: 'Philip',
    role: 'QA Lead',
    reportsTo: ''
  });
  assert.ok(m1.success);
  assert.ok(m1.id.startsWith('MB'));

  const m2 = await teams.saveMember({
    teamId: tRes.id,
    name: 'Sarah',
    role: 'Tester',
    reportsTo: m1.id
  });
  assert.ok(m2.success);

  // 3. Add work item
  const w1 = await teams.saveWork({
    teamId: tRes.id,
    memberId: m2.id,
    title: 'WAF Load Test',
    why: 'Verify latency under peak load',
    due: '2026-09-01',
    doneMeans: 'Test report generated with <200ms latency',
    effortDays: 3
  });
  assert.ok(w1.success);
  assert.ok(w1.id.startsWith('WK'));

  // 4. Check snapshot
  const snap1 = await teams.snapshot();
  assert.equal(snap1.teams.length, 1);
  const team1 = snap1.teams[0];
  assert.equal(team1.title, 'Viva Testing');
  assert.equal(team1.members.length, 2);
  assert.equal(team1.work.length, 1);
  assert.equal(team1.work[0].status, 'queued');

  // 5. Status transitions
  const movedActive = await teams.moveWork({ id: w1.id, to: 'active' });
  assert.equal(movedActive.to, 'active');

  const movedFinished = await teams.moveWork({ id: w1.id, to: 'finished' });
  assert.equal(movedFinished.to, 'finished');

  const movedSigned = await teams.moveWork({ id: w1.id, to: 'signed', signedBy: 'Philip' });
  assert.equal(movedSigned.to, 'signed');
  assert.equal(movedSigned.signedBy, 'Philip');

  const snap2 = await teams.snapshot();
  assert.equal(snap2.teams[0].work[0].status, 'signed');
  assert.equal(snap2.teams[0].counts.signedWeek, 1);
});

// ── BM26090602: Teams/Channels webhook bridge ────────────────────────────

test('ensureRecipientChannel creates a channel on first call and reuses it on later calls (idempotent)', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);

  const first = await teams.ensureRecipientChannel({ personId: 'alex-example', personName: 'Alex Example' });
  assert.equal(first.created, true);
  assert.ok(first.id.startsWith('TM'));

  const second = await teams.ensureRecipientChannel({ personId: 'alex-example', personName: 'Alex Example' });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);

  const snap = await teams.snapshot();
  const channel = snap.teams.find(t => t.id === first.id);
  assert.equal(channel.recipientPersonId, 'alex-example');
});

test('ensureRecipientChannel throws without a person_id', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  await assert.rejects(() => teams.ensureRecipientChannel({ personName: 'No Id' }));
});

test('postMessage/channelMessages: a channel reads as one chronological thread', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  const channel = await teams.ensureRecipientChannel({ personId: 'sam-example', personName: 'Sam Example' });

  await teams.postMessage({ teamId: channel.id, kind: 'brief_sent', body: 'Week 1 brief', briefId: 'BRIEF-001' });
  await teams.postMessage({ teamId: channel.id, kind: 'reply_received', body: 'Looks good', briefId: 'BRIEF-001' });

  const messages = await teams.channelMessages(channel.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, 'brief_sent');
  assert.equal(messages[1].kind, 'reply_received');
});

test('postMessage rejects an unknown kind and an unknown team', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  const channel = await teams.ensureRecipientChannel({ personId: 'p1', personName: 'P One' });
  await assert.rejects(() => teams.postMessage({ teamId: channel.id, kind: 'bogus', body: 'x' }));
  await assert.rejects(() => teams.postMessage({ teamId: 'TM-NOPE', kind: 'note', body: 'x' }));
});

test('issueBriefToken mints a token scoped to one team+brief, and verifyBriefToken accepts it', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  const channel = await teams.ensureRecipientChannel({ personId: 'p2', personName: 'P Two' });

  const issued = await teams.issueBriefToken({ teamId: channel.id, briefId: 'BRIEF-002' });
  assert.ok(issued.token.length > 20);

  const check = await teams.verifyBriefToken(issued.token);
  assert.equal(check.ok, true);
  assert.equal(check.teamId, channel.id);
  assert.equal(check.briefId, 'BRIEF-002');
});

test('verifyBriefToken rejects an unknown token, an expired token, and a revoked token', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  const channel = await teams.ensureRecipientChannel({ personId: 'p3', personName: 'P Three' });

  const unknown = await teams.verifyBriefToken('not-a-real-token');
  assert.equal(unknown.ok, false);

  const expired = await teams.issueBriefToken({ teamId: channel.id, briefId: 'BRIEF-EXP', ttlDays: -1 });
  const expiredCheck = await teams.verifyBriefToken(expired.token);
  assert.equal(expiredCheck.ok, false);
  assert.match(expiredCheck.error, /expired/);

  const revocable = await teams.issueBriefToken({ teamId: channel.id, briefId: 'BRIEF-REV' });
  await store.rewriteTSV('teams/brief_tokens.tsv', rows => rows.map(r => r.TOKEN === revocable.token ? { ...r, STATUS: 'revoked' } : r));
  const revokedCheck = await teams.verifyBriefToken(revocable.token);
  assert.equal(revokedCheck.ok, false);
  assert.match(revokedCheck.error, /revoked/);
});

test('recordInboundReply appends a reply to the right channel thread and rejects a bad token without writing anything', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  const channel = await teams.ensureRecipientChannel({ personId: 'p4', personName: 'P Four' });
  const issued = await teams.issueBriefToken({ teamId: channel.id, briefId: 'BRIEF-004' });

  const rejected = await teams.recordInboundReply({ token: 'garbage', body: 'hi' });
  assert.equal(rejected.ok, false);
  assert.deepEqual(await teams.channelMessages(channel.id), []);

  const accepted = await teams.recordInboundReply({ token: issued.token, body: 'Looks great, ship it' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.teamId, channel.id);
  const messages = await teams.channelMessages(channel.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'reply_received');
  assert.equal(messages[0].body, 'Looks great, ship it');
  assert.equal(messages[0].briefId, 'BRIEF-004');

  // A second reply within the token's window is also accepted (not single-use).
  const secondReply = await teams.recordInboundReply({ token: issued.token, body: 'One more thing' });
  assert.equal(secondReply.ok, true);
  assert.equal((await teams.channelMessages(channel.id)).length, 2);
});

test('sendBriefToChannel ties channel creation + token issuance + outbound message into one call', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);

  const r = await teams.sendBriefToChannel({
    personId: 'p5', personName: 'P Five', briefId: 'BRIEF-005', artifactUrl: 'https://example.com/brief-005.html',
  });
  assert.equal(r.channelCreated, true);
  assert.ok(r.token.length > 20);

  const messages = await teams.channelMessages(r.teamId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'brief_sent');
  assert.match(messages[0].body, /brief-005\.html/);

  const verify = await teams.verifyBriefToken(r.token);
  assert.equal(verify.ok, true);
  assert.equal(verify.briefId, 'BRIEF-005');
});
