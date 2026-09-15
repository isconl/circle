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

const T_TEAMS = 'teams/teams.tsv';
const T_MEMBERS = 'teams/members.tsv';
const T_WORK = 'teams/work.tsv';

const val = v => { const s = String(v == null ? '' : v).trim(); return (!s || s === '-') ? '' : s; };
const clean = s => String(s ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

function newId(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

const WORK_STATUSES = ['queued', 'active', 'blocked', 'finished', 'signed', 'dropped'];
const DEPTH_STATUSES = ['queued', 'active', 'blocked'];

// BM26091502: the six-force team archetype (canon:
// 20260914_canon_team_archetype_framework_isconl_v1_0_0.md). Architect is a
// position over the team, NOT a seventh force -- it never appears in this
// list, and is tracked as its own IS_ARCHITECT flag on a member instead
// (canon §3). Six slots, always, is the whole point of the composition view.
const FORCES = ['captain', 'strategist', 'operator', 'warrior', 'scout', 'guardian'];

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
        forcePrimary: val(m.FORCE_PRIMARY),
        forceSecondary: val(m.FORCE_SECONDARY),
        isArchitect: val(m.IS_ARCHITECT) === 'true',
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

  // BM26091502: six-slot force coverage for a team's active (non-left)
  // members. A member's primary AND secondary both count toward coverage --
  // "represented" means at least one member carries that force in either
  // slot. The missing case is the point of the view (canon §2): a force
  // with zero holders is reported explicitly, not left as an empty bucket
  // a caller has to notice by absence.
  function forceComposition(enrichedMembers) {
    const holders = Object.fromEntries(FORCES.map(f => [f, []]));
    for (const m of enrichedMembers) {
      for (const f of [m.forcePrimary, m.forceSecondary]) {
        if (f && holders[f]) holders[f].push({ id: m.id, name: m.name });
      }
    }
    const covered = FORCES.filter(f => holders[f].length === 1);
    const doubled = FORCES.filter(f => holders[f].length > 1);
    const missing = FORCES.filter(f => holders[f].length === 0);
    const architects = enrichedMembers.filter(m => m.isArchitect).map(m => ({ id: m.id, name: m.name }));
    return { forces: FORCES, holders, covered, doubled, missing, architects };
  }

  // BM26091503: the Architect diagnostic -- which of the six forces went
  // quiet or corrupted this cycle, read from teams/work.tsv's real record
  // rather than self-reported status (canon §3, the row's whole reason to
  // exist). Definitions settled here, per the row's own instruction, and
  // mirrored into the canon doc in the same commit series:
  //
  //   cycle = the same trailing SHIP_WINDOW_DAYS window `counts.signedWeek`
  //   already uses elsewhere in this file -- reusing an existing cycle
  //   definition rather than inventing a second one.
  //
  //   a force's holders = every active member carrying it as EITHER
  //   primary or secondary (the same "holder" relationship
  //   forceComposition() uses for coverage) -- a force is attributed
  //   whichever member did the work, regardless of which slot they hold
  //   it in.
  //
  //   quiet = the force has at least one holder, but none of their work
  //   was signed (the terminal success state) within the cycle window.
  //   A force with signed work in the cycle is NOT quiet even if some of
  //   its holders' other items are still open -- quiet means "produced
  //   nothing finished," not "has no open work."
  //
  //   corrupted = at least one of the force's holders currently has a
  //   work item in 'blocked' status, right now. This is deliberately the
  //   narrower of the two candidate definitions the row proposed ("started
  //   and stalled" OR "repeatedly reopened") -- teams/work.tsv has no
  //   BLOCKED_AT timestamp and no reopen counter, so "how long blocked" or
  //   "reopened N times" cannot be computed from the real record without
  //   inventing history tracking this row never asked for. "Currently
  //   blocked" is the one corruption signal the existing schema actually
  //   supports; a richer definition is future work if the schema grows
  //   the fields for it.
  //
  //   unstaffed = the force has zero holders. Diagnosing quiet/corrupted
  //   for a force nobody carries is meaningless (there is no one to
  //   diagnose) -- this is forceComposition()'s "missing" case, reported
  //   here under its own name so a caller never conflates "nobody holds
  //   this force" with "someone holds it and produced nothing."
  //
  //   A force can be quiet AND corrupted at once (holders did nothing
  //   finished AND have a blocked item) -- the two are not mutually
  //   exclusive, and both are worth surfacing independently.
  function architectDiagnosis(enrichedMembers, work, holders, cutoffIso) {
    const holderIdsByForce = Object.fromEntries(
      FORCES.map(f => [f, new Set((holders[f] || []).map(h => h.id))])
    );
    const result = {};
    for (const f of FORCES) {
      const holderIds = holderIdsByForce[f];
      if (holderIds.size === 0) {
        result[f] = { status: 'unstaffed', quiet: false, corrupted: false, holders: [] };
        continue;
      }
      const forceWork = work.filter(w => holderIds.has(w.MEMBER_ID));
      const signedThisCycle = forceWork.some(w => val(w.STATUS) === 'signed' && val(w.SIGNED_AT) >= cutoffIso);
      const blockedNow = forceWork.some(w => val(w.STATUS) === 'blocked');
      result[f] = {
        status: !signedThisCycle && blockedNow ? 'quiet+corrupted' : !signedThisCycle ? 'quiet' : blockedNow ? 'corrupted' : 'healthy',
        quiet: !signedThisCycle,
        corrupted: blockedNow,
        holders: [...holderIds].map(id => (enrichedMembers.find(m => m.id === id) || {}).name).filter(Boolean),
      };
    }
    return result;
  }

  function teamModel(team, members, work) {
    const mm = memberModel(team, members, work);
    const forces = forceComposition(mm.members);
    const mine = work.filter(w => w.TEAM_ID === team.ID);
    const cutoff = new Date(Date.now() - SHIP_WINDOW_DAYS * 86400000).toISOString();
    const architect = architectDiagnosis(mm.members, mine, forces.holders, cutoff);
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
      ...mm, forces, architect, counts, health,
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

    // BM26091502: forcePrimary/forceSecondary are each either empty or one
    // of the six forces -- never a seventh value, and never "architect"
    // (that's the separate isArchitect flag, canon §3). A member cannot
    // hold the same force in both slots; that's not a "double dose", it's
    // an unfilled secondary.
    const forcePrimary = p.forcePrimary !== undefined ? clean(p.forcePrimary).toLowerCase() : undefined;
    const forceSecondary = p.forceSecondary !== undefined ? clean(p.forceSecondary).toLowerCase() : undefined;
    for (const [label, f] of [['forcePrimary', forcePrimary], ['forceSecondary', forceSecondary]]) {
      if (f && !FORCES.includes(f)) throw new Error(`${label} must be one of ${FORCES.join(', ')}, or empty`);
    }
    const resolvedPrimary = forcePrimary !== undefined ? forcePrimary : (existing ? val(existing.FORCE_PRIMARY) : '');
    const resolvedSecondary = forceSecondary !== undefined ? forceSecondary : (existing ? val(existing.FORCE_SECONDARY) : '');
    if (resolvedPrimary && resolvedPrimary === resolvedSecondary) {
      throw new Error('a member cannot hold the same force as both primary and secondary');
    }

    if (existing) {
      await rewriteTSV(T_MEMBERS, all => all.map(r => r.ID === p.id ? { ...r,
        NAME: name || r.NAME,
        PERSON_ID: p.personId !== undefined ? clean(p.personId) : r.PERSON_ID,
        ROLE: p.role !== undefined ? clean(p.role) : r.ROLE,
        REPORTS_TO: p.reportsTo !== undefined ? reportsTo : r.REPORTS_TO,
        NOTE: p.note !== undefined ? clean(p.note) : r.NOTE,
        FORCE_PRIMARY: forcePrimary !== undefined ? forcePrimary : r.FORCE_PRIMARY,
        FORCE_SECONDARY: forceSecondary !== undefined ? forceSecondary : r.FORCE_SECONDARY,
        IS_ARCHITECT: p.isArchitect !== undefined ? String(!!p.isArchitect) : r.IS_ARCHITECT,
      } : r));
      auditLog.log('team_member_saved', { id: p.id, team: p.teamId });
      return { success: true, id: p.id, spanWarning };
    }

    const id = newId('MB');
    await appendTSV(T_MEMBERS, {
      ID: id, TEAM_ID: p.teamId, PERSON_ID: clean(p.personId), NAME: name,
      ROLE: clean(p.role), REPORTS_TO: reportsTo, STATUS: 'active',
      JOINED_AT: today(), LEFT_AT: '', NOTE: clean(p.note),
      FORCE_PRIMARY: forcePrimary || '', FORCE_SECONDARY: forceSecondary || '',
      IS_ARCHITECT: String(!!p.isArchitect),
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

  return {
    snapshot,
    saveTeam,
    saveMember,
    removeMember,
    saveWork,
    moveWork,
  };
}

module.exports = {
  createTeamsClient,
  SPAN_LIMIT,
  DEPTH_GREEN,
  WORK_STATUSES,
  FORCES,
};
