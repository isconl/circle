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

/** Read the .txt members out of a ZIP, with no dependency -- a chat export is one small text file in a store-or-deflate zip. */
function unzipTextFiles(buf) {
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

    if (!/\.txt$/i.test(name) || /__MACOSX|\/$/.test(name)) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    try {
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
    maxBytes = 12 * 1024 * 1024,
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

    const parsed = parseChatExport(texts.map(t => t.text).join('\n'), { operatorNames });
    if (!parsed.messages.length) throw new Error('could not recognise the message format - WhatsApp, Telegram and Signal plain-text exports are supported');

    const people = await readTSV(peopleFile);
    const { matched, unmatched } = matchSpeakers(parsed, people);

    const results = [];
    for (const m of matched.slice(0, 6)) {
      const r = await generateDiaFromMessages(m.person, m.msgs).catch(e => ({ ok: false, error: String(e.message || e) }));
      if (r?.ok) {
        const last = m.msgs[m.msgs.length - 1];
        if (last?.date && /^\d{4}-\d{2}-\d{2}$/.test(last.date)) {
          const existing = await readTSV(interactionsFile);
          const key = `chatimport:${m.person.ID}:${last.date}`;
          if (!existing.some(x => (x.SUMMARY || '').includes(key))) {
            await appendTSV(interactionsFile, { ID: `X${Date.now()}${results.length}`, PERSON_ID: m.person.ID,
              DATE: last.date, CHANNEL: parsed.channel, SUMMARY: `Imported chat archive - ${m.msgs.length} messages (${key})`,
              NEXT: '-', CREATED_AT: new Date().toISOString().slice(0, 10) });
            await rewriteTSV(peopleFile, rows => rows.map(row =>
              row.ID === m.person.ID && (!row.LAST_TOUCH || row.LAST_TOUCH === '-' || row.LAST_TOUCH < last.date)
                ? { ...row, LAST_TOUCH: last.date } : row));
          }
        }
        results.push({ id: m.person.ID, name: m.person.NAME, messages: m.msgs.length, updated: true });
      } else {
        results.push({ id: m.person.ID, name: m.person.NAME, messages: m.msgs.length, updated: false,
          note: r?.error || 'no private-capable model was available - the archive is filed, re-run the import later' });
      }
    }

    markAnalysisDirty();
    auditLog.log('chat_archive_imported', { messages: parsed.messages.length, people: results.length, filed: !!filed });
    return { success: true, filed, channel: parsed.channel, messages: parsed.messages.length,
      files: texts.map(t => t.name), updated: results, unmatched: unmatched.slice(0, 8) };
  }

  return { importChat };
}

module.exports = { createChatImportClient, unzipTextFiles, parseChatExport, matchSpeakers };
