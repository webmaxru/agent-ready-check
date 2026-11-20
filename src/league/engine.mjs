// The Agent-Ready League: the rules of the game. Pure functions, runtime-neutral (Node, Workers, browsers), no I/O.
//
// How the game works (docs/LEAGUE.md has the player-facing version):
//   - A site joins by submitting a report that this service produced, never a score typed in by hand.
//   - The score on the board is always the latest submitted report, so a regression shows. Nobody keeps a stale high.
//   - XP rewards effort, not luck: joining, points gained above your own best, level-ups, achievements and a weekly
//     re-scan streak. Gains are paid only above your own best, so dropping and re-climbing cannot be farmed.
//   - Four boards: Top (score), Climbers (gain over 30 days), Grinders (XP), Fresh (joined in the last 14 days).
//   - Standings expire after 60 days without a re-scan, which keeps the board honest and gives people a reason to return.
import { LEVEL_NAMES } from '../core/score.mjs';

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
export const JOIN_WINDOW_MS = 7 * DAY; // a report must be this fresh to be submitted
export const DORMANT_MS = 60 * DAY; // no re-scan for this long: off the boards
export const FRESH_MS = 14 * DAY;
export const CLIMB_MS = 30 * DAY;
export const HISTORY_MAX = 30;
export const BOARD_IDS = ['top', 'climbers', 'grinders', 'fresh'];
export const BOARDS = {
  top: { id: 'top', name: 'Top', blurb: 'The highest Agent-Ready scores right now.', metric: 'Score' },
  climbers: { id: 'climbers', name: 'Climbers', blurb: 'The biggest score gain over the last 30 days.', metric: 'Gain' },
  grinders: { id: 'grinders', name: 'Grinders', blurb: 'Most XP: effort, streaks and achievements, whatever the starting point.', metric: 'XP' },
  fresh: { id: 'fresh', name: 'Fresh', blurb: 'Joined in the last 14 days, by score.', metric: 'Score' },
};

export const XP = { join: 100, perPoint: 10, perLevel: 150, streakStep: 25, streakCap: 10 };

/** Score divisions, best first. */
export const DIVISIONS = [
  { id: 'diamond', name: 'Diamond', min: 95 },
  { id: 'platinum', name: 'Platinum', min: 85 },
  { id: 'gold', name: 'Gold', min: 70 },
  { id: 'silver', name: 'Silver', min: 40 },
  { id: 'bronze', name: 'Bronze', min: 0 },
];

export function divisionOf(score) {
  const s = Number(score) || 0;
  return DIVISIONS.find((d) => s >= d.min) || DIVISIONS[DIVISIONS.length - 1];
}

/** Points needed to enter the next division, or null at the top. */
export function nextDivision(score) {
  const s = Number(score) || 0;
  const up = [...DIVISIONS].reverse().find((d) => d.min > s);
  return up ? { id: up.id, name: up.name, min: up.min, points: Math.ceil(up.min - s) } : null;
}

/** Player level from XP: level n starts at 60 * (n-1)^2 XP. */
export function playerLevel(xp) {
  const x = Math.max(0, Number(xp) || 0);
  const level = 1 + Math.floor(Math.sqrt(x / 60));
  const from = 60 * (level - 1) ** 2;
  const to = 60 * level ** 2;
  return { level, xp: x, from, to, into: x - from, span: to - from, pct: Math.round(((x - from) / (to - from)) * 100) };
}

/** Monday-based week number since the Unix epoch (UTC). */
export const weekOf = (ms) => Math.floor((Math.floor(ms / DAY) + 3) / 7);

