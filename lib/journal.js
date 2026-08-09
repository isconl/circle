'use strict';
/**
 * Journal. Ported from isconl-agent's server.js (list ~9775-9801,
 * add ~9803-9819, delete ~9946-9957).
 *
 * OUT OF SCOPE (deliberate): the AI annotation that runs after every add
 * (reads the entry, extracts mentioned people/money/ideas/goals) is
 * `spark`'s AI-routing concern. This is also the canvas's flagged "tightest
 * cross-engine write fan-out" judgment call -- resolved here the same way
 * as everywhere else in this split: `onEntryAdded` is an injected optional
 * hook (default no-op) a caller (spark, eventually hub) can wire to run
 * that enrichment and its cross-engine writes (a circle interaction, an
 * inbox item, spark ideas). Journal itself stays a plain, fast, reliable
 * CRUD -- the entry is saved and returned before any enrichment runs, same
 * as the original's setImmediate() being fire-and-forget.
 */

function clamp1to10(v) { const n = parseInt(v, 10); return (n >= 1 && n <= 10) ? String(n) : '-'; }

function createJournalClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    tsvEscapeText, tsvUnescapeText,
    onEntryAdded = async () => {},
    journalFile = 'spark/journal.tsv',
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createJournalClient requires readTSV/appendTSV/rewriteTSV');
  if (!tsvEscapeText || !tsvUnescapeText) throw new Error('createJournalClient requires tsvEscapeText/tsvUnescapeText');

  async function listEntries() {
    const rows = (await readTSV(journalFile)).map(r => ({
      ...r, BODY: tsvUnescapeText(r.BODY), AI_NOTE: r.AI_NOTE === '-' ? '' : tsvUnescapeText(r.AI_NOTE),
    })).reverse();

    const now = Date.now(), day = 86400000;
    const window = (days) => rows.filter(r => now - new Date(r.DATE).getTime() < days * day);
    const avg = (list, key) => {
      const vals = list.map(r => parseFloat(r[key])).filter(n => !isNaN(n));
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
    };
    const w7 = window(7), w30 = window(30);
    let streak = 0;
    const dates = new Set(rows.map(r => r.DATE));
    for (let i = 0; ; i++) {
      const d = new Date(now - i * day).toISOString().slice(0, 10);
      if (dates.has(d)) streak++;
      else if (i === 0) continue;
      else break;
    }
    return { entries: rows.slice(0, 100), stats: { total: rows.length, week: w7.length, streak,
      mood7: avg(w7, 'MOOD'), mood30: avg(w30, 'MOOD'), energy7: avg(w7, 'ENERGY'), energy30: avg(w30, 'ENERGY') } };
  }

  async function addEntry(p) {
    const body = String(p.body || '').trim();
    if (!body) throw new Error('an empty entry is not an entry');
    const row = {
      ID: `J${Date.now()}`, DATE: new Date().toISOString().slice(0, 10),
      MOOD: clamp1to10(p.mood), ENERGY: clamp1to10(p.energy),
      TAGS: String(p.tags || '').replace(/\t/g, ' ').slice(0, 120) || '-',
      BODY: tsvEscapeText(body).slice(0, 20000), AI_NOTE: '-', CREATED_AT: new Date().toISOString(),
    };
    await appendTSV(journalFile, row);
    auditLog.log('journal_entry_added', { id: row.ID, chars: body.length });
    onEntryAdded({ ...row, BODY: body }).catch(() => {});
    return { success: true, id: row.ID };
  }

  async function deleteEntry(id) {
    const removed = await rewriteTSV(journalFile, rows => rows.filter(r => r.ID !== id));
    auditLog.log('journal_entry_deleted', { id, removed });
    return { success: removed > 0 };
  }

  return { listEntries, addEntry, deleteEntry };
}

module.exports = { createJournalClient };
