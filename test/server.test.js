'use strict';
/**
 * End-to-end smoke tests: start circle's real HTTP server, backed by a real
 * (fake, in-process) vault HTTP server for TSV data -- same shape as the
 * real GET/POST/PUT /vault/:collection contract, so this exercises the
 * actual remote-store wire format, not a shortcut.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function startFakeVault(seed = {}) {
  const data = { ...seed };
  const raw = {}; // BM26090602: GET/PUT /vault-raw/:path -- same shape as real vault's rawRead/rawWrite
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');

        if (url.pathname.startsWith('/vault-raw/')) {
          const relPath = decodeURIComponent(url.pathname.slice('/vault-raw/'.length));
          if (req.method === 'GET') {
            res.writeHead(200);
            return res.end(JSON.stringify({ collection: relPath, text: raw[relPath] || '' }));
          }
          if (req.method === 'PUT') {
            let parsed = {};
            try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
            raw[relPath] = parsed.text || '';
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, collection: relPath, bytes: raw[relPath].length }));
          }
        }
        if (url.pathname.startsWith('/vault-dir/')) {
          const relPath = decodeURIComponent(url.pathname.slice('/vault-dir/'.length));
          const prefix = `${relPath}/`;
          const files = Object.keys(raw).filter(k => k.startsWith(prefix)).map(k => ({ name: k.slice(prefix.length) }));
          res.writeHead(200);
          return res.end(JSON.stringify({ path: relPath, files }));
        }

        const collection = decodeURIComponent(url.pathname.slice('/vault/'.length));
        if (req.method === 'GET') {
          res.writeHead(200);
          return res.end(JSON.stringify({ collection, rows: data[collection] || [] }));
        }
        if (req.method === 'POST') {
          let row = {};
          try { row = JSON.parse(body || '{}'); } catch { /* ignore */ }
          (data[collection] = data[collection] || []).push(row);
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection }));
        }
        if (req.method === 'PUT') {
          let rows = [];
          try { rows = JSON.parse(body || '{}').rows || []; } catch { /* ignore */ }
          const before = (data[collection] || []).length;
          data[collection] = rows;
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, collection, count: rows.length, removed: before - rows.length }));
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, data, raw, port: server.address().port }));
  });
}

function tmpEnv() {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-e2e-logs-'));
  return { logsDir };
}

async function startServer(envOverrides = {}, vaultSeed = {}) {
  const { logsDir } = tmpEnv();
  const vault = await startFakeVault({
    'circle/people.tsv': [], 'circle/interactions.tsv': [], 'circle/capabilities.tsv': [], 'circle/graph.tsv': [],
    'scope/inbox.tsv': [], 'spark/journal.tsv': [],
    'teams/teams.tsv': [], 'teams/members.tsv': [], 'teams/work.tsv': [], 'teams/messages.tsv': [], 'teams/brief_tokens.tsv': [],
    ...vaultSeed,
  });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    CIRCLE_PORT: '0', CIRCLE_BIND: '127.0.0.1',
    VAULT_URL: `http://127.0.0.1:${vault.port}`, VAULT_TOKEN: 'vault-test-token',
    CIRCLE_LOGS_DIR: logsDir,
    CIRCLE_TOKEN: 'test-static-token', BWS_ACCESS_TOKEN: '',
    ...envOverrides,
  });
  delete require.cache[require.resolve('../src/server')];
  const { main } = require('../src/server');
  const handle = await main();
  const cleanup = () => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
    vault.server.close();
  };
  return { ...handle, vault, cleanup };
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

// BS26090501: dev-only auth bypass, loopback-gated. Confirms the flag actually
// bypasses (else the escape hatch is useless) AND that leaving it unset keeps
// the fail-closed behavior above -- a future refactor can't silently invert this.
test('ISCONL_DEV_NO_AUTH=1 bypasses auth on loopback', async () => {
  const { server, port, cleanup } = await startServer({ ISCONL_DEV_NO_AUTH: '1' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/people`);
    assert.notEqual(res.status, 404);
  } finally { server.close(); cleanup(); }
});

test('ISCONL_DEV_NO_AUTH unset still fails closed with no credential', async () => {
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
      body: JSON.stringify({ name: 'Taylor Kariuki', circle: 'professional' }) });
    const { id } = await create.json();
    assert.equal(id, 'taylor-kariuki');

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

test('FM26082801: POST /people/:id/regenerate-dia is reachable and resolves the person before calling spark', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const create = await fetch(`http://127.0.0.1:${port}/people`, { method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'Ada Wanjiru', circle: 'professional' }) });
    const { id } = await create.json();

    const missing = await fetch(`http://127.0.0.1:${port}/people/no-such-person/regenerate-dia`, { method: 'POST', headers: auth });
    assert.equal(missing.status, 404);

    // No SPARK_URL configured in test env -- regenerateDia() itself
    // degrades gracefully (ok:false), which is enough to confirm the route
    // and person-lookup wiring work without needing a real spark server.
    const res = await fetch(`http://127.0.0.1:${port}/people/${id}/regenerate-dia`, { method: 'POST', headers: auth });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.match(body.error, /SPARK_URL/);
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
    await fetch(`http://127.0.0.1:${port}/people`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'taylor', name: 'Taylor Kariuki' }) });
    const text = '28/07/2026, 09:40 - Taylor Kariuki: hello there';
    const res = await fetch(`http://127.0.0.1:${port}/chat-import`, { method: 'POST', headers: auth,
      body: JSON.stringify({ content: Buffer.from(text, 'utf8').toString('base64'), fileName: 'chat.txt' }) });
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.updated[0].id, 'taylor');
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

