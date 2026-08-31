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
const { createStore, defaultRequest } = require('../lib/store');
const { tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');
const { createPeopleClient } = require('../lib/people');
const { createJournalClient } = require('../lib/journal');
const { createInboxClient } = require('../lib/inbox');
const { createChatImportClient } = require('../lib/chat-import');
const { createTeamsClient } = require('../lib/teams');
const career = require('../lib/career');
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
    diaDir: DIA_DIR,
    readDiaFile: (id) => readFileSafe(path.join(DIA_DIR, `${id}.md`)),
    readAnalysisFile: () => readFileSafe(ANALYSIS_FILE),
    // FM26082605: same shape as inbox.js's hook below (regenerateDia is a
    // function declaration, hoisted, and only actually called well after
    // sparkRequest/shouldTriggerDia are assigned -- safe despite textually
    // preceding their definitions here).
    generateDia: async (personId) => {
      const [peopleRows, interactions] = await Promise.all([readTSV('circle/people.tsv'), readTSV('circle/interactions.tsv')]);
      const person = peopleRows.find(p => p.ID === personId);
      return regenerateDia({ personId, personName: person && person.NAME, interactions: interactions.filter(i => i.PERSON_ID === personId) });
    },
  });

  const journal = createJournalClient({ readTSV, appendTSV, rewriteTSV, auditLog, tsvEscapeText, tsvUnescapeText });

  // BM26082601: dossier regeneration, wired to spark's AI routing.
  const SPARK_URL = process.env.SPARK_URL || '';
  const getSparkToken = () => process.env.SPARK_TOKEN || secretStore.get('SPARK_TOKEN') || '';
  const sparkRequest = SPARK_URL ? defaultRequest(SPARK_URL, getSparkToken) : null;
  // Cheap in-process burst guard (not a queue/debounce config, no
  // cross-restart persistence needed -- see the row's own "rate
  // consideration, resolved" note): skip re-triggering for the same person
  // within 60s of their last trigger, covers e.g. a chat-archive import
  // matching 20 messages to one person in one pass.
  const lastDiaTrigger = new Map();
  const DIA_TRIGGER_COOLDOWN_MS = 60 * 1000;
  function shouldTriggerDia(personId) {
    const now = Date.now();
    const last = lastDiaTrigger.get(personId) || 0;
    if (now - last < DIA_TRIGGER_COOLDOWN_MS) return false;
    lastDiaTrigger.set(personId, now);
    return true;
  }
  async function regenerateDia({ personId, personName, interactions }) {
    if (!sparkRequest) return { ok: false, error: 'SPARK_URL not configured' };
    if (!shouldTriggerDia(personId)) return { ok: false, error: 'skipped, within cooldown window' };
    const r = await sparkRequest('POST', '/generate-dia', {
      personName,
      existingSections: people.currentDiaSections(personId),
      interactions,
    });
    if (r.status !== 200) return { ok: false, error: (r.data && r.data.error) || `spark returned ${r.status}` };
    await people.writeDiaFile(personId, r.data);
    return { ok: true };
  }

  // generateDia: inbox.js's hook only receives the person ID (per its own
  // call site, inbox.js:87) -- resolve name + full interaction history here.
  const inbox = createInboxClient({
    readTSV, appendTSV, rewriteTSV, auditLog, markAnalysisDirty,
    generateDia: async (personId) => {
      const [peopleRows, interactions] = await Promise.all([readTSV('circle/people.tsv'), readTSV('circle/interactions.tsv')]);
      const person = peopleRows.find(p => p.ID === personId);
      return regenerateDia({ personId, personName: person && person.NAME, interactions: interactions.filter(i => i.PERSON_ID === personId) });
    },
  });

  // Raw archive filed to OneDrive via vault (lib/store.js's uploadFile, wired
  // 18 Aug once vault's /onedrive/upload route could take binary content).
  const CHAT_ARCHIVE_FOLDER = process.env.CIRCLE_CHAT_ARCHIVE_FOLDER || 'Sconl/Core/Apex/Circle/chat-archives';
  // Speaker names that mean "Architect himself", so his own messages get
  // excluded from matching instead of showing up as an unmatched speaker
  // (found live 18 Aug: "Architect" had 26 unmatched messages in a real import
  // because this was never configured -- parseChatExport() always accepted
  // an operatorNames list, nothing ever passed one in).
  const OPERATOR_NAMES = (process.env.CIRCLE_OPERATOR_NAMES || 'Architect').split(',').map(s => s.trim()).filter(Boolean);
  const chatImport = createChatImportClient({
    readTSV, appendTSV, rewriteTSV, auditLog, markAnalysisDirty, operatorNames: OPERATOR_NAMES,
    fileArchive: (buf, fileName) => store.uploadFile(CHAT_ARCHIVE_FOLDER, fileName, buf, 'application/zip'),
    // generateDiaFromMessages: chat-import.js's call site passes (m.person,
    // m.msgs) -- m.person is a circle/people.tsv row, m.msgs is
    // {date, who, text}[]. Convert to interaction-shaped summaries.
    generateDiaFromMessages: async (person, msgs) => {
      const interactions = (msgs || []).map(m => ({ DATE: m.date, CHANNEL: 'chat-import', SUMMARY: String(m.text || '').slice(0, 160) }));
      return regenerateDia({ personId: person.ID, personName: person.NAME, interactions });
    },
  });

  const teams = createTeamsClient({ readTSV, appendTSV, rewriteTSV, auditLog });

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
      // FM26082801: admin on-demand trigger -- regenerateDia() itself was
      // already real/working, just unreachable outside a real inbox/
      // chat-import event. Same personId->interactions resolution as
      // inbox.js's hook above.
      if (pathname.startsWith('/people/') && pathname.endsWith('/regenerate-dia') && req.method === 'POST') {
        const personId = pathname.slice('/people/'.length, -'/regenerate-dia'.length);
        const [peopleRows, interactions] = await Promise.all([readTSV('circle/people.tsv'), readTSV('circle/interactions.tsv')]);
        const person = peopleRows.find(p => p.ID === personId);
        if (!person) return sendJson(res, 404, { ok: false, error: 'person not found' });
        return sendJson(res, 200, await regenerateDia({
          personId, personName: person.NAME,
          interactions: interactions.filter(i => i.PERSON_ID === personId),
        }));
      }
      if (pathname === '/analysis' && req.method === 'GET') {
        return sendJson(res, 200, people.readAnalysis());
      }
      if (pathname === '/whocan' && req.method === 'GET') {
        return sendJson(res, 200, await people.whoCan(url.searchParams.get('q')));
      }
      if (pathname === '/career' && req.method === 'GET') {
        // Career context for the active org (or every org, if ?all=1) --
        // circle owns this file/YAML read (lib/career.js); other engines
        // (scope's decisions/corporate clients) reach it over HTTP rather
        // than reading career/ off their own disk.
        const ctx = career.load(LOCAL_DIR);
        if (url.searchParams.get('all') === '1') return sendJson(res, 200, ctx);
        const { activeOrg, orgName, role, people: ppl, decisions, risks, playbooks, doctrine, available } = ctx;
        return sendJson(res, 200, { activeOrg, orgName, role, available,
          orgs: ctx.orgs, people: ppl, decisions, risks, playbooks, doctrine });
      }
      if (pathname === '/career/orgs/discover' && req.method === 'POST') {
        // BC26082006 -- vault's corporate-discovery pass POSTs here after
        // scanning Sconl/Core/Axial/Visionary/Corporate/ on OneDrive. circle
        // owns the actual write (career.writeOrgStub); idempotent per-org, so
        // a re-post of an already-known id is a no-op, not an error.
        const body = JSON.parse(await readBody(req) || '{}');
        const created = [];
        const skipped = [];
        for (const org of (body.orgs || [])) {
          try {
            const r = career.writeOrgStub(LOCAL_DIR, org);
            (r.created ? created : skipped).push(r.id);
          } catch (e) {
            skipped.push(org.id || '(unknown)');
          }
        }
        return sendJson(res, 200, { created, skipped });
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
      if (pathname === '/journal/update' && req.method === 'POST') {
        return sendJson(res, 200, await journal.updateEntry(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/journal/delete' && req.method === 'POST') {
        const p = JSON.parse(await readBody(req) || '{}');
        return sendJson(res, 200, await journal.deleteEntry(p.id));
      }

      // Teams OS routes (BM26082802)
      if (pathname === '/teams' && req.method === 'GET') {
        return sendJson(res, 200, await teams.snapshot());
      }
      if (pathname === '/teams/save' && req.method === 'POST') {
        return sendJson(res, 200, await teams.saveTeam(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/teams/member' && req.method === 'POST') {
        return sendJson(res, 200, await teams.saveMember(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/teams/member/remove' && req.method === 'POST') {
        return sendJson(res, 200, await teams.removeMember(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/teams/work' && req.method === 'POST') {
        return sendJson(res, 200, await teams.saveWork(JSON.parse(await readBody(req) || '{}')));
      }
      if (pathname === '/teams/work/move' && req.method === 'POST') {
        return sendJson(res, 200, await teams.moveWork(JSON.parse(await readBody(req) || '{}')));
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
