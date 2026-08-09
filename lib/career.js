'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Career context - the private half of a task
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * memory/career/** has held the power map, the doctrine, the playbooks and the two
 * registers since the vault was seeded, but only the Python loader ever read them.
 * The dashboard - the thing actually used every day - could not see any of it. That
 * is why asking it to explain "Re-ask Alex the unanswered question from 24 Jul" came
 * back as generic project-management advice: the model was handed a title and
 * nothing else. It did not know who Alex is, that he is the most important
 * relationship, that he already left that question unanswered once, or that the
 * house style with him is decisions-to-make rather than problems-to-solve.
 *
 * This module answers three questions about one task, deterministically:
 *
 *   WHO does it touch      - resolved against the org's power map
 *   WHAT governs it        - decisions, risks and playbooks it cites or trips
 *   IS IT REALLY A MESSAGE - and if so, to whom, on which channel, and why that one
 *
 * No model is involved. That is the point: the task view stays useful with Ollama
 * down, and a wrong inference is visible and correctable rather than mysterious.
 *
 * ORG-AGNOSTIC BY CONSTRUCTION. The active organisation is read from _active.yaml
 * and every person, playbook, decision and risk comes from that org's own folder.
 * Nothing here names an employer or a colleague. Adding an org is a copy of
 * career/orgs/_template/, never an edit to this file.
 *
 * Plane B. Everything this module returns is private career material and must never
 * be sent to a cloud provider - callers route it through processAiChat({plane:'B'}).
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_MEMORY_DIR = path.join(__dirname, '..', 'memory');

// ── YAML, THE SMALL PART OF IT WE ACTUALLY NEED ──────────────────────────────
// This repo carries one runtime dependency on purpose, so pulling in a YAML parser
// to read six hand-maintained files is a bad trade. These files are written by us,
// in a consistent shape, and what we mostly want to hand a model is the raw block
// anyway. So: slice, do not parse. A malformed file degrades to a missing section
// rather than a thrown exception.

function readIfPresent(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; }
}

// Strip surrounding quotes and a trailing comment from a scalar value.
function cleanScalar(v) {
  let s = String(v == null ? '' : v).trim();
  s = s.replace(/\s+#.*$/, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

/** First `key: value` at any indent. Block scalars (`>-`, `|`) return folded text. */
function scalar(text, key) {
  if (!text) return '';
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^([ \\t]*)${esc}:[ \\t]*(.*)$`, 'm').exec(text);
  if (!m) return '';
  const inline = cleanScalar(m[2]);
  if (inline && !/^[>|][-+]?$/.test(inline)) return inline;

  // Folded / literal block - gather the more-indented lines beneath it.
  const indent = m[1].length;
  const lines  = text.slice(m.index).split(/\r?\n/).slice(1);
  const out    = [];
  for (const line of lines) {
    if (!line.trim()) { out.push(''); continue; }
    if (line.match(/^[ \t]*/)[0].length <= indent) break;
    out.push(line.trim());
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Everything nested under `key:`, verbatim, including the key line.
 * Used to hand a model a whole doctrine section without reshaping it.
 */
function sectionByKey(text, key) {
  if (!text) return '';
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^([ \\t]*)${esc}:[ \\t]*(.*)$`, 'm').exec(text);
  if (!m) return '';
  const indent = m[1].length;
  const lines  = text.slice(m.index).split(/\r?\n/);
  const out    = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { out.push(line); continue; }
    if (line.match(/^[ \t]*/)[0].length <= indent) break;
    out.push(line);
  }
  return out.join('\n').replace(/\s+$/, '');
}

/** A simple `- item` list under `key:`. */
function listUnder(text, key) {
  const section = sectionByKey(text, key);
  if (!section) return [];
  return section.split(/\r?\n/).slice(1)
    .map(l => l.match(/^[ \t]*-[ \t]+(.*)$/))
    .filter(Boolean)
    .map(m => cleanScalar(m[1]))
    .filter(Boolean);
}

/**
 * Slice a top-level list of records keyed by `marker`.
 * `- name: Sam Whitfield ...` in the power map, `- id: D-001 ...` in the registers.
 */
