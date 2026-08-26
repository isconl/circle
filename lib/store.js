'use strict';
/**
 * Remote vault store: read/append/rewrite as a real HTTP client against
 * vault's GET/POST/PUT /vault/:collection API.
 *
 * Replaces the old local fs-based store, which read/wrote a `memoryDir`
 * directly and only worked because circle and vault happened to share one
 * host's filesystem (true in Docker Compose, false on Render, where each
 * engine is its own container). That was a KNOWN GAP flagged in this
 * file's own previous header comment -- this is the fix.
 *
 * Every call is now async. rewrite() follows the same read-modify-write
 * contract the local version used (fn(rows) => newRows), just translated
 * across the wire: GET the current rows, apply fn locally, PUT the result
 * back. Massacre-guard and previous-version-keeping safety logic now lives
 * server-side in vault (lib/store.js), which is the correct place for it
 * now that vault is the one process actually responsible for the data.
 */

const http = require('http');
const https = require('https');

function defaultRequest(baseUrl, getToken) {
  return (method, path, body) => new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = lib.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken() || ''}`,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function createStore({ baseUrl, getToken = () => '', requestImpl, auditLog = { log: () => {} } }) {
  if (!baseUrl && !requestImpl) throw new Error('createStore requires baseUrl (vault\'s URL)');
  const request = requestImpl || defaultRequest(baseUrl, getToken);

  async function read(collection) {
    const r = await request('GET', `/vault/${encodeURIComponent(collection)}`);
    if (r.status !== 200) {
      auditLog.log('circle_vault_read_failed', { collection, status: r.status });
      throw new Error(`vault read ${collection} failed: HTTP ${r.status}`);
    }
    return r.data.rows || [];
  }

  async function append(collection, row) {
    const r = await request('POST', `/vault/${encodeURIComponent(collection)}`, row);
    if (r.status !== 200) {
      auditLog.log('circle_vault_append_failed', { collection, status: r.status });
      throw new Error(`vault append ${collection} failed: HTTP ${r.status}`);
    }
    return r.data.ok;
  }

  async function rewrite(collection, fn) {
    const rows = await read(collection);
    const newRows = fn(rows);
    const r = await request('PUT', `/vault/${encodeURIComponent(collection)}`, { rows: newRows });
    if (r.status !== 200) {
      auditLog.log('circle_vault_rewrite_failed', { collection, status: r.status });
      throw new Error(`vault rewrite ${collection} failed: HTTP ${r.status}`);
    }
    return r.data.removed;
  }

  /** Upload a Buffer to OneDrive via vault's /onedrive/upload route (binary content, base64-over-the-wire). */
  async function uploadFile(folderPath, fileName, buffer, contentType) {
    const r = await request('POST', '/onedrive/upload', {
      folderPath, fileName, contentBase64: buffer.toString('base64'), contentType,
    });
    if (r.status !== 200 || !r.data.ok) {
      auditLog.log('circle_vault_upload_failed', { folderPath, fileName, status: r.status });
      return null;
    }
    return `${folderPath}/${fileName}`;
  }

  return { read, append, rewrite, uploadFile };
}

module.exports = { createStore, defaultRequest };
