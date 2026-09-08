'use strict';
/** BM26090602: circle's HTTP client for vault's GET/PUT /vault-raw/:path
 *  and GET /vault-dir/:relPath routes -- the same non-schema raw-content
 *  mechanism vault already exposes for other engines' markdown/JSON,
 *  reused here so DIA dossiers move off circle's local disk. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lib/store');

function fakeRequest(raw) {
  return async (method, path) => {
    if (path.startsWith('/vault-raw/')) {
      const relPath = decodeURIComponent(path.slice('/vault-raw/'.length));
      if (method === 'GET') return { status: 200, data: { collection: relPath, text: raw[relPath] || '' } };
    }
    if (path.startsWith('/vault-dir/')) {
      const relPath = decodeURIComponent(path.slice('/vault-dir/'.length));
      const prefix = `${relPath}/`;
      const files = Object.keys(raw).filter(k => k.startsWith(prefix)).map(k => ({ name: k.slice(prefix.length) }));
      return { status: 200, data: { path: relPath, files } };
    }
    return { status: 404, data: {} };
  };
}

// rawWrite needs a request impl that mutates state on PUT -- factored
// separately since fakeRequest above is read-only (GET/dir) by design.
function fakeRequestWithWrite(raw) {
  return async (method, path, body) => {
    if (path.startsWith('/vault-raw/')) {
      const relPath = decodeURIComponent(path.slice('/vault-raw/'.length));
      if (method === 'GET') return { status: 200, data: { collection: relPath, text: raw[relPath] || '' } };
      if (method === 'PUT') { raw[relPath] = body.text; return { status: 200, data: { ok: true, collection: relPath, bytes: body.text.length } }; }
    }
    if (path.startsWith('/vault-dir/')) {
      const relPath = decodeURIComponent(path.slice('/vault-dir/'.length));
      const prefix = `${relPath}/`;
      const files = Object.keys(raw).filter(k => k.startsWith(prefix)).map(k => ({ name: k.slice(prefix.length) }));
      return { status: 200, data: { path: relPath, files } };
    }
    return { status: 404, data: {} };
  };
}

test('rawRead returns the stored text, or empty string for a missing path', async () => {
  const raw = { 'circle/dia/alex.md': '# DIA -- Alex' };
  const store = createStore({ requestImpl: fakeRequest(raw) });
  assert.equal(await store.rawRead('circle/dia/alex.md'), '# DIA -- Alex');
  assert.equal(await store.rawRead('circle/dia/nobody.md'), '');
});

test('rawWrite round-trips through rawRead', async () => {
  const raw = {};
  const store = createStore({ requestImpl: fakeRequestWithWrite(raw) });
  await store.rawWrite('circle/dia/sam.md', '# DIA -- Sam');
  assert.equal(await store.rawRead('circle/dia/sam.md'), '# DIA -- Sam');
});

test('rawRead throws on a non-200 response', async () => {
  const store = createStore({ requestImpl: async () => ({ status: 500, data: {} }) });
  await assert.rejects(() => store.rawRead('circle/dia/x.md'));
});

test('listDir lists filenames directly under one vault-side folder', async () => {
  const raw = { 'circle/dia/alex.md': 'a', 'circle/dia/sam.md': 'b', 'circle/people.tsv': 'unrelated' };
  const store = createStore({ requestImpl: fakeRequest(raw) });
  const files = await store.listDir('circle/dia');
  assert.deepEqual(files.map(f => f.name).sort(), ['alex.md', 'sam.md']);
});

test('a relPath containing slashes round-trips through URL encoding correctly', async () => {
  const raw = {};
  const store = createStore({ requestImpl: fakeRequestWithWrite(raw) });
  await store.rawWrite('circle/dia/some-id.md', 'content');
  assert.equal(await store.rawRead('circle/dia/some-id.md'), 'content');
});