function listBlocks(text, marker) {
  if (!text) return [];
  const re = new RegExp(`^([ \\t]*)-[ \\t]+${marker}:[ \\t]*(.*)$`, 'gm');
  const starts = [];
  let m;
  while ((m = re.exec(text))) starts.push({ index: m.index, value: cleanScalar(m[2]) });
  return starts.map((s, i) => ({
    value: s.value,
    body:  text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length)
              .replace(/\s+$/, ''),
  }));
}

/** Keys of a mapping at a given indent - `P-1:`, `P-2:` under `playbooks:`. */
function mapBlocks(text, parentKey) {
  const section = sectionByKey(text, parentKey);
  if (!section) return [];
  const lines = section.split(/\r?\n/).slice(1);

  // The child indent is whatever the first non-blank line uses.
  let childIndent = null;
  for (const line of lines) {
    if (line.trim()) { childIndent = line.match(/^[ \t]*/)[0].length; break; }
  }
  if (childIndent == null) return [];

  const starts = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    if (line.match(/^[ \t]*/)[0].length !== childIndent) return;
    const km = line.match(/^[ \t]*([A-Za-z][\w.\-]*):[ \t]*(.*)$/);
    if (km) starts.push({ i, key: km[1] });
  });

  return starts.map((s, n) => ({
    key:  s.key,
    body: lines.slice(s.i, n + 1 < starts.length ? starts[n + 1].i : lines.length)
               .join('\n').replace(/\s+$/, ''),
  }));
}

// ── LOADING ──────────────────────────────────────────────────────────────────
// Cached on the mtimes of the source files, so editing the vault by hand takes
// effect on the next request without a restart. The vault is edited by hand often;
// a stale power map would quietly produce wrong advice, which is worse than slow.

let CACHE = null;

function fingerprint(files) {
  return files.map(fp => {
    try { const st = fs.statSync(fp); return `${fp}:${st.mtimeMs}:${st.size}`; }
    catch { return `${fp}:0`; }
  }).join('|');
}

