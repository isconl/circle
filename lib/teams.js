'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Teams - the team operating system as a channel
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Built on circle for BM26082802.
 * The doctrine it encodes is ONE BOARD, FIVE PER LEADER, THREE DAYS DEEP
 *
 *   - every piece of work lives in one visible place, with five mandatory
 *     fields - what, why, who, when, and what done looks like, written
 *     BEFORE the work starts;
 *   - nobody supervises more than five people directly; the sixth person
 *     means a new leader, not a sixth report - so members carry a
 *     REPORTS_TO edge and the hierarchy is a tree of any depth;
 *   - every person carries three days of ready work, and the depth is a
 *     NUMBER the board computes, not a feeling anyone has to remember to
 *     check. Green at 3+, amber under 3, red at zero - and red is the
 *     leader's failure, surfacing two days before anyone sits idle.
 *
 * Storage is three vault TSVs (teams/teams.tsv, teams/members.tsv, teams/work.tsv),
 * accessed via circle's injected vault store.
 */

const crypto = require('crypto');

const T_TEAMS = 'teams/teams.tsv';
const T_MEMBERS = 'teams/members.tsv';
const T_WORK = 'teams/work.tsv';
// BM26090602: the external-recipient webhook bridge -- one chronological
// message log per channel, plus single-purpose per-brief tokens scoping an
// inbound reply to exactly the channel/brief it was issued for.
const T_MESSAGES = 'teams/messages.tsv';
const T_BRIEF_TOKENS = 'teams/brief_tokens.tsv';

const val = v => { const s = String(v == null ? '' : v).trim(); return (!s || s === '-') ? '' : s; };
const clean = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

