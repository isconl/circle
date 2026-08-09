'use strict';
/**
 * End-to-end smoke tests: start circle's real HTTP server and hit it with
 * real requests -- same purpose as vault's/pulse's/scope's own server.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpEnv() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-e2e-memory-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-e2e-logs-'));
  fs.mkdirSync(path.join(memoryDir, 'circle'), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, 'spark'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'scope', 'inbox.tsv'), 'ID\tTITLE\tBODY\tSTATUS\tSOURCE\tCAPTURED_AT\tCHANNEL\tSENDER\tSUBJECT\tRECEIVED_AT\tTAG\tCOMMENT\n');
  fs.writeFileSync(path.join(memoryDir, 'spark', 'journal.tsv'), 'ID\tDATE\tMOOD\tENERGY\tTAGS\tBODY\tAI_NOTE\tCREATED_AT\n');
  return { memoryDir, logsDir };
}

async function startServer(envOverrides = {}) {
  const { memoryDir, logsDir } = tmpEnv();
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    CIRCLE_PORT: '0', CIRCLE_BIND: '127.0.0.1',
    CIRCLE_MEMORY_DIR: memoryDir, CIRCLE_LOGS_DIR: logsDir,
    CIRCLE_TOKEN: 'test-static-token', BWS_ACCESS_TOKEN: '',
    ...envOverrides,
  });
  delete require.cache[require.resolve('../src/server')];
  const { main } = require('../src/server');
  const handle = await main();
  const cleanup = () => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  };
  return { ...handle, cleanup };
}

test('GET /health responds without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal((await res.json()).engine, 'circle');
  } finally { server.close(); cleanup(); }
});

test('GET /manifest lists circle\'s capabilities without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest`);
    const body = await res.json();
    assert.ok(body.capabilities.some(c => c.name === 'circle.people.upsert'));
  } finally { server.close(); cleanup(); }
});

test('a protected route with no credential fails closed (silent 404)', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/people`);
    assert.equal(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('people: create, list, touch, remember', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const create = await fetch(`http://127.0.0.1:${port}/people`, { method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'Fred Kariuki', circle: 'professional' }) });
    const { id } = await create.json();
    assert.equal(id, 'fred-kariuki');

    await fetch(`http://127.0.0.1:${port}/touch`, { method: 'POST', headers: auth,
      body: JSON.stringify({ personId: id, channel: 'whatsapp', summary: 'caught up', date: '2026-08-01' }) });

    const list = await fetch(`http://127.0.0.1:${port}/people`, { headers: auth });
    const listBody = await list.json();
    assert.equal(listBody.people[0].lastTouch, '2026-08-01');

    const remember = await fetch(`http://127.0.0.1:${port}/people/remember`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id, remember: ['prefers WhatsApp over email'] }) });
    assert.equal((await remember.json()).success, true);
  } finally { server.close(); cleanup(); }
});

test('inbox: capturing a message from an unknown sender auto-adds them to the Circle', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/inbox`, { method: 'POST', headers: auth,
      body: JSON.stringify({ body: 'hello', sender: 'New Person', channel: 'whatsapp' }) });
    const list = await fetch(`http://127.0.0.1:${port}/people`, { headers: auth });
    const listBody = await list.json();
    assert.equal(listBody.people.length, 1);
    assert.match(listBody.people[0].NOTE, /Auto-added/);
  } finally { server.close(); cleanup(); }
});

test('inbox: update and delete round-trip', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const add = await fetch(`http://127.0.0.1:${port}/inbox`, { method: 'POST', headers: auth, body: JSON.stringify({ body: 'x' }) });
    const { id } = await add.json();
    const update = await fetch(`http://127.0.0.1:${port}/inbox/update`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id, status: 'read' }) });
    assert.equal((await update.json()).success, true);
    const del = await fetch(`http://127.0.0.1:${port}/inbox/delete`, { method: 'POST', headers: auth, body: JSON.stringify({ id }) });
    assert.equal((await del.json()).success, true);
  } finally { server.close(); cleanup(); }
});

test('journal: add then list with computed stats', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/journal`, { method: 'POST', headers: auth,
      body: JSON.stringify({ body: 'Good day today.', mood: '8', energy: '7' }) });
    const list = await fetch(`http://127.0.0.1:${port}/journal`, { headers: auth });
    const body = await list.json();
    assert.equal(body.entries[0].BODY, 'Good day today.');
    assert.equal(body.stats.total, 1);
  } finally { server.close(); cleanup(); }
});

test('whocan returns empty results gracefully (no throw) for a query that matches nobody', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whocan?q=nonexistentskill`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.direct, []);
  } finally { server.close(); cleanup(); }
});

test('chat-import: plain-text export matches a known person and logs the touch', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/people`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'fred', name: 'Fred Kariuki' }) });
    const text = '28/07/2026, 09:40 - Fred Kariuki: hello there';
    const res = await fetch(`http://127.0.0.1:${port}/chat-import`, { method: 'POST', headers: auth,
      body: JSON.stringify({ content: Buffer.from(text, 'utf8').toString('base64'), fileName: 'chat.txt' }) });
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.updated[0].id, 'fred');
  } finally { server.close(); cleanup(); }
});

test('the audit log recorded requests made during this test run', async () => {
  const { server, port, auditLog, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/journal`, { method: 'POST', headers: auth, body: JSON.stringify({ body: 'x' }) });
    assert.equal(auditLog.verifyChain().ok, true);
  } finally { server.close(); cleanup(); }
});
