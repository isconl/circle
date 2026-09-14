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
 *
 * BM26082601: writeDiaFile() splices spark's generated {strengths,
 * weaknesses, personalityObserved, personalityInferred} JSON into an
 * existing dossier's 3.2/3.3/3.4 sections only -- never sections 1, 2,
 * 3.1, 3.5, 4, or 5, or the Historical Touches log. Plain fs.writeFileSync,
 * matching career.js's own pattern -- dia files are local-only, not part
 * of vault's OneDrive sync (existing, separate gap, not this row's job).
 */

const fs = require('fs');
const path = require('path');

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

// BM26091204 step 4: TAGS is stored as one comma-separated cell (matching
// scope/ideas.tsv's existing TAGS convention) -- parse/serialize live here
// so upsertPerson and every tag-management function below share one
// source of truth for the format, rather than each hand-rolling split/join.
function parseTags(raw) {
  return String(raw || '').split(',').map(t => t.trim()).filter(t => t && t !== '-');
}
function serializeTags(list) {
  const uniq = [...new Set(list.map(t => String(t).trim()).filter(Boolean))];
  return uniq.length ? uniq.join(', ') : '-';
}

const SDIAIF_V21_SKELETON = (name) => `# DIA -- ${name}

## 1. EXECUTIVE SUMMARY & COGNITIVE CONTEXT

(not yet written)

## 3. INDIVIDUAL PROFILE & BEHAVIORAL ARCHETYPE

### 3.2 STRENGTHS

### 3.3 WEAKNESSES & BLIND SPOTS

### 3.4 PERSONALITY TRAITS

## 5. HISTORICAL TOUCHES & LOGGED INTERACTIONS
`;

function renderStrengthsWeaknesses(items) {
  return (items || []).map(i => `- ${clean(i.text)} [evidence: ${clean(i.evidence)}]`).join('\n');
}

function renderPersonality(sections) {
  const observed = (sections.personalityObserved || []).map(t => `- ${clean(t)}`);
  const inferred = (sections.personalityInferred || []).map(i => `- ${clean(i.text)} [INFERRED: ${clean(i.basis)}]`);
  return [...observed, ...inferred].join('\n');
}

/** Splice `replacement` into the body of `heading` (e.g. "### 3.2
 *  STRENGTHS") up to the next `##`/`###` heading, or append the section at
 *  the end of the file if that heading doesn't exist yet -- an existing
 *  dossier not yet migrated to the v3 shape still gets a real section
 *  rather than silently no-op'ing (a judgment call, since the row only
 *  specified the "no dossier at all" case explicitly). */
