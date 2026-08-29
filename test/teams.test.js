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
    owner: 'SCONL',
    recipient: 'Swen',
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
