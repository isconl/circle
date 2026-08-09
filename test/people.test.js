'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPeopleClient, circleFolderFor } = require('../lib/people');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: (rel) => (data[rel] || []).slice(),
    appendTSV: (rel, row) => { (data[rel] = data[rel] || []).push(row); },
    rewriteTSV: (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); return data[rel].length; },
  };
}

test('createPeopleClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createPeopleClient({}));
});

test('circleFolderFor buckets by circle', () => {
  assert.equal(circleFolderFor('family', 'joel'), 'Circle/Family/joel');
  assert.equal(circleFolderFor('professional', 'fred'), 'Circle/Professional/fred');
  assert.equal(circleFolderFor('social', 'x'), 'Circle/Social/x');
});

test('upsertPerson rejects a person with no name', async () => {
  const client = createPeopleClient({ ...makeStore() });
  await assert.rejects(() => client.upsertPerson({}));
});

test('upsertPerson creates a new person with a slugged id and defaults to the social circle', async () => {
  const store = makeStore();
  const client = createPeopleClient({ ...store });
  const r = await client.upsertPerson({ name: 'Fred Kariuki' });
  assert.equal(r.id, 'fred-kariuki');
  assert.equal(store.data['circle/people.tsv'][0].CIRCLE, 'social');
});

test('upsertPerson refuses to silently overwrite an existing id when creating (no p.id passed)', async () => {
  const store = makeStore({ 'circle/people.tsv': [{ ID: 'fred', NAME: 'Fred' }] });
  const client = createPeopleClient({ ...store });
  await assert.rejects(() => client.upsertPerson({ name: 'Fred' }));
});

test('upsertPerson updates an existing person when p.id is passed', async () => {
  const store = makeStore({ 'circle/people.tsv': [{ ID: 'fred', NAME: 'Fred', CIRCLE: 'social', ROLE: '-' }] });
  const client = createPeopleClient({ ...store });
  await client.upsertPerson({ id: 'fred', name: 'Fred', role: 'CTO' });
  assert.equal(store.data['circle/people.tsv'][0].ROLE, 'CTO');
});

test('upsertPerson triggers DIA generation and marks the circle analysis dirty for a new person', async () => {
  let diaCalledFor = null, dirty = false;
  const client = createPeopleClient({ ...makeStore(),
    generateDia: async (id) => { diaCalledFor = id; return { ok: true }; },
    markAnalysisDirty: () => { dirty = true; },
  });
  await client.upsertPerson({ name: 'New Person' });
  assert.equal(diaCalledFor, 'new-person');
  assert.equal(dirty, true);
});

test('setRemember stores a semicolon-joined list and clears with an empty list', () => {
  const store = makeStore({ 'circle/people.tsv': [{ ID: 'fred', REMEMBER: '-' }] });
  const client = createPeopleClient({ ...store });
  client.setRemember({ id: 'fred', remember: ['likes concise updates', 'based in Nairobi'] });
  assert.equal(store.data['circle/people.tsv'][0].REMEMBER, 'likes concise updates; based in Nairobi');
  client.setRemember({ id: 'fred', remember: [] });
  assert.equal(store.data['circle/people.tsv'][0].REMEMBER, '-');
});

test('setRemember throws for an unknown person', () => {
  const client = createPeopleClient({ ...makeStore() });
  assert.throws(() => client.setRemember({ id: 'nope', remember: ['x'] }));
});

test('logTouch stamps LAST_TOUCH and records an interaction row', () => {
  const store = makeStore({ 'circle/people.tsv': [{ ID: 'fred', LAST_TOUCH: '-' }] });
  const client = createPeopleClient({ ...store });
  client.logTouch({ personId: 'fred', channel: 'whatsapp', summary: 'caught up', date: '2026-08-01' });
  assert.equal(store.data['circle/people.tsv'][0].LAST_TOUCH, '2026-08-01');
  assert.equal(store.data['circle/interactions.tsv'][0].PERSON_ID, 'fred');
});

test('listPeople computes dueIn from cadence and last touch, and -1 (overdue) when never touched with a cadence set', () => {
  const store = makeStore({
    'circle/people.tsv': [
      { ID: 'a', LAST_TOUCH: '-', CADENCE_DAYS: '30' },
      { ID: 'b', LAST_TOUCH: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10), CADENCE_DAYS: '7' },
    ],
  });
  const client = createPeopleClient({ ...store });
  const list = client.listPeople();
  assert.equal(list.find(p => p.ID === 'a').dueIn, -1);
  assert.ok(list.find(p => p.ID === 'b').dueIn < 0, 'overdue by cadence math');
});

test('readDia rejects a malformed id and returns empty content when nothing is on file', () => {
  const client = createPeopleClient({ ...makeStore(), readDiaFile: () => null });
  assert.throws(() => client.readDia('bad id!'));
  assert.equal(client.readDia('fred').content, '');
});

test('whoCan scores role/note text hits, capability hits higher, and throws on an empty query', () => {
  const store = makeStore({
    'circle/people.tsv': [{ ID: 'fred', NAME: 'Fred', ROLE: 'infra engineer', NOTE: '-', GROUP: '-' }],
    'circle/capabilities.tsv': [{ PERSON_ID: 'fred', CAPABILITY: 'kubernetes', EVIDENCE: 'ran the migration' }],
    'circle/graph.tsv': [],
  });
  const client = createPeopleClient({ ...store, readDiaFile: () => '' });
  const r = client.whoCan('kubernetes');
  assert.equal(r.direct[0].id, 'fred');
  assert.throws(() => client.whoCan(''));
});

test('whoCan surfaces an adjacent (one-hop) person via the graph when they are not a direct hit', () => {
  const store = makeStore({
    'circle/people.tsv': [
      { ID: 'fred', NAME: 'Fred', ROLE: 'kubernetes expert', NOTE: '-', GROUP: '-' },
      { ID: 'amy', NAME: 'Amy', ROLE: 'designer', NOTE: '-', GROUP: '-' },
    ],
    'circle/capabilities.tsv': [],
    'circle/graph.tsv': [{ FROM_ID: 'amy', TO_ID: 'fred', REL: 'colleague', NOTE: '-' }],
  });
  const client = createPeopleClient({ ...store, readDiaFile: () => '' });
  const r = client.whoCan('kubernetes');
  assert.ok(r.adjacent.some(a => a.id === 'amy'));
});
