'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { createChatImportClient, unzipTextFiles, parseChatExport, matchSpeakers } = require('../lib/chat-import');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: (rel) => (data[rel] || []).slice(),
    appendTSV: (rel, row) => { (data[rel] = data[rel] || []).push(row); },
    rewriteTSV: (rel, fn) => {
      const before = (data[rel] || []).length;
      data[rel] = fn((data[rel] || []).slice());
      return before - data[rel].length;
    },
  };
}

// Minimal store-method (uncompressed) ZIP builder -- just enough to exercise unzipTextFiles.
function buildZip(files) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);   // store, no compression
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);  // crc (unchecked by our reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([local, nameBuf, data]);
    localParts.push(localEntry);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuf]));
    offset += localEntry.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

test('unzipTextFiles extracts .txt members and skips others', () => {
  const zip = buildZip([
    { name: 'chat.txt', data: Buffer.from('hello world', 'utf8') },
    { name: 'image.jpg', data: Buffer.from('not text', 'utf8') },
  ]);
  const out = unzipTextFiles(zip);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'chat.txt');
  assert.equal(out[0].text, 'hello world');
});

test('unzipTextFiles returns an empty array for a non-zip buffer', () => {
  assert.deepEqual(unzipTextFiles(Buffer.from('not a zip')), []);
});

test('parseChatExport recognises WhatsApp-style lines and groups messages by speaker', () => {
  const raw = [
    '28/07/2026, 09:40 - Alex Tambur: Did you see the deck?',
    '28/07/2026, 09:41 - You: Not yet, looking now',
    '28/07/2026, 09:42 - Alex Tambur: no rush',
  ].join('\n');
  const parsed = parseChatExport(raw);
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.bySpeaker['Alex Tambur'].length, 2);
  assert.equal(parsed.channel, 'whatsapp');
});

test('parseChatExport drops system lines and folds continuation lines into the previous message', () => {
  const raw = [
    '28/07/2026, 09:40 - Alex Tambur: first line',
    'a continuation with no timestamp',
    '28/07/2026, 09:41 - Alex Tambur: Messages and calls are end-to-end encrypted.',
  ].join('\n');
  const parsed = parseChatExport(raw);
  assert.equal(parsed.messages.length, 1);
  assert.match(parsed.messages[0].text, /continuation/);
});

test('parseChatExport treats configured operatorNames as self, same as "you"/"me"', () => {
  const parsed = parseChatExport('28/07/2026, 09:40 - Architect: hi', { operatorNames: ['Architect'] });
  assert.ok(parsed.selfNames.includes('architect'));
});

test('matchSpeakers matches a full-name speaker and reports an unmatched one, sorted by message count', () => {
  const parsed = { bySpeaker: { 'Taylor Kariuki': [{ date: '2026-01-01', text: 'x' }], 'Unknown Person': [{ text: 'a' }, { text: 'b' }] }, selfNames: ['you', 'me'] };
  const people = [{ ID: 'taylor', NAME: 'Taylor Kariuki' }];
  const { matched, unmatched } = matchSpeakers(parsed, people);
  assert.equal(matched[0].person.ID, 'taylor');
  assert.equal(unmatched[0].speaker, 'Unknown Person');
  assert.equal(unmatched[0].count, 2);
});

test('createChatImportClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createChatImportClient({}));
});

test('importChat rejects an oversized archive without decompressing it', async () => {
  const client = createChatImportClient({ ...makeStore(), maxBytes: 10 });
  const content = Buffer.alloc(100).toString('base64');
  await assert.rejects(() => client.importChat({ content }));
});

test('importChat parses a plain-text (non-zip) export, matches the speaker, and calls the injected DIA generator', async () => {
  const store = makeStore({ 'circle/people.tsv': [{ ID: 'taylor', NAME: 'Taylor Kariuki', LAST_TOUCH: '-' }] });
  let diaCalledFor = null;
  const client = createChatImportClient({ ...store,
    generateDiaFromMessages: async (person) => { diaCalledFor = person.ID; return { ok: true }; },
  });
  const text = '28/07/2026, 09:40 - Taylor Kariuki: hello there';
  const r = await client.importChat({ content: Buffer.from(text, 'utf8').toString('base64'), fileName: 'chat.txt' });
  assert.equal(r.success, true);
  assert.equal(r.updated[0].updated, true);
  assert.equal(diaCalledFor, 'taylor');
  assert.equal(store.data['circle/interactions.tsv'].length, 1);
  assert.equal(store.data['circle/people.tsv'][0].LAST_TOUCH, '2026-07-28');
});

test('importChat reports an unmatched speaker without inventing a new Circle person', async () => {
  const store = makeStore({ 'circle/people.tsv': [] });
  const client = createChatImportClient({ ...store });
  const text = '28/07/2026, 09:40 - A Total Stranger: hello';
  const r = await client.importChat({ content: Buffer.from(text, 'utf8').toString('base64'), fileName: 'chat.txt' });
  assert.equal(r.unmatched[0].speaker, 'A Total Stranger');
  assert.equal(store.data['circle/people.tsv'].length, 0);
});

test('importChat reports updated:false with a note when the DIA generator has no provider, but still files/parses successfully', async () => {
  const store = makeStore({ 'circle/people.tsv': [{ ID: 'taylor', NAME: 'Taylor Kariuki' }] });
  const client = createChatImportClient({ ...store });   // default generateDiaFromMessages -- no provider
  const text = '28/07/2026, 09:40 - Taylor Kariuki: hello';
  const r = await client.importChat({ content: Buffer.from(text, 'utf8').toString('base64'), fileName: 'chat.txt' });
  assert.equal(r.updated[0].updated, false);
  assert.ok(r.updated[0].note);
});