export function normalizeHost(h) {
  // One standing per site: a leading "www." is the same site as the bare domain.
  return String(h || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}
// A public DNS name: labels, then a top-level label that starts with a letter (so 1.2.3.44 is not a host). No ports.
export const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/** The host a report is about, normalised the same way the report stores do. */
export function reportHost(report) {
  try { return normalizeHost(new URL(report.final_url || report.url).host); } catch { return ''; }
}

// ---- achievements -----------------------------------------------------------------------------------------------
// Each test sees { snap, entry, passed:Set, applicable:[{id,score}], first } where entry already holds the new standing.
const allPass = (ids) => ({ passed }) => ids.every((i) => passed.has(i));
const somePass = (ids, n) => ({ passed }) => ids.filter((i) => passed.has(i)).length >= n;

export const ACHIEVEMENTS = [
  { id: 'player-one', name: 'Player One', xp: 25, how: 'Join the League.', glyph: 'star', test: () => true },
  { id: 'halfway', name: 'Halfway There', xp: 25, how: 'Reach a score of 50.', glyph: 'bars', test: ({ snap }) => snap.score >= 50 },
  { id: 'high-score', name: 'Arcade High Score', xp: 75, how: 'Reach a score of 90.', glyph: 'crown', test: ({ snap }) => snap.score >= 90 },
  { id: 'clean-sheet', name: 'Clean Sheet', xp: 100, how: 'Zero failing checks.', glyph: 'shield', test: ({ snap }) => snap.failed === 0 && snap.checks > 20 },
  { id: 'flawless-layer', name: 'Flawless Layer', xp: 50, how: 'Score 100 in any layer that applies to your site.', glyph: 'gem', test: ({ applicable }) => applicable.some((l) => l.score === 100) },
  { id: 'well-rounded', name: 'Well Rounded', xp: 75, how: 'At least 8 layers apply and every one scores 70 or more.', glyph: 'ring', test: ({ applicable }) => applicable.length >= 8 && applicable.every((l) => l.score >= 70) },
  { id: 'bot-whisperer', name: 'Bot Whisperer', xp: 50, how: 'Pass robots.txt, AI crawler rules, content signals and sitemap.', glyph: 'bot', test: allPass(['crawl.robots-txt', 'crawl.ai-bot-rules', 'crawl.content-signal', 'crawl.sitemap']) },
  { id: 'markdown-native', name: 'Markdown Native', xp: 50, how: 'Pass Markdown negotiation, Vary and llms.txt.', glyph: 'doc', test: allPass(['content.markdown-negotiation', 'content.markdown-vary', 'content.llms-txt']) },
  { id: 'signposted', name: 'Well Signposted', xp: 50, how: 'Pass two of: API catalog, ARD manifest, Agent Skills.', glyph: 'sign', test: somePass(['api.catalog', 'discovery.ard', 'discovery.agent-skills'], 2) },
  { id: 'mcp-pioneer', name: 'MCP Pioneer', xp: 75, how: 'Serve an MCP server card and a working MCP endpoint.', glyph: 'plug', test: allPass(['mcp.server-card', 'mcp.endpoint']) },
  { id: 'webmcp-wizard', name: 'WebMCP Wizard', xp: 75, how: 'Register WebMCP tools (needs a browser scan).', glyph: 'wand', test: ({ snap, passed }) => snap.browser && passed.has('webmcp.tools') },
  { id: 'locked-down', name: 'Locked Down', xp: 50, how: 'Pass HTTPS, security headers and security.txt.', glyph: 'lock', test: allPass(['security.https', 'security.headers', 'security.security-txt']) },
  { id: 'browser-tested', name: 'Browser Tested', xp: 25, how: 'Submit a report that ran the browser checks.', glyph: 'eye', test: ({ snap }) => snap.browser },
  { id: 'level-3', name: 'Agent-Readable', xp: 50, how: 'Reach isitagentready-compatible level 3.', glyph: 'step3', test: ({ snap }) => snap.level >= 3 },
  { id: 'level-4', name: 'Agent-Integrated', xp: 100, how: 'Reach isitagentready-compatible level 4.', glyph: 'step4', test: ({ snap }) => snap.level >= 4 },
  { id: 'level-5', name: 'Agent-Native', xp: 200, how: 'Reach isitagentready-compatible level 5.', glyph: 'step5', test: ({ snap }) => snap.level >= 5 },
  { id: 'climber', name: 'Climber', xp: 50, how: 'Gain 10 points over your first score.', glyph: 'up', test: ({ entry, first }) => entry.best_score - first.score >= 10 },
  { id: 'rocket', name: 'Rocket', xp: 100, how: 'Gain 25 points over your first score.', glyph: 'rocket', test: ({ entry, first }) => entry.best_score - first.score >= 25 },
  { id: 'on-a-roll', name: 'On a Roll', xp: 50, how: 'Re-scan three weeks in a row.', glyph: 'flame', test: ({ entry }) => entry.best_streak >= 3 },
  { id: 'unstoppable', name: 'Unstoppable', xp: 150, how: 'Re-scan eight weeks in a row.', glyph: 'flame2', test: ({ entry }) => entry.best_streak >= 8 },
];
export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

// ---- snapshots and submissions ------------------------------------------------------------------------------------

/** Why a report cannot be submitted, or null. */
export function submissionProblem(report, now = Date.now()) {
  if (!report || typeof report !== 'object') return 'There is no report to submit.';
  if (!report.id) return 'Only stored reports can join the League. Scan the site again and use the report page.';
  if (!Number.isFinite(Number(report.score))) return 'This report has no score.';
  if (!Array.isArray(report.checks) || !report.checks.length) return 'This report has no checks.';
  const host = reportHost(report);
  if (!HOST_RE.test(host)) return 'Only sites on a public domain name can join the League (not IP addresses or local names).';
  // The standing is for the site, so the report must be for its home page and must not have been redirected to another site.
  try {
    const asked = new URL(report.url);
    if (asked.pathname !== '/' || asked.search) return 'Only a scan of the home page can join the League. Scan https://' + host + '/ and submit that report.';
    if (normalizeHost(asked.host) !== host) return 'That address redirects to a different site. Scan ' + host + ' directly and submit that report.';
  } catch { return 'This report has no valid URL.'; }
  const at = Date.parse(report.scanned_at);
  if (!Number.isFinite(at)) return 'This report has no scan date.';
  if (now - at > JOIN_WINDOW_MS) return 'This report is more than 7 days old. Scan the site again to submit a fresh one.';
  if (at - now > 10 * 60_000) return 'This report is dated in the future.';
  return null;
}

/** The part of a report the League keeps. */
export function snapshotOf(report) {
  const checks = report.checks || [];
  return {
    host: reportHost(report),
    report_id: report.id,
    at: new Date(Date.parse(report.scanned_at)).toISOString(),
    score: Math.max(0, Math.min(100, Math.round(Number(report.score)))),
    level: report.compat?.isitagentready?.level ?? 0,
    layers: Object.fromEntries((report.layers || []).filter((l) => l.applicable && Number.isFinite(l.score)).map((l) => [l.id, l.score])),
    passed: checks.filter((c) => c.status === 'pass').map((c) => c.id),
    checks: checks.length,
    failed: checks.filter((c) => c.status === 'fail').length,
    browser: !!report.mode?.browser && !report.mode?.browser_error,
  };
}

const point = (s) => ({ report_id: s.report_id, at: s.at, score: s.score, level: s.level });

/**
 * Apply a snapshot to a standing (prev is null for a new player). Pure: returns { entry, changed, events, gained }
 * or { entry: prev, changed: false, duplicate | error }.
 * events: [{ type: 'joined'|'score_up'|'score_down'|'rescan'|'level_up'|'streak'|'achievement', xp, ... }]
 */
export function applySubmission(prev, snap, now = Date.now()) {
  if (prev && prev.report_id === snap.report_id) return { entry: prev, changed: false, events: [], duplicate: true };
  if (prev && Date.parse(snap.at) <= Date.parse(prev.updated_at_report)) {
    return { entry: prev, changed: false, events: [], error: 'stale', message: 'A newer report for this site is already on the board.' };
  }
  const events = [];
  const nowIso = new Date(now).toISOString();
  const e = prev
    ? { ...prev, achievements: { ...prev.achievements }, history: [...prev.history], rank_history: [...(prev.rank_history || prev.history || [])] }
    : { host: snap.host, joined_at: nowIso, first_score: snap.score, best_score: snap.score, best_level: snap.level, xp: 0, streak: 0, best_streak: 0, streak_week: null, achievements: {}, history: [], rank_history: [] };
  e.first_score ??= e.history[0]?.score ?? e.best_score ?? snap.score;
  const first = { score: e.first_score };

  let gained = 0;
  if (!prev) {
    gained += XP.join;
    events.push({ type: 'joined', xp: XP.join });
  } else {
    if (snap.score > e.best_score) {
      const pts = snap.score - e.best_score;
      gained += pts * XP.perPoint;
      events.push({ type: 'score_up', points: pts, xp: pts * XP.perPoint });
    } else if (snap.score < prev.score) events.push({ type: 'score_down', points: prev.score - snap.score, xp: 0 });
    else events.push({ type: 'rescan', xp: 0 });
    if (snap.level > e.best_level) {
      gained += (snap.level - e.best_level) * XP.perLevel;
      events.push({ type: 'level_up', from: e.best_level, to: snap.level, xp: (snap.level - e.best_level) * XP.perLevel });
    }
  }

  // Weekly streak: one re-scan in each consecutive calendar week keeps it alive; a missed week resets it.
  const wk = weekOf(Date.parse(snap.at));
  if (e.streak_week == null || wk - e.streak_week > 1) e.streak = 1;
  else if (wk - e.streak_week === 1) {
    e.streak += 1;
    const bonus = XP.streakStep * Math.min(e.streak, XP.streakCap);
    gained += bonus;
    events.push({ type: 'streak', weeks: e.streak, xp: bonus });
  }
  if (e.streak_week == null || wk > e.streak_week) e.streak_week = wk;
  e.best_streak = Math.max(e.best_streak, e.streak);

  Object.assign(e, {
    score: snap.score, level: snap.level, layers: snap.layers, report_id: snap.report_id, browser: snap.browser,
    best_score: Math.max(e.best_score, snap.score), best_level: Math.max(e.best_level, snap.level),
    updated_at: snap.at, updated_at_report: snap.at,
  });
  const last = e.history[e.history.length - 1];
  const sameDay = last && Date.parse(snap.at) - Date.parse(last.at) < 6 * 3_600_000;
  if (last && sameDay && last.score === snap.score && last.level === snap.level) e.history[e.history.length - 1] = point(snap);
  else e.history.push(point(snap));
  if (e.history.length > HISTORY_MAX) e.history = e.history.slice(-HISTORY_MAX);
  if (!e.rank_history.length || e.rank_history[e.rank_history.length - 1].score !== snap.score) e.rank_history.push(point(snap));
  const cutoff = Date.parse(snap.at) - CLIMB_MS;
  let baseline = -1;
  for (let i = 0; i < e.rank_history.length; i++) {
    if (Date.parse(e.rank_history[i].at) <= cutoff) baseline = i;
    else break;
  }
  if (baseline > 0) e.rank_history = e.rank_history.slice(baseline);

  const passed = new Set(snap.passed);
  const applicable = Object.entries(snap.layers).map(([id, score]) => ({ id, score }));
  for (const a of ACHIEVEMENTS) {
    if (e.achievements[a.id]) continue;
    if (a.test({ snap, entry: e, passed, applicable, first })) {
      e.achievements[a.id] = nowIso;
      gained += a.xp;
      events.push({ type: 'achievement', id: a.id, name: a.name, xp: a.xp });
    }
  }
  e.xp += gained;
  e.last_events = events.slice(0, 16);
  e.last_gain = gained;
  return { entry: e, changed: true, events, gained };
}

// ---- boards ---------------------------------------------------------------------------------------------------------

export const isActive = (e, now = Date.now()) => now - Date.parse(e.updated_at) <= DORMANT_MS;

/** Score gain over the last 30 days: against the last snapshot at or before the window start, else the first one. */
export function gainOf(e, now = Date.now()) {
  const h = e.rank_history || e.history || [];
  if (!h.length) return 0;
  const start = now - CLIMB_MS;
  let base = h[0];
  for (const p of h) { if (Date.parse(p.at) <= start) base = p; else break; }
  return e.score - base.score;
}

const cmpTop = (a, b) => (b.score - a.score) || (b.level - a.level) || (b.xp - a.xp) || a.host.localeCompare(b.host);

/**
 * Ranked rows for one board. Competition ranking: equal values share a rank (1, 2, 2, 4).
 */
export function rankBoard(entries, board = 'top', now = Date.now()) {
  const active = entries.filter((e) => isActive(e, now));
  let rows; let cmp; let key;
  if (board === 'climbers') {
    rows = active.map((e) => ({ e, v: gainOf(e, now) })).filter((r) => r.v > 0);
    cmp = (a, b) => (b.v - a.v) || cmpTop(a.e, b.e); key = (r) => String(r.v);
  } else if (board === 'grinders') {
    rows = active.map((e) => ({ e, v: e.xp }));
    cmp = (a, b) => (b.v - a.v) || cmpTop(a.e, b.e); key = (r) => String(r.v);
  } else {
    rows = (board === 'fresh' ? active.filter((e) => now - Date.parse(e.joined_at) <= FRESH_MS) : active).map((e) => ({ e, v: e.score }));
    cmp = (a, b) => cmpTop(a.e, b.e); key = (r) => `${r.e.score}:${r.e.level}`;
  }
  rows.sort(cmp);
  let rank = 0; let prevKey = null;
  return rows.map((r, i) => {
    if (key(r) !== prevKey) { rank = i + 1; prevKey = key(r); }
    return rowOf(r.e, rank, now);
  });
}

export function rowOf(e, rank, now = Date.now()) {
  return {
    rank, host: e.host, score: e.score, level: e.level, level_name: LEVEL_NAMES[e.level] || '', division: divisionOf(e.score).id,
    xp: e.xp, player_level: playerLevel(e.xp).level, streak: e.streak_week != null && weekOf(now) - e.streak_week <= 1 ? e.streak : 0,
    gain: gainOf(e, now), achievements: Object.keys(e.achievements || {}).length,
    joined_at: e.joined_at, updated_at: e.updated_at, report_id: e.report_id,
  };
}

/** Best score per layer among active entries (the crown). Ties go to the higher overall score, then the host name. */
export function crownsOf(entries, now = Date.now()) {
  const best = new Map();
  for (const e of entries.filter((x) => isActive(x, now))) {
    for (const [layer, s] of Object.entries(e.layers || {})) {
      const cur = best.get(layer);
      if (!cur || s > cur.score || (s === cur.score && (e.score > cur.overall || (e.score === cur.overall && e.host < cur.host)))) best.set(layer, { layer, host: e.host, score: s, overall: e.score });
    }
  }
  return [...best.values()];
}

/** Where a site stands on every board, and which layer crowns it holds. Null when it never joined. */
export function standing(entries, host, now = Date.now()) {
  const h = normalizeHost(host);
  const entry = entries.find((e) => e.host === h) || null;
  if (!entry) return null;
  const find = (b) => rankBoard(entries, b, now).find((r) => r.host === h)?.rank ?? null;
  return {
    entry, active: isActive(entry, now), total: entries.filter((e) => isActive(e, now)).length,
    ranks: { top: find('top'), climbers: find('climbers'), grinders: find('grinders'), fresh: find('fresh') },
    crowns: crownsOf(entries, now).filter((c) => c.host === h).map((c) => c.layer),
  };
}

/** Rank this score would take on the Top board (the host itself excluded). */
export function projectedRank(entries, host, score, level = 0, now = Date.now()) {
  const h = normalizeHost(host);
  const others = entries.filter((e) => isActive(e, now) && e.host !== h);
  const ahead = others.filter((e) => e.score > score || (e.score === score && e.level > level)).length;
  return { rank: ahead + 1, of: others.length + 1 };
}

// ---- quests ---------------------------------------------------------------------------------------------------------
const CREDIT = { pass: 1, warn: 0.5, fail: 0 };

/** The overall score as a float, from the checks and layer weights of a report (same rules as src/core/score.mjs). */
export function rawScore(checks, layers) {
  let wsum = 0; let acc = 0;
  for (const l of layers) {
    let total = 0; let got = 0;
    for (const c of checks) {
      if (c.layer !== l.id || !(c.status in CREDIT)) continue;
      total += c.weight; got += c.weight * CREDIT[c.status];
    }
    if (total > 0) { wsum += l.weight; acc += (l.weight * 100 * got) / total; }
  }
  return wsum ? acc / wsum : 0;
}

/** The fixes worth the most points: what the score would be if each failing or warning check passed. */
export function quests(report, { limit = 5 } = {}) {
  const checks = report.checks || []; const layers = report.layers || [];
  const base = rawScore(checks, layers);
  const out = [];
  for (const c of checks) {
    if (c.status !== 'fail' && c.status !== 'warn') continue;
    const gain = rawScore(checks.map((x) => (x === c ? { ...x, status: 'pass' } : x)), layers) - base;
    if (gain <= 0.04) continue;
    out.push({ id: c.id, title: c.title, status: c.status, layer: c.layer, gain: Math.round(gain * 10) / 10, hint: c.fix?.hint || null, message: c.message || '' });
  }
  out.sort((a, b) => (b.gain - a.gain) || a.id.localeCompare(b.id));
  const top = out.slice(0, limit);
  const sum = top.slice(0, 3).reduce((s, q) => s + q.gain, 0);
  return { raw: Math.round(base * 10) / 10, quests: top, fixable: out.length, top3_gain: Math.round(sum * 10) / 10, projected_score: Math.min(100, Math.round(base + sum)) };
}