function load(memoryDir = DEFAULT_MEMORY_DIR) {
  const careerDir  = path.join(memoryDir, 'career');
  const activeFile = path.join(careerDir, '_active.yaml');
  const activeOrg  = scalar(readIfPresent(activeFile), 'active_org') || null;

  const orgDir = activeOrg ? path.join(careerDir, 'orgs', activeOrg) : null;
  const files = {
    active:        activeFile,
    basePrinciples: path.join(careerDir, 'doctrine', 'principles.yaml'),
    basePlaybooks:  path.join(careerDir, 'doctrine', 'playbooks.yaml'),
    org:            orgDir && path.join(orgDir, 'org.yaml'),
    doctrine:       orgDir && path.join(orgDir, 'doctrine.yaml'),
    playbooks:      orgDir && path.join(orgDir, 'playbooks.yaml'),
    powerMap:       orgDir && path.join(orgDir, 'power_map.yaml'),
    decisions:      orgDir && path.join(orgDir, 'decision_log.yaml'),
    risks:          orgDir && path.join(orgDir, 'risk_register.yaml'),
  };

  const fp = fingerprint(Object.values(files).filter(Boolean));
  if (CACHE && CACHE.fp === fp) return CACHE.data;

  const raw = {};
  for (const [k, v] of Object.entries(files)) raw[k] = v ? readIfPresent(v) : '';

  // Org files are overlaid on the org-neutral base. Operator's own principles are the
  // floor; an employer's decoded worldview sits on top and may extend it, which is
  // exactly the layering _active.yaml describes.
  const people = listBlocks(raw.powerMap, 'name').map(b => ({
    name:      b.value,
    // The short form everyone actually writes and says ("Sam" for Sam
    // Usjaerv). Matching honours both; prose can use either.
    knownAs:   scalar(b.body, 'known_as'),
    role:      scalar(b.body, 'role'),
    email:     scalar(b.body, 'email'),
    phone:     scalar(b.body, 'phone'),
    authority: scalar(b.body, 'authority'),
    register:  scalar(b.body, 'register'),
    style:     scalar(b.body, 'style'),
    importance: scalar(b.body, 'importance'),
    status:    scalar(b.body, 'status'),
    standingAction: scalar(b.body, 'standing_action') || scalar(b.body, 'standing_instruction'),
    wants:     listUnder(b.body, 'wants'),
    cautions:  listUnder(b.body, 'cautions'),
    notes:     listUnder(b.body, 'notes'),
    lastContact: scalar(b.body, 'last_direct_contact'),
    body:      b.body,
  })).filter(p => p.name);

  const decisions = listBlocks(raw.decisions, 'id').map(b => ({
    id:     b.value,
    date:   scalar(b.body, 'date'),
    title:  scalar(b.body, 'decision'),
    status: scalar(b.body, 'status'),
    by:     scalar(b.body, 'by'),
    note:   scalar(b.body, 'note'),
    body:   b.body,
  })).filter(d => d.id);

  const risks = listBlocks(raw.risks, 'id').map(b => {
    const kwLine = /^[ \t]*keywords:[ \t]*\[(.*)\]/m.exec(b.body);
    const keywords = kwLine
      ? kwLine[1].split(',').map(s => cleanScalar(s)).filter(Boolean)
      : listUnder(b.body, 'keywords');
    return {
      id:         b.value,
      title:      scalar(b.body, 'risk'),
      severity:   scalar(b.body, 'severity'),
      protection: scalar(b.body, 'protection'),
      evidence:   scalar(b.body, 'evidence'),
      keywords,
      body:       b.body,
    };
  }).filter(r => r.id);

  // Base playbooks first, org playbooks override by key.
  const playbooks = [];
  const seenPb = new Map();
  for (const src of [raw.basePlaybooks, raw.playbooks]) {
    for (const b of mapBlocks(src, 'playbooks')) {
      const entry = { id: b.key, name: scalar(b.body, 'name') || b.key, body: b.body };
      if (seenPb.has(b.key)) playbooks[seenPb.get(b.key)] = entry;
      else { seenPb.set(b.key, playbooks.length); playbooks.push(entry); }
    }
  }

  const doctrine = {
    northStar:     scalar(raw.basePrinciples, 'north_star'),
    answerFormula: scalar(raw.doctrine, 'answer_formula') || scalar(raw.basePrinciples, 'default'),
    never:  dedupe([...listUnder(raw.basePrinciples, 'never'),  ...listUnder(raw.doctrine, 'never')]),
    always: dedupe([...listUnder(raw.basePrinciples, 'always'), ...listUnder(raw.doctrine, 'always')]),
    honestyLine: scalar(raw.doctrine, 'operating_interpretation'),
    codebook: sectionByKey(raw.doctrine, 'communication_codebook'),
  };

  // Every organisation the vault knows about, not just the active one. Past
  // engagements stay listed on purpose - a career is cumulative, and a task can
  // still be tagged to an employer that is no longer current. Scoped to the `orgs:`
  // section so the `domains:` list below it is not swept up with it.
  const orgs = listBlocks(sectionByKey(raw.active, 'orgs'), 'id').map(b => ({
    id:     b.value,
    name:   scalar(b.body, 'name'),
    role:   scalar(b.body, 'role'),
    status: scalar(b.body, 'status'),
  })).filter(o => o.id);

  const activeEntry = orgs.find(o => o.id === activeOrg);

  const data = {
    activeOrg,
    orgs,
    // Resolved from the active org's own entry rather than the first `name:` in the
    // file, which happened to be correct only because the active org is listed first.
    orgName: activeEntry?.name || scalar(raw.org, 'name') || activeOrg || '',
    role:    activeEntry?.role || scalar(raw.org, 'role') || '',
    available: Boolean(activeOrg && (people.length || decisions.length || risks.length)),
    people, decisions, risks, playbooks, doctrine,
  };

  CACHE = { fp, data };
  return data;
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter(x => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── RESOLUTION ───────────────────────────────────────────────────────────────

const wordRe = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

/**
 * People a task touches.
 *
 * Matched on the full name and on the first name alone, because the board writes
 * "Re-ask Dana ..." while the power map says "Dana Whitfield". Role words are matched
 * too, so "the CEO can sign it" resolves to whoever currently holds that role -
 * which is the whole reason roles are not hard-coded anywhere in here.
 */
function findCounterparties(title, people) {
  const hits = [];
  for (const p of people) {
    const first = p.name.split(/\s+/)[0];
    const alias = (p.knownAs || '').split(/\s+/)[0];
    let how = null;
    if (wordRe(p.name).test(title)) how = 'named';
    else if (first.length >= 3 && wordRe(first).test(title)) how = 'named';
    else if (alias.length >= 3 && wordRe(alias).test(title)) how = 'named';
    else {
      // Role words worth resolving on. Single distinctive tokens only, so
      // "supervisor" or "technical" do not drag in half the org.
      const roleTokens = (p.role || '').match(/\b(CEO|CTO|COO|CFO|chair|founder)\b/i);
      if (roleTokens && wordRe(roleTokens[1]).test(title)) how = 'by role';
    }
    if (how) hits.push({ ...p, matchedBy: how });
  }
  // Someone named in the title outranks someone resolved from a role word. "Offer
  // Alex a pre-filled approver block so the CEO can sign it" is addressed to Alex;
  // the CEO is the reason, not the recipient.
  return hits.sort((a, b) => (a.matchedBy === 'named' ? 0 : 1) - (b.matchedBy === 'named' ? 0 : 1));
}

// Verbs that mean something has to leave Operator's desk and land in someone's inbox.
const COMMS_VERBS = [
  { re: /\bre-?ask\b/i,                       intent: 'follow up on an unanswered question' },
  { re: /\bask\b|\bquestion\b|\bquery\b/i,    intent: 'ask' },
  { re: /\braise\b|\bflag\b|\bescalate\b/i,   intent: 'raise' },
  { re: /\boffer\b|\bpropose\b/i,             intent: 'offer' },
  { re: /\bsend\b|\bshare\b|\bsubmit\b/i,     intent: 'send' },
  { re: /\bthank\b|\bthank-you\b/i,           intent: 'thank' },
  { re: /\bchase\b|\bfollow up\b|\bremind\b/i,intent: 'chase' },
  { re: /\bconfirm\b|\bget .* in writing\b|\bstated once in writing\b/i, intent: 'get it in writing' },
  { re: /\bopen a (direct )?channel\b|\bintroduce\b|\breach out\b/i,     intent: 'open a channel' },
  { re: /\breply\b|\brespond\b/i,             intent: 'reply' },
  { re: /\bnotify\b|\binform\b|\bupdate .* on\b/i, intent: 'notify' },
];

/**
 * Is this task actually a message?
 *
 * Deliberately conservative. A false positive puts a draft card on a task that
 * needs code, which is noise; a false negative just means the card is absent and
 * the rest of the view still works. So: a communicative verb AND a person, or one
 * of the few verbs that cannot mean anything else.
 */
function detectComms(title, counterparties) {
  const verb = COMMS_VERBS.find(v => v.re.test(title));
  if (!verb) return { required: false };

  const unambiguous = /\bre-?ask\b|\bthank\b|\bsend\b|\bopen a (direct )?channel\b|\breach out\b/i.test(title);
  if (!counterparties.length && !unambiguous) return { required: false };

  return { required: true, intent: verb.intent, recipient: counterparties[0] || null };
}

/**
 * Which channel, and why that one.
 *
 * WhatsApp is the org's default - it is where the working relationships actually
 * live (every chat log in evidence is a WhatsApp export, and an export IS a
 * written record, which is what the record rule actually requires). Explicit
 * wording in the title overrides; email is chosen only when asked for or when
 * the person has no phone on record. Returned with its reason attached so a
 * wrong call is arguable, and the UI lets it be overridden anyway.
 */
function inferChannel(title, person) {
  if (/\bemail\b|\bmail\b/i.test(title)) return { channel: 'email', why: 'the task says email' };
  // WhatsApp even when only an email is on record: the working conversations all
  // live there (every evidence log is a WhatsApp export), and a missing phone
  // number is a gap in the power map, not a reason to switch register.
  return { channel: 'whatsapp', why: 'the default here - it is where these relationships live, and the export is still a written record' };
}

/** D-024, R-16, P-7 cited directly in a title. */
function findRefs(title, ctx) {
  const ids = new Set((title.match(/\b([DRP])-(\d{1,3})\b/gi) || []).map(s => s.toUpperCase()));
  const out = { decisions: [], risks: [], playbooks: [] };
  for (const id of ids) {
    const d = ctx.decisions.find(x => x.id.toUpperCase() === id); if (d) { out.decisions.push(d); continue; }
    const r = ctx.risks.find(x => x.id.toUpperCase() === id);     if (r) { out.risks.push(r);     continue; }
    const p = ctx.playbooks.find(x => x.id.toUpperCase() === id); if (p) out.playbooks.push(p);
  }
  return out;
}

/**
 * Risks the wording of this task trips.
 *
 * Reuses the keyword arrays already in the register - they were written to be the
 * active mechanism for exactly this, and keeping one list means tuning happens in
 * the vault rather than in code. Word-boundary matched so "claim" does not fire on
 * "reclaim", and capped, because a card listing nine risks gets ignored entirely.
 */
function matchRisks(title, risks, alreadyCited) {
  const cited = new Set(alreadyCited.map(r => r.id));
  const hits = [];
  for (const r of risks) {
    if (cited.has(r.id)) continue;
    const hit = (r.keywords || []).find(k => k && wordRe(k).test(title));
    if (hit) hits.push({ ...r, matchedOn: hit });
  }
  return hits.slice(0, 3);
}

/**
 * Playbooks worth having open.
 *
 * Relevance comes from the playbook's own name - several are written as
 * "Reviewer-relief framing (Alex / Casey)" - so the mapping lives in the vault
 * with the content instead of in a table here that would rot the moment a playbook
 * is renamed.
 */
function matchPlaybooks(title, ctx, counterparties, comms, cited) {
  const chosen = new Map();
  const add = (pb, why) => { if (pb && !chosen.has(pb.id)) chosen.set(pb.id, { ...pb, why }); };

  for (const pb of cited) add(pb, 'cited in the task');

  for (const pb of ctx.playbooks) {
    for (const cp of counterparties) {
      const tokens = [cp.name.split(/\s+/)[0], (cp.knownAs || '').split(/\s+/)[0]].filter(Boolean);
      const hit = tokens.find(tk => wordRe(tk).test(pb.name));
      if (hit) add(pb, `covers ${hit}`);
    }
  }

  if (comms.required) {
    const registers = ctx.playbooks.find(p => /register/i.test(p.name));
    add(registers, 'sets the register for each person');
  }

  // Topic overlap between the title and the playbook name, on meaningful words only.
  const words = (title.toLowerCase().match(/[a-z]{5,}/g) || []);
  for (const pb of ctx.playbooks) {
    if (chosen.has(pb.id)) continue;
    const name = pb.name.toLowerCase();
    const hit = words.find(w => name.includes(w));
    if (hit) add(pb, `on ${hit}`);
  }

  return [...chosen.values()].slice(0, 4);
}

/**
 * Everything private that bears on one task. Cheap, deterministic, always safe to
 * call - an absent vault yields `available: false` and the caller carries on.
 */
function resolveTaskContext(task, memoryDir) {
  const ctx = load(memoryDir);
  const title = String(task?.TITLE || '');

  if (!ctx.available || !title) {
    return { available: false, org: ctx.orgName || null, counterparties: [], refs: { decisions: [], risks: [], playbooks: [] }, risks: [], playbooks: [], comms: { required: false } };
  }

  const counterparties = findCounterparties(title, ctx.people);
  const refs           = findRefs(title, ctx);
  const risks          = matchRisks(title, ctx.risks, refs.risks);
  const comms          = detectComms(title, counterparties);
  const playbooks      = matchPlaybooks(title, ctx, counterparties, comms, refs.playbooks);

  if (comms.required) {
    const ch = inferChannel(title, comms.recipient);
    comms.channel = ch.channel;
    comms.channelWhy = ch.why;
  }

  return {
    available: true,
    org: ctx.orgName,
    role: ctx.role,
    counterparties,
    // The whole roster, names and roles only. A task can need a message without
    // naming anyone - "Send a weekly written status snapshot" is addressed to
    // someone, just not in the title - and the recipient picker has to be able to
    // offer more than the people the title happened to mention.
    people: ctx.people.map(p => ({ name: p.name, role: p.role })),
    refs,
    risks,
    playbooks,
    comms,
    doctrine: ctx.doctrine,
  };
}

// ── PROMPT MATERIAL ──────────────────────────────────────────────────────────
// The resolution above is for the screen. These two build the private context that
// goes to the local model, and they hand over raw vault blocks rather than the
// flattened fields - the nuance in a power-map entry lives in its prose, and
// summarising it first is exactly how a draft turns generic.

function contextBlock(resolved, { includeBodies = true } = {}) {
  if (!resolved?.available) return '';
  const L = [];

  if (resolved.org) L.push(`ORGANISATION: ${resolved.org}${resolved.role ? ` - Operator's role: ${resolved.role}` : ''}`);

  for (const p of resolved.counterparties) {
    L.push('', `PERSON: ${p.name}${p.role ? ` - ${p.role}` : ''}`);
    L.push(includeBodies ? p.body : [p.register && `register: ${p.register}`, p.style && `style: ${p.style}`].filter(Boolean).join('\n'));
  }

  const cited = [...resolved.refs.decisions, ...resolved.refs.risks];
  for (const d of cited) { L.push('', `CITED IN THE TASK - ${d.id}`); L.push(d.body); }

  for (const r of resolved.risks) {
    L.push('', `RISK THIS TRIPS - ${r.id}: ${r.title}`);
    if (r.protection) L.push(`protection: ${r.protection}`);
  }

  for (const pb of resolved.playbooks) { L.push('', `PLAYBOOK ${pb.id} (${pb.why})`); L.push(pb.body); }

  const d = resolved.doctrine || {};
  if (d.answerFormula) L.push('', `ANSWER FORMULA: ${d.answerFormula}`);
  if (d.never?.length)  L.push('', 'NEVER:', ...d.never.map(x => `- ${x}`));
  if (d.always?.length) L.push('', 'ALWAYS:', ...d.always.map(x => `- ${x}`));
  if (d.honestyLine)    L.push('', `THE HONESTY LINE: ${d.honestyLine}`);

  return L.join('\n').trim();
}

/**
 * Zoom out, then zoom in.
 *
 * Every view answers "what needs me" for its own slice, which is useful and also
 * exactly how you lose the plot - ten well-run screens and no sense of whether the
 * week is going well. This is the strip that sits above them: one line of altitude,
 * one line of the very next move, and the two or three things quietly applying
 * pressure whether or not they are on the board.
 *
 * Entirely derived. Pending decisions come from the decision log, standing actions
 * from the power map, overdue from the task rows. Nothing here is written by a
 * model, so it is instant, it is the same every time, and it can be argued with.
 */
function orient(tasks = [], today = new Date().toISOString().slice(0, 10)) {
  const ctx = load();
  const live = tasks.filter(t => (t.STATUS || '') !== 'done');
  const val  = (v) => (v && v !== '-' ? v : '');

  const overdue = live.filter(t => val(t.DUE_DATE) && t.DUE_DATE < today);
  const dueToday = live.filter(t => val(t.DUE_DATE) === today);
  const highs = live.filter(t => t.PRIORITY === 'high');

  // Decisions still owed to Operator, and the ones he owes a written record for.
  const pending = (ctx.decisions || []).filter(d => /PENDING/i.test(d.status || ''));
  const verbal  = (ctx.decisions || []).filter(d => /^VERBAL/i.test(d.status || ''));

  // The next move: soonest due among the highest priority still open.
  const rank = { high: 0, medium: 1, low: 2 };
  const next = [...live].sort((a, b) => {
    const p = (rank[a.PRIORITY] ?? 1) - (rank[b.PRIORITY] ?? 1);
    if (p) return p;
    const ad = val(a.DUE_DATE) || '9999-99-99';
    const bd = val(b.DUE_DATE) || '9999-99-99';
    return ad.localeCompare(bd);
  })[0] || null;

  const pressure = [];
  for (const p of (ctx.people || [])) {
    if (p.standingAction) {
      pressure.push({ kind: 'standing', who: p.name, text: p.standingAction });
    } else if (/zero direct contact/i.test(p.status || '')) {
      pressure.push({ kind: 'cold', who: p.name, text: `No contact on record with ${p.name}.` });
    }
  }
  if (verbal.length) {
    pressure.push({ kind: 'record', who: null,
      text: `${verbal.length} decision${verbal.length > 1 ? 's' : ''} on record as verbal only. Verbal reverses.` });
  }

  // The blind-spot check: high-consequence things the board's sort order hides.
  // Each rule is a pattern that has actually cost someone - an undated high task
  // never surfaces in a date-sorted view; a crowd of same-day due dates means the
  // day is overcommitted before it starts; a stale high task is quietly becoming
  // an apology. Deterministic, capped, and each names its task so it is one click
  // from fixed.
  const gaps = [];
  const highNoDate = live.filter(t => t.PRIORITY === 'high' && !val(t.DUE_DATE));
  for (const t of highNoDate.slice(0, 2)) {
    gaps.push({ taskId: t.ID, text: `${t.ID} is high priority with no date - it will never surface in any timeline.` });
  }
  if (dueToday.length + overdue.length >= 4) {
    gaps.push({ taskId: null, text: `${dueToday.length + overdue.length} tasks land today. That is not a plan, it is a queue - move the two that can move.` });
  }
  const stale = live.filter(t => t.PRIORITY === 'high' && val(t.CREATED_AT) &&
    (Date.parse(today) - Date.parse(t.CREATED_AT)) / 86400000 >= 5);
  for (const t of stale.slice(0, 1)) {
    gaps.push({ taskId: t.ID, text: `${t.ID} has been open ${Math.floor((Date.parse(today) - Date.parse(t.CREATED_AT)) / 86400000)} days at high priority - finish it or re-scope it.` });
  }
  // Overdue beats everything else it competes with for attention.
  for (const t of overdue.slice(0, 2)) {
    gaps.push({ taskId: t.ID, text: `${t.ID} is overdue since ${t.DUE_DATE}${t.PRIORITY === 'high' ? ' and high priority' : ''}.` });
  }
  const oldPending = pending.filter(d => d.date && (Date.parse(today) - Date.parse(d.date)) / 86400000 >= 5);
  for (const d of oldPending.slice(0, 2)) {
    gaps.push({ taskId: null, decisionId: d.id,
      text: `${d.id} has been pending on ${d.by || 'someone else'} since ${d.date} - a written nudge is cheap, silence reads as consent.` });
  }

  const outBits = [];
  if (pending.length) outBits.push(`${pending.length} decision${pending.length > 1 ? 's' : ''} pending on others`);
  if (highs.length)   outBits.push(`${highs.length} high-priority open`);
  if (overdue.length) outBits.push(`${overdue.length} overdue`);

  return {
    available: ctx.available,
    org: ctx.orgName,
    zoomOut: {
      line: outBits.length ? outBits.join(' · ') : 'Nothing pending and nothing overdue.',
      detail: pending.length
        ? `Waiting on: ${pending.slice(0, 2).map(d => `${d.id} ${d.title}`).join(' | ')}`
        : (ctx.doctrine?.northStar || ''),
    },
    zoomIn: next ? {
      line: next.TITLE,
      taskId: next.ID,
      detail: [
        next.PRIORITY,
        val(next.DUE_DATE) ? (next.DUE_DATE < today ? `overdue since ${next.DUE_DATE}`
                            : next.DUE_DATE === today ? 'due today' : `due ${next.DUE_DATE}`) : 'no date',
      ].filter(Boolean).join(' · '),
    } : { line: 'Nothing open.', detail: '', taskId: null },
    counts: { overdue: overdue.length, dueToday: dueToday.length, high: highs.length, pending: pending.length },
    pressure: pressure.slice(0, 3),
    gaps: gaps.slice(0, 3),
  };
}

module.exports = {
  load,
  resolveTaskContext,
  contextBlock,
  orient,
  // exported for tests
  _internals: { scalar, sectionByKey, listUnder, listBlocks, mapBlocks, findCounterparties, detectComms, inferChannel },
};