function newId(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

// A brief-response token is bearer-secret-shaped (embedded in an unauthenticated
// link a recipient clicks) -- 32 bytes of crypto-random, base64url so it drops
// cleanly into a URL query param with no further encoding.
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const DEFAULT_TOKEN_TTL_DAYS = 14; // matches BA26090601's own sample-brief assumption (row 129: "e.g. 2 weeks from send")

const WORK_STATUSES = ['queued', 'active', 'blocked', 'finished', 'signed', 'dropped'];
const DEPTH_STATUSES = ['queued', 'active', 'blocked'];

const SPAN_LIMIT = 5;
const DEPTH_GREEN = 3;
const SHIP_WINDOW_DAYS = 7;

function createTeamsClient({ readTSV, appendTSV, rewriteTSV, auditLog = { log: () => {} } }) {
  async function loadAll() {
    const [teams, members, work] = await Promise.all([
      readTSV(T_TEAMS),
      readTSV(T_MEMBERS),
      readTSV(T_WORK),
    ]);
    return {
      teams: teams || [],
      members: members || [],
      work: work || [],
    };
  }

  function memberModel(team, members, work) {
    const mine = members.filter(m => m.TEAM_ID === team.ID && val(m.STATUS) !== 'left');
    const byId = Object.fromEntries(mine.map(m => [m.ID, m]));

    const children = {};
    for (const m of mine) {
      const p = val(m.REPORTS_TO);
      const key = (p && byId[p]) ? p : '_root';
      (children[key] = children[key] || []).push(m.ID);
    }

    const openWork = work.filter(w => w.TEAM_ID === team.ID && DEPTH_STATUSES.includes(val(w.STATUS)));

    const enriched = mine.map(m => {
      const items = openWork.filter(w => w.MEMBER_ID === m.ID);
      const depth = items.reduce((s, w) => s + (parseFloat(val(w.EFFORT_DAYS)) || 1), 0);
      const directs = (children[m.ID] || []).length;
      return {
        id: m.ID, personId: val(m.PERSON_ID), name: m.NAME, role: val(m.ROLE),
        reportsTo: (val(m.REPORTS_TO) && byId[m.REPORTS_TO]) ? m.REPORTS_TO : '',
        joined: val(m.JOINED_AT), note: val(m.NOTE),
        depth: +depth.toFixed(1),
        depthLevel: depth >= DEPTH_GREEN ? 'green' : depth >= 1 ? 'amber' : 'red',
        openCount: items.length,
        blockedCount: items.filter(w => val(w.STATUS) === 'blocked').length,
        directs,
        spanOver: directs > SPAN_LIMIT,
      };
    });

    let layers = 0;
    let frontier = children['_root'] || [];
    const seen = new Set();
    while (frontier.length) {
      layers++;
      const next = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(...(children[id] || []));
      }
      frontier = next;
    }

    return { members: enriched, children, layers };
  }

  function teamModel(team, members, work) {
    const mm = memberModel(team, members, work);
    const mine = work.filter(w => w.TEAM_ID === team.ID);
    const cutoff = new Date(Date.now() - SHIP_WINDOW_DAYS * 86400000).toISOString();
    const t = today();

    const counts = {
      queued: mine.filter(w => val(w.STATUS) === 'queued').length,
      active: mine.filter(w => val(w.STATUS) === 'active').length,
      blocked: mine.filter(w => val(w.STATUS) === 'blocked').length,
      awaitingSign: mine.filter(w => val(w.STATUS) === 'finished').length,
      signedWeek: mine.filter(w => val(w.STATUS) === 'signed' && val(w.SIGNED_AT) >= cutoff).length,
      slipped: mine.filter(w => DEPTH_STATUSES.includes(val(w.STATUS)) && val(w.DUE) && w.DUE < t).length,
    };
    const health = {
      green: mm.members.filter(m => m.depthLevel === 'green').length,
      amber: mm.members.filter(m => m.depthLevel === 'amber').length,
      red: mm.members.filter(m => m.depthLevel === 'red').length,
    };

    return {
      id: team.ID, title: team.TITLE, org: val(team.ORG), owner: val(team.OWNER),
      recipient: val(team.RECIPIENT), recipientPersonId: val(team.RECIPIENT_PERSON_ID),
      cadence: val(team.CADENCE) || 'weekly, Friday',
      status: val(team.STATUS) || 'active', note: val(team.NOTE),
      createdAt: val(team.CREATED_AT), updatedAt: val(team.UPDATED_AT),
      ...mm, counts, health,
      work: mine.filter(w => val(w.STATUS) !== 'dropped').map(w => ({
        id: w.ID, memberId: val(w.MEMBER_ID), title: w.TITLE, why: val(w.WHY),
        due: val(w.DUE), doneMeans: val(w.DONE_MEANS), status: val(w.STATUS) || 'queued',
        effortDays: parseFloat(val(w.EFFORT_DAYS)) || 1,
        createdAt: val(w.CREATED_AT), startedAt: val(w.STARTED_AT), finishedAt: val(w.FINISHED_AT),
        signedBy: val(w.SIGNED_BY), signedAt: val(w.SIGNED_AT),
        blockedNote: val(w.BLOCKED_NOTE), seq: parseInt(val(w.SEQ) || '0', 10) || 0,
        late: DEPTH_STATUSES.includes(val(w.STATUS)) && val(w.DUE) && w.DUE < t,
      })),
    };
  }

  async function snapshot() {
    const { teams, members, work } = await loadAll();
    return {
      spanLimit: SPAN_LIMIT, depthGreen: DEPTH_GREEN, shipWindowDays: SHIP_WINDOW_DAYS,
      teams: teams.filter(tm => val(tm.STATUS) !== 'archived').map(tm => teamModel(tm, members, work)),
      archived: teams.filter(tm => val(tm.STATUS) === 'archived').map(tm => ({ id: tm.ID, title: tm.TITLE })),
    };
  }

  async function saveTeam(p) {
    const title = clean(p.title);
    if (!title) throw new Error('a team needs a name');
    const { teams } = await loadAll();
    const existing = p.id ? teams.find(tm => tm.ID === p.id) : null;
    if (p.id && !existing) throw new Error(`no team ${p.id}`);

    if (existing) {
      await rewriteTSV(T_TEAMS, all => all.map(r => r.ID === p.id ? { ...r,
        TITLE: title,
        ORG: p.org !== undefined ? clean(p.org) : r.ORG,
        OWNER: p.owner !== undefined ? (clean(p.owner) || 'ARCHITECT') : r.OWNER,
        RECIPIENT: p.recipient !== undefined ? clean(p.recipient) : r.RECIPIENT,
        RECIPIENT_PERSON_ID: p.recipientPersonId !== undefined ? clean(p.recipientPersonId) : r.RECIPIENT_PERSON_ID,
        CADENCE: p.cadence !== undefined ? (clean(p.cadence) || 'weekly, Friday') : r.CADENCE,
        STATUS: ['active', 'archived'].includes(p.status) ? p.status : r.STATUS,
        NOTE: p.note !== undefined ? clean(p.note) : r.NOTE,
        UPDATED_AT: today(),
      } : r));
      auditLog.log('team_saved', { id: p.id, title });
      return { success: true, id: p.id };
    }

    const id = newId('TM');
    await appendTSV(T_TEAMS, {
      ID: id, TITLE: title, ORG: clean(p.org), OWNER: clean(p.owner) || 'ARCHITECT',
      RECIPIENT: clean(p.recipient), RECIPIENT_PERSON_ID: clean(p.recipientPersonId),
      CADENCE: clean(p.cadence) || 'weekly, Friday', STATUS: 'active',
      CREATED_AT: today(), UPDATED_AT: today(), NOTE: clean(p.note),
    });
    auditLog.log('team_created', { id, title });
    return { success: true, id };
  }

  function isAncestor(members, teamId, startId, leaderId) {
    const byId = Object.fromEntries(members.filter(m => m.TEAM_ID === teamId).map(m => [m.ID, m]));
    let cur = byId[startId];
    const guard = new Set();
    while (cur && val(cur.REPORTS_TO) && !guard.has(cur.ID)) {
      guard.add(cur.ID);
      if (cur.REPORTS_TO === leaderId) return true;
      cur = byId[cur.REPORTS_TO];
    }
    return false;
  }

  async function saveMember(p) {
    const name = clean(p.name);
    if (!p.teamId) throw new Error('member needs a teamId');
    if (!name && !p.id) throw new Error('a member needs a name');
    const { teams, members } = await loadAll();
    if (!teams.find(tm => tm.ID === p.teamId)) throw new Error(`no team ${p.teamId}`);

    const reportsTo = clean(p.reportsTo);
    const existing = p.id ? members.find(m => m.ID === p.id) : null;
    if (p.id && !existing) throw new Error(`no member ${p.id}`);

    if (p.id && reportsTo) {
      if (reportsTo === p.id) throw new Error('a member cannot report to themself');
      if (isAncestor(members, p.teamId, reportsTo, p.id)) {
        throw new Error('that would make the chain a loop - their leader already reports up through them');
      }
    }

    let spanWarning = null;
    if (reportsTo) {
      const directs = members.filter(m =>
        m.TEAM_ID === p.teamId && val(m.STATUS) !== 'left' &&
        m.REPORTS_TO === reportsTo && m.ID !== p.id).length;
      if (directs + 1 > SPAN_LIMIT) spanWarning = `that leader now holds ${directs + 1} direct reports - the system says the sixth means promoting someone to lead`;
    }

    if (existing) {
      await rewriteTSV(T_MEMBERS, all => all.map(r => r.ID === p.id ? { ...r,
        NAME: name || r.NAME,
        PERSON_ID: p.personId !== undefined ? clean(p.personId) : r.PERSON_ID,
        ROLE: p.role !== undefined ? clean(p.role) : r.ROLE,
        REPORTS_TO: p.reportsTo !== undefined ? reportsTo : r.REPORTS_TO,
        NOTE: p.note !== undefined ? clean(p.note) : r.NOTE,
      } : r));
      auditLog.log('team_member_saved', { id: p.id, team: p.teamId });
      return { success: true, id: p.id, spanWarning };
    }

    const id = newId('MB');
    await appendTSV(T_MEMBERS, {
      ID: id, TEAM_ID: p.teamId, PERSON_ID: clean(p.personId), NAME: name,
      ROLE: clean(p.role), REPORTS_TO: reportsTo, STATUS: 'active',
      JOINED_AT: today(), LEFT_AT: '', NOTE: clean(p.note),
    });
    auditLog.log('team_member_added', { id, team: p.teamId, linked: !!clean(p.personId) });
    return { success: true, id, spanWarning };
  }

  async function removeMember(p) {
    const { members, work } = await loadAll();
    const m = members.find(r => r.ID === p.id);
    if (!m) throw new Error(`no member ${p.id}`);
    const inherited = val(m.REPORTS_TO);

    await rewriteTSV(T_MEMBERS, all => all.map(r => {
      if (r.ID === p.id) return { ...r, STATUS: 'left', LEFT_AT: today() };
      if (r.TEAM_ID === m.TEAM_ID && r.REPORTS_TO === p.id) return { ...r, REPORTS_TO: inherited };
      return r;
    }));

    const orphaned = work.filter(w => w.TEAM_ID === m.TEAM_ID && w.MEMBER_ID === p.id
      && DEPTH_STATUSES.includes(val(w.STATUS))).length;
    if (orphaned) {
      await rewriteTSV(T_WORK, all => all.map(w =>
        (w.TEAM_ID === m.TEAM_ID && w.MEMBER_ID === p.id && DEPTH_STATUSES.includes(val(w.STATUS)))
          ? { ...w, MEMBER_ID: '' } : w));
    }
    auditLog.log('team_member_left', { id: p.id, team: m.TEAM_ID, workReturned: orphaned });
    return { success: true, id: p.id, workReturned: orphaned };
  }

  async function saveWork(p) {
    if (!p.teamId) throw new Error('work needs a teamId');
    const title = clean(p.title);
    const { teams, members, work } = await loadAll();
    if (!teams.find(tm => tm.ID === p.teamId)) throw new Error(`no team ${p.teamId}`);
    if (clean(p.memberId) && !members.find(m => m.ID === p.memberId && m.TEAM_ID === p.teamId)) {
      throw new Error('that member is not on this team');
    }

    const existing = p.id ? work.find(w => w.ID === p.id) : null;
    if (p.id && !existing) throw new Error(`no work item ${p.id}`);

    if (existing) {
      await rewriteTSV(T_WORK, all => all.map(r => r.ID === p.id ? { ...r,
        TITLE: title || r.TITLE,
        WHY: p.why !== undefined ? clean(p.why) : r.WHY,
        DUE: p.due !== undefined ? clean(p.due) : r.DUE,
        DONE_MEANS: p.doneMeans !== undefined ? clean(p.doneMeans) : r.DONE_MEANS,
        MEMBER_ID: p.memberId !== undefined ? clean(p.memberId) : r.MEMBER_ID,
        EFFORT_DAYS: p.effortDays !== undefined ? String(parseFloat(p.effortDays) || 1) : r.EFFORT_DAYS,
        SEQ: p.seq !== undefined ? String(parseInt(p.seq, 10) || 0) : r.SEQ,
      } : r));
      auditLog.log('team_work_saved', { id: p.id, team: p.teamId });
      return { success: true, id: p.id };
    }

    for (const [k, label] of [['title', 'WHAT (a title)'], ['why', 'WHY'], ['memberId', 'WHO (a member)'], ['due', 'WHEN (a due date)'], ['doneMeans', 'DONE (what finished looks like)']]) {
      if (!clean(p[k])) throw new Error(`the five fields are mandatory - missing ${label}`);
    }

    const id = newId('WK');
    await appendTSV(T_WORK, {
      ID: id, TEAM_ID: p.teamId, MEMBER_ID: clean(p.memberId), TITLE: title,
      WHY: clean(p.why), DUE: clean(p.due), DONE_MEANS: clean(p.doneMeans),
      STATUS: 'queued', EFFORT_DAYS: String(parseFloat(p.effortDays) || 1),
      CREATED_AT: today(), STARTED_AT: '', FINISHED_AT: '', SIGNED_BY: '', SIGNED_AT: '',
      BLOCKED_NOTE: '', SEQ: String(parseInt(p.seq, 10) || 0),
    });
    auditLog.log('team_work_added', { id, team: p.teamId });
    return { success: true, id };
  }

  async function moveWork(p) {
    const to = String(p.to || '');
    if (!WORK_STATUSES.includes(to)) throw new Error(`unknown status ${to}`);
    const { teams, members, work } = await loadAll();
    const w = work.find(r => r.ID === p.id);
    if (!w) throw new Error(`no work item ${p.id}`);

    const patch = { STATUS: to };
    if (to === 'active' && !val(w.STARTED_AT)) patch.STARTED_AT = today();
    if (to === 'finished') patch.FINISHED_AT = today();
    if (to === 'blocked') patch.BLOCKED_NOTE = clean(p.note) || val(w.BLOCKED_NOTE) || 'blocked - no note given';
    if (to !== 'blocked' && val(w.STATUS) === 'blocked') patch.BLOCKED_NOTE = '';
    if (to === 'signed') {
      if (val(w.STATUS) !== 'finished' && !p.force) {
        throw new Error('only finished work can be signed - the worker claims done first, the level above confirms');
      }
      const member = members.find(m => m.ID === w.MEMBER_ID);
      const leader = member && val(member.REPORTS_TO)
        ? members.find(m => m.ID === member.REPORTS_TO) : null;
      const team = teams.find(tm => tm.ID === w.TEAM_ID);
      patch.SIGNED_BY = clean(p.signedBy) || (leader ? leader.NAME : (team ? val(team.OWNER) : 'owner'));
      patch.SIGNED_AT = now();
    }

    await rewriteTSV(T_WORK, all => all.map(r => r.ID === p.id ? { ...r, ...patch } : r));
    auditLog.log('team_work_moved', { id: p.id, from: val(w.STATUS), to });
    return { success: true, id: p.id, to, signedBy: patch.SIGNED_BY };
  }

  // ── BM26090602: Teams/Channels webhook bridge ──────────────────────────
  // A dedicated Team acts as the "channel" for one external recipient --
  // reuses the exact same teams.tsv backend/`saveTeam` path as an internal
  // team, distinguished only by carrying RECIPIENT_PERSON_ID and a
  // recognizable naming convention (no second convention invented, per the
  // row's own instruction).

  function channelTitleFor(personName, personId) {
    return `Brief Channel -- ${clean(personName) || personId}`;
  }

  /** Idempotent: returns the existing channel for this person_id if one is
   *  already active, otherwise creates it. This is the row's own named hook
   *  point ("ensureRecipientChannel(person_id)") for a future brief-send
   *  flow to call on first send to a new recipient -- no such flow exists
   *  in code yet (confirmed: no scheduler/cron and no send-a-brief route
   *  anywhere in circle/scope/hub), so this function is the minimal, real
   *  integration point rather than a guess at the full flow around it. */
  async function ensureRecipientChannel({ personId, personName }) {
    if (!clean(personId)) throw new Error('ensureRecipientChannel requires a person_id');
    const { teams } = await loadAll();
    const existing = teams.find(t => val(t.RECIPIENT_PERSON_ID) === personId && val(t.STATUS) !== 'archived');
    if (existing) return { id: existing.ID, created: false };
    const r = await saveTeam({
      title: channelTitleFor(personName, personId),
      recipient: clean(personName) || personId,
      recipientPersonId: personId,
      cadence: 'weekly, Friday',
      note: 'auto-created on first brief send (BM26090602)',
    });
    auditLog.log('team_channel_created', { team: r.id, personId });
    return { id: r.id, created: true };
  }

  /** Append one message to a channel's chronological log. kind:
   *  'brief_sent' | 'reply_received' | 'note'. briefId is '-' for a plain
   *  note. This is the "post a message in that channel" primitive both the
   *  outbound send path and the inbound webhook handler share -- saveWork's
   *  five-mandatory-field work-item shape doesn't fit a chat message (see
   *  T_MESSAGES's schema comment in default-schema.js), so this is a new,
   *  narrow function on the same backend/module rather than a second
   *  storage system. */
  async function postMessage({ teamId, kind, body, briefId }) {
    if (!teamId) throw new Error('postMessage requires a teamId');
    if (!['brief_sent', 'reply_received', 'note'].includes(kind)) throw new Error(`unknown message kind ${kind}`);
    const { teams } = await loadAll();
    if (!teams.find(t => t.ID === teamId)) throw new Error(`no team ${teamId}`);
    const id = newId('MSG');
    await appendTSV(T_MESSAGES, {
      ID: id, TEAM_ID: teamId, KIND: kind, BODY: clean(body), BRIEF_ID: clean(briefId), CREATED_AT: now(),
    });
    auditLog.log('team_message_posted', { id, team: teamId, kind });
    return { success: true, id };
  }

  /** Chronological log for one channel, oldest first. */
  async function channelMessages(teamId) {
    const messages = await readTSV(T_MESSAGES);
    return messages.filter(m => m.TEAM_ID === teamId)
      .sort((a, b) => String(a.CREATED_AT).localeCompare(String(b.CREATED_AT)))
      .map(m => ({ id: m.ID, teamId: m.TEAM_ID, kind: m.KIND, body: val(m.BODY), briefId: val(m.BRIEF_ID), createdAt: m.CREATED_AT }));
  }

  /** Mint a scoped, single-purpose token for one brief-send: valid only
   *  against this teamId+briefId pair, for ttlDays (default 14, matching
   *  the assumption BA26090601's sample content already carries). Embed
   *  the returned token in that week's shareable link -- a leaked link can
   *  only ever post to this one brief's thread. */
  async function issueBriefToken({ teamId, briefId, ttlDays = DEFAULT_TOKEN_TTL_DAYS }) {
    if (!teamId) throw new Error('issueBriefToken requires a teamId');
    if (!clean(briefId)) throw new Error('issueBriefToken requires a briefId');
    const { teams } = await loadAll();
    if (!teams.find(t => t.ID === teamId)) throw new Error(`no team ${teamId}`);
    const token = newToken();
    const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();
    await appendTSV(T_BRIEF_TOKENS, {
      TOKEN: token, TEAM_ID: teamId, BRIEF_ID: clean(briefId), STATUS: 'active',
      CREATED_AT: now(), EXPIRES_AT: expiresAt, USED_AT: '',
    });
    auditLog.log('team_brief_token_issued', { team: teamId, briefId, expiresAt });
    return { token, teamId, briefId, expiresAt };
  }

  /** Structural verification only (no side effect) -- used by the inbound
   *  webhook handler before it trusts a call's teamId/briefId. Rejects
   *  anything not matching: unknown token, revoked, or past EXPIRES_AT. */
  async function verifyBriefToken(token) {
    const t = clean(token);
    if (!t) return { ok: false, error: 'no token' };
    const rows = await readTSV(T_BRIEF_TOKENS);
    const row = rows.find(r => r.TOKEN === t);
    if (!row) return { ok: false, error: 'unknown token' };
    if (val(row.STATUS) !== 'active') return { ok: false, error: `token ${val(row.STATUS) || 'revoked'}` };
    if (row.EXPIRES_AT && Date.parse(row.EXPIRES_AT) < Date.now()) return { ok: false, error: 'token expired' };
    return { ok: true, teamId: row.TEAM_ID, briefId: val(row.BRIEF_ID) };
  }

  /** The actual inbound mechanism (row part 3.3/3.4): verify the token,
   *  then append the recipient's response as a follow-up message in the
   *  same channel thread. USED_AT is stamped on first successful call only
   *  (informational -- a token stays valid for further replies within its
   *  window, since a real conversation is rarely exactly one message). */
  async function recordInboundReply({ token, body }) {
    const check = await verifyBriefToken(token);
    if (!check.ok) { auditLog.log('team_webhook_rejected', { error: check.error }); return check; }
    const posted = await postMessage({ teamId: check.teamId, kind: 'reply_received', body, briefId: check.briefId });
    const rows = await readTSV(T_BRIEF_TOKENS);
    const row = rows.find(r => r.TOKEN === clean(token));
    if (row && !val(row.USED_AT)) {
      await rewriteTSV(T_BRIEF_TOKENS, all => all.map(r => r.TOKEN === row.TOKEN ? { ...r, USED_AT: now() } : r));
    }
    auditLog.log('team_webhook_reply_recorded', { team: check.teamId, briefId: check.briefId, message: posted.id });
    return { ok: true, teamId: check.teamId, briefId: check.briefId, messageId: posted.id };
  }

  /** Convenience wrapper tying the outbound half together for a future
   *  brief-send flow to call in one shot: ensures the channel exists,
   *  mints a scoped token, and posts the outbound message. Not itself
   *  wired to any scheduler/trigger -- see this row's own "full brief-send
   *  wiring is a future row" scope note. */
  async function sendBriefToChannel({ personId, personName, briefId, artifactUrl, ttlDays }) {
    const channel = await ensureRecipientChannel({ personId, personName });
    const issued = await issueBriefToken({ teamId: channel.id, briefId, ttlDays });
    const body = artifactUrl ? `Brief sent: ${artifactUrl}` : `Brief sent: ${briefId}`;
    const posted = await postMessage({ teamId: channel.id, kind: 'brief_sent', body, briefId });
    return { teamId: channel.id, channelCreated: channel.created, token: issued.token, expiresAt: issued.expiresAt, messageId: posted.id };
  }

  return {
    snapshot,
    saveTeam,
    saveMember,
    removeMember,
    saveWork,
    moveWork,
    ensureRecipientChannel,
    postMessage,
    channelMessages,
    issueBriefToken,
    verifyBriefToken,
    recordInboundReply,
    sendBriefToChannel,
  };
}

module.exports = {
  createTeamsClient,
  SPAN_LIMIT,
  DEPTH_GREEN,
  WORK_STATUSES,
};
