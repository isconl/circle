'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nameSimilarity, findCandidates } = require('../lib/fuzzy-match');

test('nameSimilarity: identical names score 1', () => {
  assert.equal(nameSimilarity('Taylor Kariuki', 'Taylor Kariuki'), 1);
});

test('nameSimilarity: a small typo scores high but not perfect', () => {
  const s = nameSimilarity('Taylor Kariuki', 'Tayler Kariuki');
  assert.ok(s > 0.85 && s < 1, `expected a high near-match score, got ${s}`);
});

test('nameSimilarity: a missing middle/extra token still scores decently via token overlap', () => {
  const s = nameSimilarity('Taylor Kariuki', 'Taylor J Kariuki');
  assert.ok(s > 0.6, `expected token overlap to carry this, got ${s}`);
});

test('nameSimilarity: unrelated names score low', () => {
  const s = nameSimilarity('Taylor Kariuki', 'Morgan Otieno');
  assert.ok(s < 0.3, `expected a low score for unrelated names, got ${s}`);
});

test('findCandidates: returns near-misses above threshold, sorted best-first', () => {
  const people = [
    { ID: 'p1', NAME: 'Tayler Kariuki' },     // typo of "Taylor Kariuki"
    { ID: 'p2', NAME: 'Taylor K.' },
    { ID: 'p3', NAME: 'Morgan Otieno' },      // unrelated
  ];
  const candidates = findCandidates('Taylor Kariuki', people);
  const ids = candidates.map(c => c.personId);
  assert.ok(ids.includes('p1'));
  assert.ok(!ids.includes('p3'));
  assert.ok(candidates[0].score >= candidates[candidates.length - 1].score);
});

test('findCandidates: excludes ids in excludeIds even if they would otherwise match', () => {
  const people = [{ ID: 'p1', NAME: 'Taylor Kariuki' }];
  const candidates = findCandidates('Taylor Kariuki', people, { excludeIds: new Set(['p1']) });
  assert.deepEqual(candidates, []);
});

test('findCandidates: excludes a dismissed (name, personId) pair', () => {
  const people = [{ ID: 'p1', NAME: 'Tayler Kariuki' }];
  const dismissed = new Set(['taylor kariuki::p1']);
  const candidates = findCandidates('Taylor Kariuki', people, { dismissed });
  assert.deepEqual(candidates, []);
});

test('findCandidates: respects the limit', () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ ID: `p${i}`, NAME: 'Taylor Kariuki' }));
  const candidates = findCandidates('Taylor Kariuki', people, { limit: 2 });
  assert.equal(candidates.length, 2);
});

test('findCandidates: empty/blank name returns no candidates', () => {
  assert.deepEqual(findCandidates('', [{ ID: 'p1', NAME: 'Taylor Kariuki' }]), []);
});
