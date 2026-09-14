'use strict';
/**
 * BM26091205 -- name similarity used to suggest (never auto-link) an
 * existing contact for an incoming name that didn't match exactly.
 * `chat-import.js`'s `matchSpeakers()` already does a cheap
 * substring/prefix check for a confident match; this is the next tier
 * down, for near-misses worth surfacing as a suggestion a person confirms
 * or dismisses -- typos, nicknames, middle names, transliteration
 * differences ("Yusuf" / "Yousef").
 */

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
}

/** Classic edit distance -- small strings only (person names), O(n*m) is plenty. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 0..1, 1 = identical. Token-set overlap (handles reordered/missing middle
 *  names) blended with whole-string edit-distance similarity (handles
 *  typos within a token) -- either signal alone misses real cases the
 *  other catches. */
function nameSimilarity(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  const shared = [...ta].filter(t => tb.has(t)).length;
  const tokenScore = shared / Math.max(ta.size, tb.size);

  const dist = levenshtein(na, nb);
  const editScore = 1 - dist / Math.max(na.length, nb.length);

  return Math.max(tokenScore, editScore);
}

/**
 * Fuzzy candidates for `name` among `people` (each needs at least ID+NAME),
 * excluding anyone in `excludeIds` (e.g. an already-exact match) and any
 * (name, personId) pair already dismissed. Sorted best-first, capped at
 * `limit`. `threshold` (default 0.55) is deliberately below "confident
 * match" territory -- this feeds a suggestion a human confirms, not an
 * auto-link, so it can afford to be generous and let the confirm step be
 * the real filter.
 */
function findCandidates(name, people, { threshold = 0.55, limit = 3, excludeIds = new Set(), dismissed = new Set() } = {}) {
  const key = norm(name);
  if (!key) return [];
  return people
    .filter(p => p.ID && p.NAME && !excludeIds.has(p.ID) && !dismissed.has(`${key}::${p.ID}`))
    .map(p => ({ personId: p.ID, name: p.NAME, score: nameSimilarity(name, p.NAME) }))
    .filter(c => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { norm, levenshtein, nameSimilarity, findCandidates };