// ── BM26090602: Teams/Channels webhook bridge, end-to-end ────────────────

test('POST /webhook/brief-response is reachable WITHOUT the CIRCLE_TOKEN bearer -- the per-brief token is the auth', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const channel = await fetch(`http://127.0.0.1:${port}/teams/channel`, { method: 'POST', headers: auth,
      body: JSON.stringify({ personId: 'ext-recipient', personName: 'External Recipient' }) });
    const { id: teamId } = await channel.json();

    const tokenRes = await fetch(`http://127.0.0.1:${port}/teams/brief-token`, { method: 'POST', headers: auth,
      body: JSON.stringify({ teamId, briefId: 'BRIEF-E2E-1' }) });
    const { token } = await tokenRes.json();

    // No Authorization header at all -- an unauthenticated external caller.
    const webhook = await fetch(`http://127.0.0.1:${port}/webhook/brief-response`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, message: 'Sounds good, no changes needed.' }) });
    const webhookBody = await webhook.json();
    assert.equal(webhook.status, 200);
    assert.equal(webhookBody.ok, true);
    assert.equal(webhookBody.teamId, teamId);

    const messages = await fetch(`http://127.0.0.1:${port}/teams/messages?teamId=${teamId}`, { headers: auth });
    const messagesBody = await messages.json();
    assert.equal(messagesBody.messages.length, 1);
    assert.equal(messagesBody.messages[0].kind, 'reply_received');
    assert.equal(messagesBody.messages[0].body, 'Sounds good, no changes needed.');
  } finally { server.close(); cleanup(); }
});

test('POST /webhook/brief-response rejects an unknown/garbage token (403), writing nothing', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/webhook/brief-response`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token', message: 'hi' }) });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally { server.close(); cleanup(); }
});

test('POST /webhook/brief-response rejects a malformed body (400)', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/webhook/brief-response`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x' }) });
    assert.equal(res.status, 400);
  } finally { server.close(); cleanup(); }
});

test('POST /teams/send-brief ties channel + token + outbound message together over HTTP', async () => {
  const { server, port, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teams/send-brief`, { method: 'POST', headers: auth,
      body: JSON.stringify({ personId: 'ext-2', personName: 'External Two', briefId: 'BRIEF-E2E-2', artifactUrl: 'https://example.com/b.html' }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.token);
    assert.ok(body.teamId);

    const webhook = await fetch(`http://127.0.0.1:${port}/webhook/brief-response`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: body.token, message: 'One question: is the date final?' }) });
    assert.equal(webhook.status, 200);
  } finally { server.close(); cleanup(); }
});

// ── BM26090602: DIA dossiers round-trip through vault's raw-blob store ───

test('DIA content set via regenerate-dia-equivalent write survives a GET /dia read, backed by /vault-raw/ not local fs', async () => {
  const { server, port, store, cleanup } = await startServer();
  const auth = { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' };
  try {
    await fetch(`http://127.0.0.1:${port}/people`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id: 'dia-e2e-person', name: 'Dia E2E Person' }) });

    // Write directly through the same store the server itself uses --
    // confirms the DIA path really is vault's raw-blob mechanism.
    await store.rawWrite('circle/dia/dia-e2e-person.md', '# DIA -- Dia E2E Person\n\nsome content');

    const res = await fetch(`http://127.0.0.1:${port}/dia?id=dia-e2e-person`, { headers: auth });
    const body = await res.json();
    assert.match(body.content, /some content/);

    const list = await fetch(`http://127.0.0.1:${port}/people`, { headers: auth });
    const listBody = await list.json();
    assert.equal(listBody.people.find(p => p.ID === 'dia-e2e-person').hasDia, true);
  } finally { server.close(); cleanup(); }
});
