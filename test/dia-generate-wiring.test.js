'use strict';
/** BM26082601: writeDiaFile()'s splice-only-3.2/3.3/3.4 contract, and
 *  currentDiaSections()'s extraction for the "existing analysis" prompt
 *  context.
 *
 * BM26090602: DIA dossiers moved off circle's local disk onto vault's
 * encrypted raw-blob store -- readDiaFile/writeDia are now async, injected
 * functions. This file backs them with a plain in-memory Map (the same
 * shape circle/src/server.js's real wiring gets from store.rawRead/
 * rawWrite over HTTP), not fs, so this test no longer needs a real temp
 * dir. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPeopleClient } = require('../lib/people');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); return data[rel].length; },
  };
}

function makeClient(dia, seed) {
  return createPeopleClient({
    ...makeStore(seed),
    readDiaFile: async (id) => (Object.prototype.hasOwnProperty.call(dia, id) ? dia[id] : null),
    writeDia: async (id, content) => { dia[id] = content; },
  });
}

const SECTIONS = {
  strengths: [{ text: 'Ships fast', evidence: '2026-08-01 call' }],
  weaknesses: [{ text: 'Overcommits', evidence: '2026-08-10 meeting' }],
  personalityObserved: ['Direct communicator'],
  personalityInferred: [{ text: 'Detail-oriented', basis: 'follow-up questions pattern' }],
};

test('writeDiaFile starts from the SDIAIF v2.1 skeleton when no dossier exists yet', async () => {
  const dia = {};
  const client = makeClient(dia, { 'circle/people.tsv': [{ ID: 'p1', NAME: 'Test Person' }] });
  const result = await client.writeDiaFile('p1', SECTIONS);
  assert.ok(result.success);
  const content = dia['p1'];
  assert.match(content, /### 3\.2 STRENGTHS/);
  assert.match(content, /Ships fast \[evidence: 2026-08-01 call\]/);
  assert.match(content, /### 3\.3 WEAKNESSES & BLIND SPOTS/);
  assert.match(content, /Overcommits \[evidence: 2026-08-10 meeting\]/);
  assert.match(content, /### 3\.4 PERSONALITY TRAITS/);
  assert.match(content, /Direct communicator/);
  assert.match(content, /Detail-oriented \[INFERRED: follow-up questions pattern\]/);
});

test('writeDiaFile splices into an existing dossier without touching other sections', async () => {
  const existing = [
    '# DIA -- Existing Person',
    '',
    '## 1. EXECUTIVE SUMMARY & COGNITIVE CONTEXT',
    '',
    'This section must survive untouched.',
    '',
    '### 3.2 STRENGTHS',
    '',
    '- old strength [evidence: old]',
    '',
    '### 3.3 WEAKNESSES & BLIND SPOTS',
    '',
    '- old weakness [evidence: old]',
    '',
    '### 3.4 PERSONALITY TRAITS',
    '',
    '- old trait',
    '',
    '## 5. HISTORICAL TOUCHES & LOGGED INTERACTIONS',
    '',
    'This log must also survive untouched.',
    '',
  ].join('\n');
  const dia = { p2: existing };

  const client = makeClient(dia, { 'circle/people.tsv': [{ ID: 'p2', NAME: 'Existing Person' }] });
  await client.writeDiaFile('p2', SECTIONS);
  const content = dia['p2'];

  assert.match(content, /This section must survive untouched\./);
  assert.match(content, /This log must also survive untouched\./);
  assert.match(content, /Ships fast \[evidence: 2026-08-01 call\]/);
  assert.doesNotMatch(content, /old strength/);
  assert.doesNotMatch(content, /old weakness/);
  assert.doesNotMatch(content, /old trait/);
});

test('currentDiaSections returns the joined 3.2/3.3/3.4 text for an existing dossier', async () => {
  const dia = {
    p3: [
      '### 3.2 STRENGTHS', '', '- reliable', '',
      '### 3.3 WEAKNESSES & BLIND SPOTS', '', '- impatient', '',
      '### 3.4 PERSONALITY TRAITS', '', '- curious', '',
    ].join('\n'),
  };
  const client = makeClient(dia, {});
  const text = await client.currentDiaSections('p3');
  assert.match(text, /reliable/);
  assert.match(text, /impatient/);
  assert.match(text, /curious/);
});

test('currentDiaSections returns empty string for a person with no dossier yet', async () => {
  const client = makeClient({}, {});
  assert.equal(await client.currentDiaSections('nobody'), '');
});

test('writeDiaFile throws without writeDia configured', async () => {
  const client = createPeopleClient({ ...makeStore() });
  await assert.rejects(() => client.writeDiaFile('p1', SECTIONS), /writeDia/);
});
