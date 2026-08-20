'use strict';
/**
 * Chat archive import -- the deterministic half. Ported from isconl-agent's
 * server.js (unzipTextFiles/parseChatExport ~1358-1462, speaker-matching
 * and touch-logging carved out of /api/circle/import-chat ~10822-10952).
 *
 * OUT OF SCOPE (deliberate): reading the matched messages into a DIA
 * profile is a `spark` (AI routing) capability -- `generateDiaFromMessages`
 * is an injected hook (default: reports every match as "not updated") a
 * caller wires once spark exists. Filing the raw archive to OneDrive is
 * `vault`'s Graph client -- `fileArchive` is injected too.
 */

const zlib = require('zlib');

/**
 * Read the .txt members out of a ZIP, with no dependency -- a single chat
 * export is one small text file in a store-or-deflate zip. Recurses into
 * nested .zip members (depth-limited) -- WhatsApp's own "export all chats"
 * flow (and Sconl's own consolidated Downloads zip, 20 Aug) produces a
 * zip-of-zips, one member .zip per 1:1 chat, not a flat .txt list -- so a
 * single top-level unzip alone silently found nothing on that real file.
 */
function unzipTextFiles(buf, depth = 0) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    const isTxt = /\.txt$/i.test(name);
    const isNestedZip = /\.zip$/i.test(name) && depth < 4;
    if ((!isTxt && !isNestedZip) || /__MACOSX|\/$/.test(name)) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    try {
      if (isNestedZip) {
        const inflated = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
        if (inflated) {
          // Each nested zip keeps its own filename as the conversation
          // label (one export == one person's chat), so a multi-person
          // consolidated zip still parses each chat separately downstream.
          for (const inner of unzipTextFiles(inflated, depth + 1)) out.push({ name: `${name}/${inner.name}`, text: inner.text });
        }
        continue;
      }
      const text = method === 0 ? raw.toString('utf8')
                 : method === 8 ? zlib.inflateRawSync(raw).toString('utf8')
                 : null;
      if (text) out.push({ name, text });
    } catch { /* skip an unreadable member rather than failing the import */ }
  }
  return out;
}

/** Parse a plain-text chat export (WhatsApp/Telegram/Signal) into dated messages per speaker. */
function parseChatExport(raw, { operatorNames = [] } = {}) {
  const lines = String(raw).replace(/‎|‏/g, '').split(/\r?\n/);
  const messages = [];
  const iso = (d, m, y) => {
    let yy = parseInt(y, 10); if (yy < 100) yy += 2000;
    let dd = parseInt(d, 10), mm = parseInt(m, 10);
    if (dd > 12 && mm <= 12) { /* already day-first */ }
    else if (mm > 12 && dd <= 12) { const t = dd; dd = mm; mm = t; }
    return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  };
  const SYSTEM_LINE = /^(messages and calls are end-to-end|you (created|added|joined)|.* (added|removed|left|joined) |this message was deleted|<media omitted>|missed (voice|video) call)/i;
  const PATTERNS = [
    /^\[?(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4}),?\s+(\d{1,2}:\d{2})(?::\d{2})?\s*(?:[APap]\.?[Mm]\.?)?\]?\s*[-–—]?\s*([^:]{1,60}):\s?([\s\S]*)$/,
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}:\d{2})(?::\d{2})?\s*[-–—]?\s*([^:]{1,60}):\s?([\s\S]*)$/,
  ];
  for (const line of lines) {
    if (!line.trim()) continue;
    let m = line.match(PATTERNS[0]);
    let date = null, who = null, text = null;
    if (m) { date = iso(m[1], m[2], m[3]); who = m[5].trim(); text = m[6]; }
    else {
      m = line.match(PATTERNS[1]);
      if (m) { date = `${m[1]}-${m[2]}-${m[3]}`; who = m[5].trim(); text = m[6]; }
    }
    if (date && who) {
      if (SYSTEM_LINE.test(text || '')) continue;
      messages.push({ date, who, text: String(text || '').trim() });
    } else if (messages.length && !SYSTEM_LINE.test(line.trim())) {
      messages[messages.length - 1].text += ' ' + line.trim();
    }
  }
  const bySpeaker = {};
  for (const msg of messages) (bySpeaker[msg.who] = bySpeaker[msg.who] || []).push(msg);
  const selfNames = ['you', 'me', ...operatorNames.map(s => String(s).trim().toLowerCase()).filter(Boolean)];
  const channel = /telegram/i.test(raw.slice(0, 400)) ? 'telegram'
                : /signal/i.test(raw.slice(0, 400)) ? 'signal' : 'whatsapp';
  return { messages, bySpeaker, selfNames, channel };
}

