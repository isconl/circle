'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTeamsClient, SPAN_LIMIT, DEPTH_GREEN, FORCES } = require('../lib/teams');

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

test('BM26091502 - force model: six slots always, covered/doubled/missing, Architect is a flag not a seventh force', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  assert.deepEqual(FORCES, ['captain', 'strategist', 'operator', 'warrior', 'scout', 'guardian']);

  const t = await teams.saveTeam({ title: 'Force Test' });
  const captain = await teams.saveMember({ teamId: t.id, name: 'Ada', forcePrimary: 'captain' });
  assert.ok(captain.success);
  const doubleGuardian1 = await teams.saveMember({ teamId: t.id, name: 'Ben', forcePrimary: 'guardian' });
  const doubleGuardian2 = await teams.saveMember({ teamId: t.id, name: 'Cy', forcePrimary: 'guardian', forceSecondary: 'scout' });
  const architectOnly = await teams.saveMember({ teamId: t.id, name: 'Dee', isArchitect: true });

  const snap = await teams.snapshot();
  const forces = snap.teams[0].forces;
  assert.deepEqual(forces.forces, FORCES);
  assert.deepEqual(forces.covered.sort(), ['captain', 'scout'].sort());
  assert.deepEqual(forces.doubled, ['guardian']);
  assert.deepEqual(forces.missing.sort(), ['strategist', 'operator', 'warrior'].sort());
  assert.equal(forces.holders.guardian.length, 2);
  assert.equal(forces.architects.length, 1);
  assert.equal(forces.architects[0].name, 'Dee');
  // Architect never leaks into the six-force enum -- an architect-only
  // member with no force assigned contributes nothing to holders/covered.
  assert.ok(!Object.keys(forces.holders).includes('architect'));

  const m = snap.teams[0].members.find(mm => mm.id === architectOnly.id);
  assert.equal(m.isArchitect, true);
  assert.equal(m.forcePrimary, '');
});

test('BM26091502 - force assignment rejects an unknown force and a force doubled as its own secondary', async () => {
  const store = memoryStore();
  const teams = createTeamsClient(store);
  const t = await teams.saveTeam({ title: 'Force Validation' });

  await assert.rejects(
    teams.saveMember({ teamId: t.id, name: 'Eve', forcePrimary: 'wizard' }),
    /must be one of/
  );
  await assert.rejects(
    teams.saveMember({ teamId: t.id, name: 'Fay', forcePrimary: 'scout', forceSecondary: 'scout' }),
    /same force as both primary and secondary/
  );

  // A later partial edit that only touches forceSecondary must not be
  // allowed to collide with the existing forcePrimary either.
  const g = await teams.saveMember({ teamId: t.id, name: 'Gia', forcePrimary: 'warrior' });
  await assert.rejects(
    teams.saveMember({ id: g.id, teamId: t.id, forceSecondary: 'warrior' }),
    /same force as both primary and secondary/
  );

  // Force is case-insensitive on the way in.
  const h = await teams.saveMember({ teamId: t.id, name: 'Hal', forcePrimary: 'STRATEGIST' });
  const snap = await teams.snapshot();
  assert.equal(snap.teams[0].members.find(mm => mm.id === h.id).forcePrimary, 'strategist');
});
