'use strict';
/**
 * Inbox: real inbound messages, verbatim, with Operator's controls. Ported
 * from isconl-agent's server.js (add ~10591-10685, update ~10687-10711,
 * delete ~10713-10724).
 *
 * A message from a person IS an interaction -- the Circle and the inbox
 * work as one system, never logged twice. A known sender gets the touch
 * logged; an unknown sender is auto-added to the Circle (social ring,
 * marked auto-added) so the record starts itself. This part is
 * deterministic (no AI) and stays inline, unlike the AI enrichment.
 *
 * OUT OF SCOPE (deliberate): the AI enrichment that annotates a captured
 * message (summary/tag/action-count) and the AI-generated reply
 * (/api/inbox/reply) are both `spark` concerns -- `onCaptured` is an
 * injected optional hook (default no-op), same pattern as journal.js.
 */

function clean(s) { return String(s || '').replace(/[\t\r\n]+/g, ' ').trim() || '-'; }

function createInboxClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    onCaptured = async () => {},
    generateDia = async () => {},
    markAnalysisDirty = () => {},
    inboxFile = 'scope/inbox.tsv',
    peopleFile = 'circle/people.tsv',
    interactionsFile = 'circle/interactions.tsv',
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createInboxClient requires readTSV/appendTSV/rewriteTSV');

  function nextId(prefix, rows) {
    const n = rows.reduce((m, r) => Math.max(m, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0) + 1;
    return `${prefix}${String(n).padStart(3, '0')}`;
  }

  async function addMessage(p) {
    if (!String(p.body || p.title || '').trim()) throw new Error('a message needs content');
    const rows = await readTSV(inboxFile);
    const row = {
      ID: nextId('I', rows),
      TITLE: clean(p.title || String(p.body || '').slice(0, 70)),
      BODY: clean(p.body),
      STATUS: 'new',
      SOURCE: clean(p.source || `${p.channel || 'manual'}-${(p.sender || '').split(/\s+/)[0].toLowerCase()}`),
      CAPTURED_AT: new Date().toISOString().slice(0, 10),
      CHANNEL: clean(p.channel || 'whatsapp'),
      SENDER: clean(p.sender),
      SUBJECT: clean(p.subject),
      RECEIVED_AT: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(p.received || '') ? p.received : new Date().toISOString().slice(0, 16),
      TAG: clean(p.tag), COMMENT: '-',
      PERSON_ID: '-', DIRECTION: 'in',
    };

    // A known sender gets the touch logged and their DIA refreshed; an
    // unknown sender is auto-added (social ring) so the record starts
    // itself -- Architect curates, never double-enters. Resolved before the
    // row is written so it can carry PERSON_ID like every other writer
    // (chat-import, gmail-sync, vault's outbound copy).
    if (row.SENDER && row.SENDER !== '-' && row.SENDER !== 'iSconl') {
      const senderLc = row.SENDER.toLowerCase();
      const people = await readTSV(peopleFile);
      let match = people.find(cp =>
        cp.NAME.toLowerCase() === senderLc ||
        (senderLc.startsWith(cp.NAME.toLowerCase().split(' ')[0]) && cp.NAME.toLowerCase().split(' ')[0].length > 3));
      if (!match) {
        const id = senderLc.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (id && !people.some(pp => pp.ID === id)) {
          await appendTSV(peopleFile, { ID: id, NAME: row.SENDER, CIRCLE: 'social',
            GROUP: 'inbox', ROLE: '-', MET: row.RECEIVED_AT.slice(0, 7), CHANNEL: row.CHANNEL,
            LAST_TOUCH: '-', CADENCE_DAYS: '-', STATUS: 'active', FOLDER: '-',
            NOTE: `Auto-added from inbox capture ${row.ID} - set ring, role and cadence when known` });
          auditLog.log('circle_person_auto_added', { id, from: row.ID });
          match = { ID: id };
        }
      }
      if (match) {
        row.PERSON_ID = match.ID;
        const date = String(row.RECEIVED_AT).slice(0, 10);
        await appendTSV(interactionsFile, { ID: `X${Date.now()}`, PERSON_ID: match.ID, DATE: date,
          CHANNEL: row.CHANNEL, SUMMARY: `Message captured to inbox (${row.ID}): ${row.TITLE.slice(0, 80)}`,
          NEXT: '-', CREATED_AT: new Date().toISOString().slice(0, 10) });
        await rewriteTSV(peopleFile, rws => rws.map(r => r.ID === match.ID ? { ...r, LAST_TOUCH: date } : r));
        auditLog.log('circle_touch_from_capture', { person: match.ID, inbox: row.ID });
        generateDia(match.ID).catch(() => {});
        markAnalysisDirty();
      }
    }

    await appendTSV(inboxFile, row);
    auditLog.log('inbox_added', { id: row.ID, sender: row.SENDER, channel: row.CHANNEL });

    onCaptured(row).catch(() => {});
    return { success: true, id: row.ID };
  }

  async function updateMessage(p) {
    if (!p.id) throw new Error('id required');
    let found = false;
    await rewriteTSV(inboxFile, rows => rows.map(r => {
      if (r.ID !== p.id) return r;
      found = true;
      return { ...r,
        ...(p.status !== undefined ? { STATUS: clean(p.status) } : {}),
        ...(p.tag !== undefined ? { TAG: clean(p.tag) } : {}),
        ...(p.comment !== undefined ? { COMMENT: clean(p.comment) } : {}),
      };
    }));
    if (!found) throw new Error(`No message ${p.id}`);
    auditLog.log('inbox_updated', { id: p.id, fields: ['status', 'tag', 'comment'].filter(k => p[k] !== undefined) });
    return { success: true };
  }

  async function deleteMessage(id) {
    const removed = await rewriteTSV(inboxFile, rows => rows.filter(r => r.ID !== id));
    auditLog.log('inbox_deleted', { id, removed });
    return { success: removed > 0, removed };
  }

  return { addMessage, updateMessage, deleteMessage };
}

module.exports = { createInboxClient };
