'use strict';
/**
 * circle's capability manifest -- same lightweight MCP-tool-list stand-in
 * as vault's/pulse's/scope's manifests (Decision 003).
 */
module.exports = {
  engine: 'circle',
  version: require('../package.json').version,
  description: 'Relationships, career power-map, inbox, journal, chat-archive import.',
  capabilities: [
    { name: 'circle.people.list', method: 'GET', path: '/people', description: 'Every person, with dueIn/touch stats computed.' },
    { name: 'circle.people.upsert', method: 'POST', path: '/people', description: 'Create or update a person.' },
    { name: 'circle.people.remember', method: 'POST', path: '/people/remember', description: 'Set the standing facts for a person.' },
    { name: 'circle.touch', method: 'POST', path: '/touch', description: 'Log an interaction with someone.' },
    { name: 'circle.dia.get', method: 'GET', path: '/dia', description: 'Read a person\'s DIA profile (cached content only).' },
    { name: 'circle.analysis.get', method: 'GET', path: '/analysis', description: 'The stored circle-wide analysis.' },
    { name: 'circle.whocan', method: 'GET', path: '/whocan', description: 'Who can help with X, including one-hop adjacent people.' },
    { name: 'circle.chat.import', method: 'POST', path: '/chat-import', description: 'Import a WhatsApp/Telegram/Signal export, matched against the Circle.' },

    { name: 'inbox.add', method: 'POST', path: '/inbox', description: 'Capture a real inbound message.' },
    { name: 'inbox.update', method: 'POST', path: '/inbox/update', description: 'Edit status/tag/comment.' },
    { name: 'inbox.delete', method: 'POST', path: '/inbox/delete', description: 'Delete a captured message.' },

    { name: 'journal.list', method: 'GET', path: '/journal', description: 'Entries + mood/energy/streak stats.' },
    { name: 'journal.add', method: 'POST', path: '/journal', description: 'Add an entry.' },
    { name: 'journal.delete', method: 'POST', path: '/journal/delete', description: 'Delete an entry.' },
  ],
  // NOT wired: DIA/reach-out/draft/reply GENERATION, journal reflect/review,
  // inbox reply -- all processAiChat-dependent, spark's capability.
};
