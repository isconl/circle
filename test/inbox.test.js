'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInboxClient } = require('../lib/inbox');

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

test('createInboxClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createInboxClient({}));
});

test('addMessage rejects an empty message', async () => {
  const client = createInboxClient({ ...makeStore() });
  await assert.rejects(() => client.addMessage({}));
});

test('addMessage assigns a sequential zero-padded ID', async () => {
  const store = makeStore({ 'scope/inbox.tsv': [{ ID: 'I001' }] });
  const client = createInboxClient({ ...store });
  const r = await client.addMessage({ body: 'hello' });
  assert.equal(r.id, 'I002');
});

test('addMessage auto-adds an unknown sender to the Circle and logs the touch', async () => {
  const store = makeStore();
  const client = createInboxClient({ ...store });
  await client.addMessage({ body: 'hi', sender: 'Taylor Kariuki', channel: 'whatsapp' });
  assert.equal(store.data['circle/people.tsv'].length, 1);
  assert.match(store.data['circle/people.tsv'][0].NOTE, /Auto-added/);
  assert.equal(store.data['circle/interactions.tsv'].length, 1);
});

test('addMessage matches an existing person by name and does not create a duplicate', async () => {
  const store = makeStore({ 'circle/people.tsv': [{ ID: 'taylor', NAME: 'Taylor Kariuki' }] });
  const client = createInboxClient({ ...store });
  await client.addMessage({ body: 'hi', sender: 'Taylor Kariuki' });
  assert.equal(store.data['circle/people.tsv'].length, 1);
  assert.equal(store.data['circle/interactions.tsv'][0].PERSON_ID, 'taylor');
});

test('addMessage does not touch the Circle for the operator\'s own sender ("iSconl") or no sender', async () => {
  const store = makeStore();
  const client = createInboxClient({ ...store });
  await client.addMessage({ body: 'hi', sender: 'iSconl' });
  await client.addMessage({ body: 'hi' });
  assert.equal((store.data['circle/people.tsv'] || []).length, 0);
});

test('addMessage fires onCaptured without blocking the response', async () => {
  let called = null;
  const client = createInboxClient({ ...makeStore(), onCaptured: async (row) => { called = row; } });
  await client.addMessage({ body: 'hi' });
  await new Promise(r => setImmediate(r));
  assert.ok(called);
});

test('updateMessage edits status/tag/comment and throws for an unknown id', async () => {
  const store = makeStore({ 'scope/inbox.tsv': [{ ID: 'I001', STATUS: 'new', TAG: '-', COMMENT: '-' }] });
  const client = createInboxClient({ ...store });
  await client.updateMessage({ id: 'I001', status: 'read', comment: 'will reply tomorrow' });
  assert.equal(store.data['scope/inbox.tsv'][0].STATUS, 'read');
  assert.equal(store.data['scope/inbox.tsv'][0].COMMENT, 'will reply tomorrow');
  await assert.rejects(() => client.updateMessage({ id: 'nope', status: 'read' }));
});

test('deleteMessage removes the row', async () => {
  const store = makeStore({ 'scope/inbox.tsv': [{ ID: 'I001' }] });
  const client = createInboxClient({ ...store });
  const r = await client.deleteMessage('I001');
  assert.equal(r.success, true);
  assert.equal(store.data['scope/inbox.tsv'].length, 0);
});