function spliceSection(content, headingText, replacement) {
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(#{2,3}\\s+(?:[\\d.]+\\s+)?${escaped}.*?\\n)([\\s\\S]*?)(?=\\n#{2,3} |$)`);
  if (re.test(content)) {
    return content.replace(re, (_, head) => `${head}\n${replacement}\n`);
  }
  return `${content.replace(/\s*$/, '')}\n\n### ${headingText}\n\n${replacement}\n`;
}

/** Best-effort read of whatever's currently in 3.2/3.3/3.4, joined as
 *  plain text, for the "existing analysis (revise/extend)" prompt context.
 *  Empty string (not null) when nothing is there yet -- the AI prompt
 *  already treats a falsy existingSections as "nothing yet". */
function extractCurrentSections(content) {
  if (!content) return '';
  const grab = (headingText) => {
    const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = content.match(new RegExp(`#{2,3}\\s+(?:[\\d.]+\\s+)?${escaped}.*?\\n([\\s\\S]*?)(?=\\n#{2,3} |$)`));
    return m ? m[1].trim() : '';
  };
  return [grab('STRENGTHS'), grab('WEAKNESSES & BLIND SPOTS'), grab('PERSONALITY TRAITS')]
    .filter(Boolean).join('\n\n');
}

function writeDiaFileForPerson({ diaDir, readDiaFile, name, id, sections }) {
  const filePath = path.join(diaDir, `${id}.md`);
  let content = readDiaFile(id) || SDIAIF_V21_SKELETON(name || id);
  content = spliceSection(content, 'STRENGTHS', renderStrengthsWeaknesses(sections.strengths));
  content = spliceSection(content, 'WEAKNESSES & BLIND SPOTS', renderStrengthsWeaknesses(sections.weaknesses));
  content = spliceSection(content, 'PERSONALITY TRAITS', renderPersonality(sections));
  fs.writeFileSync(filePath, content);
  return { success: true, path: filePath };
}

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

    // BM26091204: TAGS is the future multi-value replacement for the scalar
    // GROUP field, additive -- there is no tag-management UI yet (that's
    // this row's own Step 4), so until it ships, TAGS is kept in lockstep
    // with GROUP as a single-item value on every write here. This is
    // deliberately NOT "GROUP wins, TAGS ignored" -- once the tag UI lands
    // and calls upsertPerson with p.tags set independently, that should be
    // honoured instead; today no caller ever passes p.tags, so the `||`
    // fallback to GROUP is the only path exercised.
    if (p.id && rows.some(r => r.ID === id)) {
      await rewriteTSV(peopleFile, all => all.map(r => r.ID === id ? { ...r,
        NAME: clean(p.name), CIRCLE: clean(p.circle || r.CIRCLE), GROUP: clean(p.group || r.GROUP),
        ROLE: clean(p.role || r.ROLE), CHANNEL: clean(p.channel || r.CHANNEL),
        CADENCE_DAYS: clean(p.cadence || r.CADENCE_DAYS), NOTE: clean(p.note || r.NOTE),
        EMAIL: p.email !== undefined ? clean(p.email) : (r.EMAIL || '-'),
        TAGS: clean(p.tags || p.group || r.TAGS) } : r));
      auditLog.log('circle_person_saved', { id });
      return { success: true, id };
    }

    const circle = ['family', 'professional', 'social'].includes(p.circle) ? p.circle : 'social';
    const folder = clean(p.folder) !== '-' ? clean(p.folder) : circleFolderFor(circle, id);
    await appendTSV(peopleFile, { ID: id, NAME: clean(p.name), CIRCLE: circle,
      GROUP: clean(p.group), ROLE: clean(p.role), MET: clean(p.met), CHANNEL: clean(p.channel),
      LAST_TOUCH: '-', CADENCE_DAYS: clean(p.cadence), STATUS: 'active', FOLDER: folder,
      NOTE: clean(p.note), REMEMBER: clean(p.remember), EMAIL: clean(p.email),
      TAGS: clean(p.tags || p.group) });
    ensureFolder(folder).catch(() => {});
    auditLog.log('circle_person_saved', { id });
    generateDia(id).catch(() => {});
    markAnalysisDirty();
    return { success: true, id };
  }

  /** Every distinct tag in use, with how many contacts carry it -- the
   *  listing a tag-management UI renders, sorted most-used first. */
  async function listTags() {
    const rows = await readTSV(peopleFile);
    const counts = new Map();
    rows.forEach(r => parseTags(r.TAGS).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Add one tag to one person, additive -- a no-op if they already carry
   *  it. This is how a tag not mirrored from GROUP first "gets created":
   *  there is no separate tag registry, a tag exists exactly where it is
   *  attached to a contact. */
  async function addTag(personId, tag) {
    const t = clean(tag);
    if (t === '-') throw new Error('a tag needs a name');
    let found = false;
    await rewriteTSV(peopleFile, rows => rows.map(r => {
      if (r.ID !== personId) return r;
      found = true;
      return { ...r, TAGS: serializeTags([...parseTags(r.TAGS), t]) };
    }));
    if (!found) throw new Error(`No person ${personId}`);
    auditLog.log('circle_tag_added', { person: personId, tag: t });
    return { success: true };
  }

  /** Remove one tag from one person only -- for removing a tag everywhere,
   *  use deleteTag instead. */
  async function removeTag(personId, tag) {
    let found = false;
    await rewriteTSV(peopleFile, rows => rows.map(r => {
      if (r.ID !== personId) return r;
      found = true;
      return { ...r, TAGS: serializeTags(parseTags(r.TAGS).filter(t => t !== tag)) };
    }));
    if (!found) throw new Error(`No person ${personId}`);
    auditLog.log('circle_tag_removed', { person: personId, tag });
    return { success: true };
  }

  /** Rename a tag across every contact that carries it. If the target name
   *  already exists on a given contact, the two collapse into one entry
   *  rather than duplicating (serializeTags dedupes). */
  async function renameTag(from, to) {
    const target = clean(to);
    if (target === '-') throw new Error('a tag needs a name');
    let touched = 0;
    await rewriteTSV(peopleFile, rows => rows.map(r => {
      const tags = parseTags(r.TAGS);
      if (!tags.includes(from)) return r;
      touched++;
      return { ...r, TAGS: serializeTags(tags.map(t => t === from ? target : t)) };
    }));
    auditLog.log('circle_tag_renamed', { from, to: target, touched });
    return { success: true, touched };
  }

  /** Combine one or more source tags into a single target tag across every
   *  contact -- e.g. folding "Viva" and "Viva Team" into one "Viva". */
  async function mergeTags(sources, into) {
    const target = clean(into);
    if (target === '-') throw new Error('a tag needs a name');
    const sourceSet = new Set((Array.isArray(sources) ? sources : [sources]).filter(Boolean));
    if (!sourceSet.size) throw new Error('nothing to merge');
    let touched = 0;
    await rewriteTSV(peopleFile, rows => rows.map(r => {
      const tags = parseTags(r.TAGS);
      if (!tags.some(t => sourceSet.has(t))) return r;
      touched++;
      return { ...r, TAGS: serializeTags(tags.map(t => sourceSet.has(t) ? target : t)) };
    }));
    auditLog.log('circle_tags_merged', { sources: [...sourceSet], into: target, touched });
    return { success: true, touched };
  }

  /** Remove a tag from every contact that carries it -- never touches
   *  GROUP, and never deletes a contact, only the tag text. */
  async function deleteTag(tag) {
    let touched = 0;
    await rewriteTSV(peopleFile, rows => rows.map(r => {
      const tags = parseTags(r.TAGS);
      if (!tags.includes(tag)) return r;
      touched++;
      return { ...r, TAGS: serializeTags(tags.filter(t => t !== tag)) };
    }));
    auditLog.log('circle_tag_deleted', { tag, touched });
    return { success: true, touched };
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

  /** (id, sections) -- the shape returned by spark's POST /generate-dia,
   *  per BM26082601. Looks up the person's name for the skeleton-fallback
   *  case only; every other write is a pure splice, no other fields read. */
  async function writeDiaFile(id, sections) {
    if (!diaDir) throw new Error('writeDiaFile requires diaDir to be configured');
    const people = await readTSV(peopleFile);
    const person = people.find(p => p.ID === id);
    return writeDiaFileForPerson({ diaDir, readDiaFile, name: person && person.NAME, id, sections });
  }

  /** For the generateDia hook's `existingSections` field -- the current
   *  3.2/3.3/3.4 content, if any, so a regenerate revises/extends rather
   *  than starting cold every time. */
  function currentDiaSections(id) {
    return extractCurrentSections(readDiaFile(id));
  }

  return { listPeople, upsertPerson, setRemember, logTouch, readDia, readAnalysis, whoCan, circleFolderFor, writeDiaFile, currentDiaSections,
    listTags, addTag, removeTag, renameTag, mergeTags, deleteTag };
}

module.exports = { createPeopleClient, circleFolderFor };
