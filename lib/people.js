'use strict';
/**
 * The Circle: people, touches, DIA (read side), and "who can help with X".
 * Ported from isconl-agent's server.js (~8781-9064).
 *
 * OUT OF SCOPE (deliberate, same reasoning as every sibling engine): DIA
 * profile GENERATION, reach-out generation, and circle-draft generation all
 * call processAiChat -- a `spark` (AI routing) capability. This module reads
 * whatever DIA content already exists on disk and lets a caller trigger
 * regeneration via an injected `generateDia` hook (default no-op) rather
 * than hard-depending on spark.
 *
 * CROSS-ENGINE: `ensureCircleFolder`/`graphRequest` (OneDrive folder
 * creation) is `vault`'s Graph client -- injected, optional; folder
 * creation is skipped (not faked) when unset.
 */

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function circleFolderFor(circle, id) {
  const base = circle === 'family' ? 'Circle/Family' : circle === 'professional' ? 'Circle/Professional' : 'Circle/Social';
  return `${base}/${id}`;
}

function createPeopleClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    diaDir,                                       // absolute path to memory/circle/dia -- required for DIA read
    generateDia = async () => ({ ok: false, error: 'no AI provider wired' }),
    ensureFolder = async () => false,              // async (folderPath) => boolean -- vault's Graph client, injected
    markAnalysisDirty = () => {},
    peopleFile = 'circle/people.tsv',
    interactionsFile = 'circle/interactions.tsv',
    capabilitiesFile = 'circle/capabilities.tsv',
    graphFile = 'circle/graph.tsv',
    readDiaFile = (id) => null,                    // (id) => string|null -- injected so tests don't need real fs
    readAnalysisFile = () => null,
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createPeopleClient requires readTSV/appendTSV/rewriteTSV');

  async function listPeople() {
    const people = await readTSV(peopleFile);
    const touches = await readTSV(interactionsFile);
    const today = new Date().toISOString().slice(0, 10);
    return people.map(p => {
      const mine = touches.filter(t => t.PERSON_ID === p.ID).sort((a, b) => String(b.DATE).localeCompare(String(a.DATE)));
      const last = (p.LAST_TOUCH && p.LAST_TOUCH !== '-') ? p.LAST_TOUCH : (mine[0]?.DATE || '');
      const cadence = parseInt(p.CADENCE_DAYS, 10) || 0;
      let dueIn = null;
      if (cadence && last) dueIn = cadence - Math.round((Date.parse(today) - Date.parse(last)) / 864e5);
      else if (cadence && !last) dueIn = -1;
      const dia = readDiaFile(p.ID);
      return { ...p, lastTouch: last || null, dueIn, touchCount: mine.length, recent: mine.slice(0, 8),
        hasDia: !!dia, touchDates: mine.slice(0, 400).map(t => t.DATE) };
    });
  }

  async function upsertPerson(p) {
    if (!String(p.name || '').trim()) throw new Error('a person needs a name');
    const id = p.id || String(p.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const rows = await readTSV(peopleFile);
    if (rows.some(r => r.ID === id) && !p.id) throw new Error(`${id} already exists - pass id to update`);

    if (p.id && rows.some(r => r.ID === id)) {
      await rewriteTSV(peopleFile, all => all.map(r => r.ID === id ? { ...r,
        NAME: clean(p.name), CIRCLE: clean(p.circle || r.CIRCLE), GROUP: clean(p.group || r.GROUP),
        ROLE: clean(p.role || r.ROLE), CHANNEL: clean(p.channel || r.CHANNEL),
        CADENCE_DAYS: clean(p.cadence || r.CADENCE_DAYS), NOTE: clean(p.note || r.NOTE),
        EMAIL: p.email !== undefined ? clean(p.email) : (r.EMAIL || '-') } : r));
      auditLog.log('circle_person_saved', { id });
      return { success: true, id };
    }

    const circle = ['family', 'professional', 'social'].includes(p.circle) ? p.circle : 'social';
    const folder = clean(p.folder) !== '-' ? clean(p.folder) : circleFolderFor(circle, id);
    await appendTSV(peopleFile, { ID: id, NAME: clean(p.name), CIRCLE: circle,
      GROUP: clean(p.group), ROLE: clean(p.role), MET: clean(p.met), CHANNEL: clean(p.channel),
      LAST_TOUCH: '-', CADENCE_DAYS: clean(p.cadence), STATUS: 'active', FOLDER: folder,
      NOTE: clean(p.note), REMEMBER: clean(p.remember), EMAIL: clean(p.email) });
    ensureFolder(folder).catch(() => {});
    auditLog.log('circle_person_saved', { id });
    generateDia(id).catch(() => {});
    markAnalysisDirty();
    return { success: true, id };
  }

  async function setRemember(p) {
    if (!p.id) throw new Error('which person?');
    let found = false;
    await rewriteTSV(peopleFile, rows => rows.map(r => {
      if (r.ID !== p.id) return r;
      found = true;
      const list = Array.isArray(p.remember) ? p.remember : String(p.remember || '').split(';').map(s => s.trim()).filter(Boolean);
      return { ...r, REMEMBER: list.length ? list.join('; ').replace(/[\t\r\n]+/g, ' ').slice(0, 2000) : '-' };
    }));
    if (!found) throw new Error(`No person ${p.id}`);
    auditLog.log('circle_remember_set', { person: p.id });
    return { success: true };
  }

  async function logTouch(p) {
    if (!p.personId) throw new Error('who was it');
    const date = /^\d{4}-\d{2}-\d{2}/.test(p.date || '') ? p.date.slice(0, 10) : new Date().toISOString().slice(0, 10);
    await appendTSV(interactionsFile, { ID: `X${Date.now()}`, PERSON_ID: p.personId, DATE: date,
      CHANNEL: clean(p.channel), SUMMARY: clean(p.summary), NEXT: clean(p.next), CREATED_AT: new Date().toISOString().slice(0, 10) });
    await rewriteTSV(peopleFile, rows => rows.map(r => r.ID === p.personId ? { ...r, LAST_TOUCH: date } : r));
    auditLog.log('circle_touch_logged', { person: p.personId, channel: clean(p.channel) });
    generateDia(p.personId).catch(() => {});
    markAnalysisDirty();
    return { success: true };
  }

  function readDia(id) {
    if (!/^[\w-]+$/.test(id || '')) throw new Error('bad id');
    return { content: readDiaFile(id) || '' };
  }

  function readAnalysis() {
    return { content: readAnalysisFile() || '' };
  }

  /** Who can help with X, even adjacently -- pure computation over stored data, no model call. */
  async function whoCan(q) {
    const query = String(q || '').toLowerCase().trim();
    if (!query) throw new Error('ask something');
    const terms = query.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const people = await readTSV(peopleFile);
    const caps = await readTSV(capabilitiesFile);
    const edges = await readTSV(graphFile);

    const scored = people.map(p => {
      let score = 0; const why = [];
      const hay = `${p.ROLE} ${p.NOTE} ${p.GROUP}`.toLowerCase();
      terms.forEach(t => { if (hay.includes(t)) score += 2; });
      caps.filter(c => c.PERSON_ID === p.ID).forEach(c => {
        const chay = `${c.CAPABILITY} ${c.EVIDENCE}`.toLowerCase();
        terms.forEach(t => { if (chay.includes(t)) { score += 4; why.push(`${c.CAPABILITY} (${c.EVIDENCE.slice(0, 70)})`); } });
      });
      const dia = (readDiaFile(p.ID) || '').toLowerCase();
      terms.forEach(t => { if (dia.includes(t)) score += 1; });
      return { id: p.ID, name: p.NAME, circle: p.CIRCLE, role: p.ROLE, score, why: [...new Set(why)] };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    const topIds = new Set(scored.slice(0, 5).map(x => x.id));
    const adjacent = [];
    edges.forEach(e => {
      [[e.FROM_ID, e.TO_ID], [e.TO_ID, e.FROM_ID]].forEach(([a, b]) => {
        if (topIds.has(b) && !topIds.has(a)) {
          const person = people.find(pp => pp.ID === a);
          const target = scored.find(s => s.id === b);
          if (person && target && !adjacent.some(x => x.id === a)) {
            adjacent.push({ id: a, name: person.NAME, via: target.name, rel: e.REL,
              note: `knows ${target.name} (${e.REL}${e.NOTE !== '-' ? `: ${e.NOTE.slice(0, 60)}` : ''})` });
          }
        }
      });
    });
    return { direct: scored.slice(0, 8), adjacent: adjacent.slice(0, 5) };
  }

  return { listPeople, upsertPerson, setRemember, logTouch, readDia, readAnalysis, whoCan, circleFolderFor };
}

module.exports = { createPeopleClient, circleFolderFor };
