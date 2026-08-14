#!/usr/bin/env node
'use strict';
/**
 * circle engine -- HTTP entry point. Same boot sequence/style as vault, pulse, scope.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createStore } = require('../lib/store');
const { tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');
const { createPeopleClient } = require('../lib/people');
const { createJournalClient } = require('../lib/journal');
const { createInboxClient } = require('../lib/inbox');
const { createChatImportClient } = require('../lib/chat-import');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.CIRCLE_PORT || process.env.PORT || '8084', 10);
const BIND = process.env.CIRCLE_BIND || '127.0.0.1';
const VAULT_URL = process.env.VAULT_URL || '';
const LOGS_DIR = process.env.CIRCLE_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
// DIA/analysis content is still plain files on circle's own disk, not
// vault-owned rows -- only TSV data moved to the remote store.
const LOCAL_DIR = process.env.CIRCLE_LOCAL_DIR || path.join(__dirname, '..', 'memory');
const DIA_DIR = path.join(LOCAL_DIR, 'circle', 'dia');
const ANALYSIS_FILE = path.join(LOCAL_DIR, 'circle', 'analysis.md');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function checkAuth(req) {
  const token = process.env.CIRCLE_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('CIRCLE_TOKEN') || '';
  if (!token) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return provided.length === token.length && provided === token;
}

function readFileSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

async function main() {
  const secretsResult = await secretStore.init();
  console.log(`  secrets: ${secretsResult.source}, ${secretsResult.count} key(s)`);

  const auditLog = createAuditLog({ logsDir: LOGS_DIR });
  if (!VAULT_URL) {
    console.error('  REFUSING TO START: VAULT_URL is not configured -- circle has no data store without it.');
    process.exit(1);
  }
  const store = createStore({
    baseUrl: VAULT_URL,
    getToken: () => process.env.VAULT_TOKEN || secretStore.get('VAULT_TOKEN') || '',
    auditLog,
  });
  const readTSV = store.read, appendTSV = store.append, rewriteTSV = store.rewrite;

  let analysisDirty = false;
  const markAnalysisDirty = () => { analysisDirty = true; };

  const people = createPeopleClient({
    readTSV, appendTSV, rewriteTSV, auditLog, markAnalysisDirty,
    readDiaFile: (id) => readFileSafe(path.join(DIA_DIR, `${id}.md`)),
    readAnalysisFile: () => readFileSafe(ANALYSIS_FILE),
  });

  const journal = createJournalClient({ readTSV, appendTSV, rewriteTSV, auditLog, tsvEscapeText, tsvUnescapeText });

  // generateDia left at inbox.js's own default (a no-op) -- real generation
  // needs spark's AI routing, not wired yet.
  const inbox = createInboxClient({ readTSV, appendTSV, rewriteTSV, auditLog, markAnalysisDirty });

  const chatImport = createChatImportClient({ readTSV, appendTSV, rewriteTSV, auditLog, markAnalysisDirty });

  const tokenConfigured = !!(process.env.CIRCLE_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('CIRCLE_TOKEN'));
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
  if (!isLoopback && !tokenConfigured) {
    console.error('  REFUSING TO BIND: no CIRCLE_TOKEN/ISCONL_TOKEN configured and BIND is not loopback.');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', engine: 'circle', version: manifest.version });
    }
    if (pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, manifest);
    }

    if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

    try {
      if (pathname === '/people' && req.method === 'GET') {
        return sendJson(res, 200, { people: await people.listPeople() });
      }
      if (pathname === '/people' && req.method === 'POST') {
        return sendJson(res, 200, await people.upsertPerson(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/people/remember' && req.method === 'POST') {
        return sendJson(res, 200, await people.setRemember(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/touch' && req.method === 'POST') {
        return sendJson(res, 200, await people.logTouch(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/dia' && req.method === 'GET') {
        return sendJson(res, 200, people.readDia(url.searchParams.get('id')));
      }
      if (pathname === '/analysis' && req.method === 'GET') {
        return sendJson(res, 200, people.readAnalysis());
      }
      if (pathname === '/whocan' && req.method === 'GET') {
        return sendJson(res, 200, await people.whoCan(url.searchParams.get('q')));
      }
      if (pathname === '/chat-import' && req.method === 'POST') {
        return sendJson(res, 200, await chatImport.importChat(JSON.parse(await readBody(req) || '{}')));
      }

      if (pathname === '/inbox' && req.method === 'POST') {
        return sendJson(res, 200, await inbox.addMessage(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/inbox/update' && req.method === 'POST') {
        return sendJson(res, 200, await inbox.updateMessage(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/inbox/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await inbox.deleteMessage(p.id));
      }

      if (pathname === '/journal' && req.method === 'GET') {
        return sendJson(res, 200, await journal.listEntries());
      }
      if (pathname === '/journal' && req.method === 'POST') {
        return sendJson(res, 200, await journal.addEntry(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/journal/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await journal.deleteEntry(p.id));
      }
    } catch (e) {
      return sendJson(res, 400, { success: false, error: String(e.message || e) });
    }

    return sendJson(res, 404, { error: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND, () => {
      const actualPort = server.address().port;
      console.log(`  circle listening on ${BIND}:${actualPort}`);
      resolve({ server, store, people, journal, inbox, chatImport, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('circle failed to start:', e); process.exit(1); });
}

module.exports = { main };
