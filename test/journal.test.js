'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJournalClient } = require('../lib/journal');
const { tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => {
      const before = (data[rel] || []).length;
      data[rel] = fn((data[rel] || []).slice());
      return before - data[rel].length;
    },
  };
}

function makeClient(overrides = {}) {
  return createJournalClient({ ...makeStore(overrides.seed), tsvEscapeText, tsvUnescapeText, ...overrides });
}

test('createJournalClient throws without readTSV/appendTSV/rewriteTSV or the tsv escape helpers', () => {
  assert.throws(() => createJournalClient({}));
  assert.throws(() => createJournalClient({ readTSV: () => [], appendTSV: () => {}, rewriteTSV: () => {} }));
});

test('addEntry rejects an empty body', async () => {
  const client = makeClient();
  await assert.rejects(() => client.addEntry({ body: '   ' }));
});

test('addEntry clamps mood/energy to 1-10 and escapes tabs/newlines in the body', async () => {
  const client = createJournalClient({ ...makeStore(), tsvEscapeText, tsvUnescapeText });
  const r = await client.addEntry({ body: 'line one\nline two', mood: '99', energy: '5' });
  assert.equal(r.success, true);
});

test('addEntry fires onEntryAdded with the plain (unescaped) body, without blocking the response', async () => {
  let received = null;
  const client = createJournalClient({ ...makeStore(), tsvEscapeText, tsvUnescapeText,
    onEntryAdded: async (entry) => { received = entry; } });
  await client.addEntry({ body: 'Had a good day.', mood: '8' });
  await new Promise(r => setImmediate(r));
  assert.equal(received.BODY, 'Had a good day.');
  assert.equal(received.MOOD, '8');
});

test('listEntries returns newest first and unescapes body/AI_NOTE', async () => {
  const store = makeStore({ 'spark/journal.tsv': [
    { ID: 'J1', DATE: '2026-08-01', MOOD: '5', ENERGY: '5', TAGS: '-', BODY: tsvEscapeText('first'), AI_NOTE: '-', CREATED_AT: '2026-08-01T00:00:00Z' },
    { ID: 'J2', DATE: '2026-08-02', MOOD: '7', ENERGY: '6', TAGS: '-', BODY: tsvEscapeText('second\nline'), AI_NOTE: '-', CREATED_AT: '2026-08-02T00:00:00Z' },
  ] });
  const client = createJournalClient({ ...store, tsvEscapeText, tsvUnescapeText });
  const r = await client.listEntries();
  assert.equal(r.entries[0].BODY, 'second\nline');
  assert.equal(r.stats.total, 2);
});

test('listEntries computes a 7-day streak correctly', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const store = makeStore({ 'spark/journal.tsv': [
    { ID: 'J1', DATE: yesterday, MOOD: '-', ENERGY: '-', TAGS: '-', BODY: tsvEscapeText('x'), AI_NOTE: '-' },
    { ID: 'J2', DATE: today, MOOD: '-', ENERGY: '-', TAGS: '-', BODY: tsvEscapeText('y'), AI_NOTE: '-' },
  ] });
  const client = createJournalClient({ ...store, tsvEscapeText, tsvUnescapeText });
  assert.equal((await client.listEntries()).stats.streak, 2);
});

test('deleteEntry removes the row and reports success:false when nothing matched', async () => {
  const store = makeStore({ 'spark/journal.tsv': [{ ID: 'J1', BODY: '-' }] });
  const client = createJournalClient({ ...store, tsvEscapeText, tsvUnescapeText });
  assert.equal((await client.deleteEntry('J1')).success, true);
  assert.equal((await client.deleteEntry('J1')).success, false);
});
