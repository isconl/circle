'use strict';
/**
 * career.js has real callers (corporate.js, decisions.js via
 * getCareerContext) but had zero test coverage before this file --
 * discovered 17 Aug while chasing why the hub Corporate Engagements
 * dashboard shows nothing (`available:false`, `engagements:[]`) even
 * though circle itself is healthy: `memory/career/` genuinely does not
 * exist on this machine yet (never pulled from OneDrive, no sync
 * mechanism pulls it -- see task-backlog.md's SYNC1/D2 entries). That's a
 * data-provisioning gap, not a code bug -- these tests prove the PARSER
 * side is correct against a real fixture shape, so once `career/_active.
 * yaml` + `career/orgs/<id>/*.yaml` actually exist, the whole chain
 * (circle -> scope's corporate.js -> hub's Corporate space) is known-good.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('../lib/career');

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-career-test-'));
  const careerDir = path.join(dir, 'career');
  const orgDir = path.join(careerDir, 'orgs', 'acme');
  fs.mkdirSync(orgDir, { recursive: true });

  fs.writeFileSync(path.join(careerDir, '_active.yaml'), `
active_org: acme
orgs:
  - id: acme
    name: Acme Manufacturing Ltd
    role: Fractional COO
    status: active
  - id: former-co
    name: Former Co
    role: Advisor
    status: past
`.trim());

  fs.writeFileSync(path.join(orgDir, 'power_map.yaml'), `
- name: Jordan Rivera
  known_as: Jordan
  role: CEO
  authority: final
  importance: high
  wants:
    - Weekly written status
  cautions:
    - Dislikes surprise scope changes
`.trim());

  fs.writeFileSync(path.join(orgDir, 'decision_log.yaml'), `
- id: D-001
  date: 2026-08-01
  decision: Ship the v1 pricing page
  status: PENDING - awaiting Jordan sign-off
  by: Sconl
`.trim());

  fs.writeFileSync(path.join(orgDir, 'risk_register.yaml'), `
- id: R-001
  risk: Vendor contract renewal lapses end of month
`.trim());

  return dir;
}

test('load() returns available:false with no career/ directory at all (the exact state on this machine today)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-career-empty-'));
  const ctx = load(dir);
  assert.equal(ctx.available, false);
  assert.deepEqual(ctx.orgs, []);
  assert.deepEqual(ctx.people, []);
});

test('load() resolves active_org, the full orgs registry, and overlays the active org\'s files', () => {
  const dir = writeFixture();
  const ctx = load(dir);
  assert.equal(ctx.activeOrg, 'acme');
  assert.equal(ctx.orgs.length, 2);
  assert.deepEqual(ctx.orgs.map(o => o.id), ['acme', 'former-co']);
  assert.equal(ctx.orgs[0].name, 'Acme Manufacturing Ltd');
  assert.equal(ctx.orgs[1].status, 'past');
});

test('load() parses the power map into people with nested list fields', () => {
  const dir = writeFixture();
  const ctx = load(dir);
  assert.equal(ctx.people.length, 1);
  const p = ctx.people[0];
  assert.equal(p.name, 'Jordan Rivera');
  assert.equal(p.knownAs, 'Jordan');
  assert.equal(p.role, 'CEO');
  assert.deepEqual(p.wants, ['Weekly written status']);
  assert.deepEqual(p.cautions, ['Dislikes surprise scope changes']);
});

test('load() parses decisions and risks, and available becomes true once an active org has real content', () => {
  const dir = writeFixture();
  const ctx = load(dir);
  assert.equal(ctx.available, true);
  assert.equal(ctx.decisions.length, 1);
  assert.equal(ctx.decisions[0].id, 'D-001');
  assert.match(ctx.decisions[0].status, /^PENDING/);
  assert.equal(ctx.risks.length, 1);
  assert.equal(ctx.risks[0].title, 'Vendor contract renewal lapses end of month');
});

test('load() caches on file mtime/size and reloads once a source file changes', () => {
  const dir = writeFixture();
  const first = load(dir);
  assert.equal(first.people.length, 1);

  const orgDir = path.join(dir, 'career', 'orgs', 'acme');
  fs.writeFileSync(path.join(orgDir, 'power_map.yaml'), `
- name: Jordan Rivera
  role: CEO
- name: Sam Lee
  role: CFO
`.trim());
  // Force a distinct mtime -- some filesystems have coarse mtime resolution.
  const now = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(orgDir, 'power_map.yaml'), now, now);

  const second = load(dir);
  assert.equal(second.people.length, 2);
});
