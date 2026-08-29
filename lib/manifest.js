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
    { name: 'career.get', method: 'GET', path: '/career', description: "The active org's career context -- org facts, people, decisions, risks, playbooks, doctrine. ?all=1 also returns the full org registry." },

    { name: 'inbox.add', method: 'POST', path: '/inbox', description: 'Capture a real inbound message.' },
    { name: 'inbox.update', method: 'POST', path: '/inbox/update', description: 'Edit status/tag/comment.' },
    { name: 'inbox.delete', method: 'POST', path: '/inbox/delete', description: 'Delete a captured message.' },

    { name: 'journal.list', method: 'GET', path: '/journal', description: 'Entries + mood/energy/streak stats.' },
    { name: 'journal.add', method: 'POST', path: '/journal', description: 'Add an entry.' },
    { name: 'journal.update', method: 'POST', path: '/journal/update', description: 'Edit an existing entry\'s body/mood/energy/tags, stamping EDITED_AT.' },
    { name: 'journal.delete', method: 'POST', path: '/journal/delete', description: 'Delete an entry.' },

    { name: 'teams.snapshot', method: 'GET', path: '/teams', description: 'Teams board snapshot -- all teams, members, work items and queue health.' },
    { name: 'teams.save', method: 'POST', path: '/teams/save', description: 'Create or update a team.' },
    { name: 'teams.member.save', method: 'POST', path: '/teams/member', description: 'Add or edit a team member.' },
    { name: 'teams.member.remove', method: 'POST', path: '/teams/member/remove', description: 'Remove a team member (marks left, returns orphaned work).' },
    { name: 'teams.work.save', method: 'POST', path: '/teams/work', description: 'Create or edit a work item.' },
    { name: 'teams.work.move', method: 'POST', path: '/teams/work/move', description: 'Change work item status (queued/active/blocked/finished/signed).' },
  ],
  // NOT wired: DIA/reach-out/draft/reply GENERATION, journal reflect/review,
  // inbox reply -- all processAiChat-dependent, spark's capability.
};