/** Match parsed speakers against the Circle. Unmatched speakers are REPORTED, never invented -- who belongs in the circle is his call. */
function matchSpeakers(parsed, people) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const matched = [], unmatched = [];
  for (const [speaker, msgs] of Object.entries(parsed.bySpeaker)) {
    const sn = norm(speaker);
    if (!sn || parsed.selfNames.includes(sn)) continue;
    const hit = people.find(r => {
      const full = norm(r.NAME), first = full.split(' ')[0];
      return full && (sn === full || sn.includes(full) || full.includes(sn) || (first.length > 3 && sn.includes(first)));
    });
    if (hit) matched.push({ person: hit, speaker, msgs });
    else unmatched.push({ speaker, count: msgs.length });
  }
  return { matched, unmatched: unmatched.sort((a, b) => b.count - a.count) };
}

function createChatImportClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    generateDiaFromMessages = async () => ({ ok: false, error: 'no AI provider wired' }),
    fileArchive = async () => null,       // async (buffer, fileName) => relPath|null -- vault's Graph client, injected
    markAnalysisDirty = () => {},
    operatorNames = [],
    peopleFile = 'circle/people.tsv',
    interactionsFile = 'circle/interactions.tsv',
    inboxFile = 'scope/inbox.tsv',
    // 12MB fit a single-chat export; a consolidated zip bundling every
    // person's chat (now a first-class case, parsed per-file rather than
    // joined -- see the per-file split above) is legitimately bigger.
    // 64MB still refuses anything absurd without decompressing it.
    maxBytes = 64 * 1024 * 1024,
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createChatImportClient requires readTSV/appendTSV/rewriteTSV');

  async function importChat(p) {
    if (!p.content) throw new Error('no file content');
    const buf = Buffer.from(p.content, 'base64');
    if (buf.length > maxBytes) throw new Error('archive too large - export a single chat rather than everything');

    const filed = await fileArchive(buf, p.fileName || 'chat.zip').catch(() => null);

    const texts = /^PK/.test(buf.slice(0, 2).toString('latin1'))
      ? unzipTextFiles(buf)
      : [{ name: p.fileName || 'chat.txt', text: buf.toString('utf8') }];
    if (!texts.length) throw new Error('no readable .txt chat log inside that archive');

    // Parsed PER FILE, not joined -- a consolidated zip (multiple people's
    // 1:1 exports bundled together) would otherwise lose which file each
    // message came from, since bySpeaker only disambiguates by name within
    // one parse. One export == one conversation with one other party, so
    // attributing self-authored (operator) messages in that file to the
    // SAME matched person (for the inbox thread's outbound bubbles) only
    // works file-by-file.
    const perFile = texts.map(t => ({ name: t.name, parsed: parseChatExport(t.text, { operatorNames }) }))
      .filter(f => f.parsed.messages.length);
    if (!perFile.length) throw new Error('could not recognise the message format - WhatsApp, Telegram and Signal plain-text exports are supported');

    const people = await readTSV(peopleFile);
    const allMatched = [], allUnmatched = [];
    for (const f of perFile) {
      const { matched, unmatched } = matchSpeakers(f.parsed, people);
      for (const m of matched) allMatched.push({ ...m, file: f });
      allUnmatched.push(...unmatched);
    }
    const totalMessages = perFile.reduce((n, f) => n + f.parsed.messages.length, 0);

    // Dedup key set against the SAME inbox store the general capture flow
    // (lib/inbox.js's addMessage) already writes to -- read once up front
    // rather than per-message, so a consolidated zip re-run (overlapping
    // with an earlier single-person import, or with a manually-captured
    // message) never doubles a row. Reuses inbox.tsv's own SOURCE-prefix
    // convention (`chatimport:` here, same idea as interactionsFile's key)
    // rather than a parallel table -- BM26081807's Inbox rebuild reads this
    // exact collection already (hub's /api/state -> scope/inbox.tsv).
    const existingInbox = await readTSV(inboxFile).catch(() => []);
    const seenMsgKeys = new Set(existingInbox.map(r => r.SOURCE));
    let nextIdNum = existingInbox.reduce((n, r) => Math.max(n, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0);
    const newInboxRows = [];
    const selfKey = (speaker) => operatorNames.map(s => String(s).trim().toLowerCase()).includes(String(speaker || '').toLowerCase())
      || ['you', 'me'].includes(String(speaker || '').toLowerCase());

    const results = [];
    for (const m of allMatched.slice(0, 100)) {
      const r = await generateDiaFromMessages(m.person, m.msgs).catch(e => ({ ok: false, error: String(e.message || e) }));
      // The touch itself (a real exchange happened) is logged regardless of
      // whether DIA enrichment succeeded -- matching alone is signal enough
      // to bump LAST_TOUCH; the AI summary is a bonus on top, not a
      // precondition (found live 18 Aug: a matched-but-unenriched import was
      // silently dropping this row entirely).
      const last = m.msgs[m.msgs.length - 1];
      if (last?.date && /^\d{4}-\d{2}-\d{2}$/.test(last.date)) {
        const existing = await readTSV(interactionsFile);
        const key = `chatimport:${m.person.ID}:${last.date}`;
        if (!existing.some(x => (x.SUMMARY || '').includes(key))) {
          const summary = r?.ok
            ? `Imported chat archive - ${m.msgs.length} messages (${key})`
            : `Imported chat archive - ${m.msgs.length} messages, no AI summary yet (${key})`;
          await appendTSV(interactionsFile, { ID: `X${Date.now()}${results.length}`, PERSON_ID: m.person.ID,
            DATE: last.date, CHANNEL: m.file.parsed.channel, SUMMARY: summary,
            NEXT: '-', CREATED_AT: new Date().toISOString().slice(0, 10) });
          await rewriteTSV(peopleFile, rows => rows.map(row =>
            row.ID === m.person.ID && (!row.LAST_TOUCH || row.LAST_TOUCH === '-' || row.LAST_TOUCH < last.date)
              ? { ...row, LAST_TOUCH: last.date } : row));
        }
      }

      // Per-message rows for the inbox thread view (BM26081807) -- the
      // matched party's own messages (direction in) plus the operator's own
      // messages from the SAME file (direction out), interleaved so a
      // thread reads as a real two-way conversation, not one side.
      const outMsgs = Object.entries(m.file.parsed.bySpeaker)
        .filter(([speaker]) => selfKey(speaker))
        .flatMap(([, msgs]) => msgs);
      const threadMsgs = [...m.msgs.map(x => ({ ...x, direction: 'in' })), ...outMsgs.map(x => ({ ...x, direction: 'out' }))]
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      for (const msg of threadMsgs) {
        const source = `chatimport:${m.person.ID}:${msg.direction}:${msg.date}:${msg.text.slice(0, 40)}`;
        if (seenMsgKeys.has(source)) continue;
        seenMsgKeys.add(source);
        nextIdNum += 1;
        newInboxRows.push({
          ID: `I${String(nextIdNum).padStart(3, '0')}`,
          TITLE: msg.text.slice(0, 70) || '-',
          BODY: msg.text || '-',
          // Backfilled history reads as already-seen, not a pile of new
          // unread items from a bulk import -- matches the row's own
          // "backfill-only, v1" framing (not a live stream needing triage).
          STATUS: 'seen',
          SOURCE: source,
          CAPTURED_AT: new Date().toISOString().slice(0, 10),
          CHANNEL: m.file.parsed.channel,
          SENDER: msg.direction === 'out' ? '-' : m.person.NAME,
          SUBJECT: '-',
          RECEIVED_AT: msg.date,
          TAG: '-', COMMENT: '-',
          PERSON_ID: m.person.ID,
          DIRECTION: msg.direction,
        });
      }

      if (r?.ok) {
        results.push({ id: m.person.ID, name: m.person.NAME, messages: m.msgs.length, updated: true });
      } else {
        results.push({ id: m.person.ID, name: m.person.NAME, messages: m.msgs.length, updated: false,
          note: r?.error || 'no private-capable model was available - the archive is filed, re-run the import later' });
      }
    }

    if (newInboxRows.length) {
      await rewriteTSV(inboxFile, rows => [...rows, ...newInboxRows]);
    }

    markAnalysisDirty();
    auditLog.log('chat_archive_imported', { messages: totalMessages, people: results.length, filed: !!filed, newMessages: newInboxRows.length });
    return { success: true, filed, files: perFile.length, messages: totalMessages,
      newMessages: newInboxRows.length, fileNames: texts.map(t => t.name),
      updated: results, unmatched: allUnmatched.sort((a, b) => b.count - a.count).slice(0, 8) };
  }

  return { importChat };
}

module.exports = { createChatImportClient, unzipTextFiles, parseChatExport, matchSpeakers };
