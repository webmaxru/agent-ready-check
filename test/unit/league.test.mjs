// The Agent-Ready League: rules (engine), stores and routes. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySubmission, snapshotOf, submissionProblem, rankBoard, standing, crownsOf, projectedRank, quests, divisionOf, playerLevel, gainOf, normalizeHost, DAY, WEEK, XP } from '../../src/league/engine.mjs';
import { memoryLeague, prune, docLeague, MAX_ENTRIES, FORGET_MS } from '../../src/league/store.mjs';
import { fsLeague, fsStore } from '../../src/store/fs.mjs';
import { azureBlobStore } from '../../src/store/azure-blob.mjs';
import { d1Store } from '../../src/store/d1.mjs';
import { createApp } from '../../server/app.mjs';
import { memoryStore } from '../../src/store/memory.mjs';
import { memoryRateLimiter } from '../../server/ratelimit.mjs';
import { renderLeagueHtml, renderProfileHtml, renderLeagueBadge, renderLeagueMarkdown } from '../../src/league/render.mjs';
import { LEAGUE_CSS } from '../../src/league/assets.mjs';
import { fakeReport } from './server-fake-report.mjs';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = Date.parse('2026-11-17T12:00:00Z');
const report = (host, score, at = T0, over = {}) => {
  const url = `https://${host}/`;
  const finalUrl = over.final_url || url;
  return fakeReport(url, {
    id: `r${Math.abs(hash(host + score + at))}`, score, scanned_at: new Date(at).toISOString(),
    homepage_exchange_id: 'home',
    exchanges: { home: { request: { url }, response: { status: 200, finalUrl }, redirects: finalUrl === url ? [] : [{ url, location: finalUrl }] } },
    ...over,
  });
};
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const submit = (prev, rep, now = T0) => applySubmission(prev, snapshotOf(rep), now);

test('joining gives XP and Player One; the same report twice is a no-op', () => {
  const rep = report('example.com', 62);
  const a = submit(null, rep);
  assert.equal(a.changed, true);
  assert.ok(a.events.some((e) => e.type === 'joined'));
  assert.ok(a.entry.achievements['player-one'] && a.entry.achievements.halfway);
  assert.equal(a.entry.xp, XP.join + 25 + 25);
  const b = submit(a.entry, rep);
  assert.equal(b.changed, false);
  assert.equal(b.duplicate, true);
});

test('XP is paid only for points above the best score ever (no farming by dropping and re-climbing)', () => {
  let e = submit(null, report('a.example', 60, T0)).entry;
  const base = e.xp;
  e = submit(e, report('a.example', 50, T0 + 1 * DAY), T0 + 1 * DAY).entry;
  assert.equal(e.xp, base);
  assert.equal(e.score, 50);
  e = submit(e, report('a.example', 60, T0 + 2 * DAY), T0 + 2 * DAY).entry;
  assert.equal(e.xp, base);
  const up = submit(e, report('a.example', 65, T0 + 3 * DAY), T0 + 3 * DAY);
  assert.ok(up.gained >= 5 * XP.perPoint);
  assert.equal(up.entry.best_score, 65);
});

test('older reports cannot overwrite a newer standing', () => {
  const e = submit(null, report('a.example', 60, T0)).entry;
  const old = submit(e, report('a.example', 90, T0 - DAY), T0);
  assert.equal(old.error, 'stale');
  assert.equal(old.entry.score, 60);
});

test('streak: consecutive weeks pay a growing bonus, a missed week resets', () => {
  let e = submit(null, report('s.example', 40, T0)).entry;
  let at = T0;
  const bonuses = [];
  for (let i = 0; i < 3; i++) {
    at += WEEK;
    const r = submit(e, report('s.example', 40, at), at);
    e = r.entry;
    bonuses.push(r.events.find((x) => x.type === 'streak')?.xp);
  }
  assert.deepEqual(bonuses, [50, 75, 100]);
  assert.ok(e.achievements['on-a-roll']);
  at += 3 * WEEK;
  e = submit(e, report('s.example', 40, at), at).entry;
  assert.equal(e.streak, 1);
  assert.equal(e.best_streak, 4);
});

test('submission rules: stored, fresh, public domain', () => {
  assert.match(submissionProblem(report('example.com', 50, T0 - 8 * DAY), T0), /7 days/);
  assert.match(submissionProblem(report('127.0.0.1', 50), T0), /public domain/);
  assert.match(submissionProblem(report('localhost', 50), T0), /public domain/);
  assert.match(submissionProblem({ ...report('example.com', 50), id: undefined }, T0), /stored/);
  assert.equal(submissionProblem(report('example.com', 50), T0), null);
  assert.match(submissionProblem({ ...report('example.com', 50), url: 'https://anyone@example.com/' }, T0), /credentials/);
});

test('one standing per site: www folds into the apex, only home pages, no redirects to other sites, no IPs or ports', () => {
  const www = report('www.example.com', 50);
  assert.equal(snapshotOf(www).host, 'example.com');
  assert.equal(normalizeHost('www.www.example.com'), 'example.com');
  const redirected = report('a.example', 50, T0, { final_url: 'https://www.a.example/en/' });
  assert.equal(submissionProblem(redirected, T0), null);
  assert.equal(snapshotOf(redirected).host, 'a.example');
  assert.match(submissionProblem({ ...report('a.example', 50), url: 'https://a.example/blog/post' }, T0), /home page/);
  assert.match(submissionProblem({ ...report('a.example', 50), final_url: 'https://b.example/' }, T0), /different site/);
  assert.match(submissionProblem(report('1.2.3.44', 50), T0), /public domain/);
  assert.match(submissionProblem(report('a.example:8080', 50), T0), /public domain/);
  assert.match(submissionProblem(report('a.example:80', 50), T0), /public domain/);
  assert.match(submissionProblem({ ...report('a.example', 50), url: 'https://a.example/?p=123' }, T0), /home page/);
});

test('submission requires successful homepage evidence with an on-site redirect trail', () => {
  const valid = report('a.example', 50);
  assert.equal(submissionProblem(valid, T0), null);
  assert.match(submissionProblem({ ...valid, exchanges: {} }, T0), /homepage fetch/);
  assert.match(submissionProblem({
    ...valid,
    exchanges: { home: { request: { url: valid.url }, response: null, error: 'blocked', redirects: [{ url: valid.url, location: 'https://other.example/' }] } },
  }, T0), /homepage fetch did not complete/);
  assert.match(submissionProblem({
    ...valid,
    exchanges: { home: { request: { url: valid.url }, response: { status: 200, finalUrl: valid.final_url }, redirects: [{ url: valid.url, location: 'https://other.example/' }] } },
  }, T0), /redirected to a different site/);
  assert.match(submissionProblem({
    ...valid,
    exchanges: {
      comparison: { request: { url: valid.url }, response: { status: 200, finalUrl: valid.final_url } },
      home: { request: { url: valid.url }, error: 'blocked', response: null },
    },
  }, T0), /homepage fetch did not complete/);
  assert.equal(submissionProblem({
    ...valid,
    homepage_exchange_id: 'homepage',
    exchanges: {
      comparison: { request: { url: valid.url }, error: 'blocked' },
      homepage: valid.exchanges.home,
    },
  }, T0), null);
});

test('snapshots retain the submitted homepage URL', () => {
  const snap = snapshotOf({ ...report('www.example.com', 50), url: 'http://www.example.com/' });
  assert.equal(snap.homepage_url, 'http://www.example.com/');
});

test('WebMCP achievement requires a successful browser scan', () => {
  const rep = report('webmcp.example', 50, T0, { checks: [{ id: 'webmcp.tools', status: 'pass' }] });
  let e = submit(null, rep).entry;
  assert.equal(e.achievements['webmcp-wizard'], undefined);
  const browserReport = report('webmcp.example', 50, T0 + DAY, { checks: [{ id: 'webmcp.tools', status: 'pass' }], mode: { browser: true } });
  e = submit(e, browserReport, T0 + DAY).entry;
  assert.ok(e.achievements['webmcp-wizard']);
});

test('lifetime climb baseline and rolling ranking history survive chart compaction', () => {
  let e = submit(null, report('climber.example', 40, T0)).entry;
  for (let scan = 1; scan <= 124; scan++) {
    const at = T0 + scan * 6 * 3_600_000;
    e = submit(e, report('climber.example', scan % 2 ? 49 : 48, at), at).entry;
  }
  assert.equal(e.history.length, 30);
  assert.equal(e.first_score, 40);
  assert.ok(e.rank_history.length <= 121);
  const priorRankHistory = structuredClone(e.rank_history);
  const nextAt = T0 + 125 * 6 * 3_600_000;
  assert.equal(submit(e, report('climber.example', 65, nextAt - 1), nextAt - 1).error, 'frequency');
  const next = submit(e, report('climber.example', 65, nextAt), nextAt).entry;
  assert.deepEqual(e.rank_history, priorRankHistory);
  assert.ok(next.achievements.climber);
  assert.ok(next.achievements.rocket);
  assert.equal(gainOf(next, nextAt), 16);
  const agedAt = nextAt + 31 * DAY;
  const aged = submit(next, report('climber.example', 65, agedAt), agedAt).entry;
  assert.equal(gainOf(aged, agedAt), 0);
});

test('a full board of worst-case standings stays bounded', () => {
  const host = `${'sub'.repeat(20)}.example-company-website.com`;
  const layers = Array.from({ length: 13 }, (_, i) => ({ id: `layer-${i}`, applicable: true, score: 77 }));
  let e = null;
  for (let scan = 0; scan < 400; scan++) {
    const at = T0 + scan * (6 * 3_600_000 + 1000);
    e = submit(e, report(host, 40 + (scan % 2), at, { layers, mode: { browser: true } }), at).entry;
  }
  assert.equal(e.history.length, 30);
  assert.ok(e.rank_history.length > 100);
  assert.ok(JSON.stringify(e).length * MAX_ENTRIES < 12 * 1024 * 1024);
});

test('gain reads legacy object ranking points', () => {
  const e = { score: 70, rank_history: [{ at: new Date(T0 - 40 * DAY).toISOString(), score: 50 }, { at: new Date(T0 - 5 * DAY).toISOString(), score: 60 }] };
  assert.equal(gainOf(e, T0), 20);
});

test('League activity and last-scan display use the report scan time', () => {
  const e = submit(null, report('scan-time.example', 50, T0), T0).entry;
  const later = submit(e, report('scan-time.example', 51, T0 + DAY), T0 + 8 * DAY).entry;
  assert.equal(later.updated_at, new Date(T0 + DAY).toISOString());
  assert.equal(standing([later], 'scan-time.example', T0 + 62 * DAY).active, false);
});

test('boards: ties share a rank, climbers need a gain, fresh limits to new players, dormant players drop out', () => {
  const mk = (host, score, joinedAt = T0) => submit(null, report(host, score, joinedAt), joinedAt).entry;
  const a = mk('a.example', 80); const b = mk('b.example', 80); const c = mk('c.example', 60);
  const top = rankBoard([c, b, a], 'top', T0);
  assert.deepEqual(top.map((r) => [r.host, r.rank]), [['a.example', 1], ['b.example', 1], ['c.example', 3]]);
  assert.equal(rankBoard([a, b, c], 'climbers', T0).length, 0);
  const a2 = submit(a, report('a.example', 90, T0 + 5 * DAY), T0 + 5 * DAY).entry;
  const climbers = rankBoard([a2, b, c], 'climbers', T0 + 5 * DAY);
  assert.deepEqual(climbers.map((r) => [r.host, r.gain]), [['a.example', 10]]);
  const old = mk('old.example', 70, T0 - 30 * DAY);
  assert.equal(rankBoard([old, a], 'fresh', T0).length, 1);
  assert.equal(rankBoard([old], 'top', T0 + 61 * DAY).length, 0);
  assert.equal(standing([old], 'old.example', T0 + 61 * DAY).active, false);
  const entries = [a2, b, c, old];
  for (const board of ['top', 'climbers', 'grinders', 'fresh']) {
    const ranked = rankBoard(entries, board, T0 + 5 * DAY);
    for (const entry of entries) {
      assert.equal(standing(entries, entry.host, T0 + 5 * DAY).ranks[board], ranked.find((r) => r.host === entry.host)?.rank ?? null);
    }
  }
  assert.equal(projectedRank([a, b, c], 'new.example', 85, 0, T0).rank, 1);
  assert.equal(projectedRank([a, b, c], 'new.example', 70, 0, T0).rank, 3);
});

test('divisions and player levels', () => {
  assert.equal(divisionOf(0).id, 'bronze');
  assert.equal(divisionOf(100).id, 'diamond');
  assert.ok(playerLevel(0).level >= 1);
  assert.ok(playerLevel(5000).level > playerLevel(100).level);
});

test('layer crowns go to the best site per layer', () => {
  const a = submit(null, report('a.example', 50, T0, { layers: [{ id: 'crawl', applicable: true, score: 90 }] })).entry;
  const b = submit(null, report('b.example', 50, T0, { layers: [{ id: 'crawl', applicable: true, score: 70 }] })).entry;
  assert.deepEqual(crownsOf([a, b], T0).map((c) => [c.layer, c.host]), [['crawl', 'a.example']]);
});

test('quests rank fixes by the score they would give', () => {
  const q = quests(report('q.example', 42));
  assert.equal(q.quests[0].id, 'crawl.robots-txt');
  assert.ok(q.quests[0].gain > 0);
  assert.ok(q.projected_score >= 42);
});

test('quest projection matches the core scorer, rounding per layer', () => {
  const check = (id, layer, status) => ({ id, layer, status, weight: 1, title: id });
  const checks = [
    check('a1', 'a', 'fail'), check('a2', 'a', 'fail'), check('a3', 'a', 'pass'),
    check('b1', 'b', 'fail'), check('b2', 'b', 'fail'), check('b3', 'b', 'pass'),
  ];
  const layers = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }];
  const q = quests({ checks, layers, score: 33 });
  // Fixing a1, a2 and b1 gives layer a 100 and layer b 66.67 -> 67: (100 + 67) / 2 = 83.5 -> 84.
  assert.equal(q.projected_score, 84);
});

test('stores: memory and fs keep the same contract; prune forgets dormant standings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'league-'));
  try {
    for (const store of [memoryLeague({ now: () => T0 }), fsLeague({ dir, now: () => T0 })]) {
      const snap = snapshotOf(report('x.example', 55));
      const out = await store.submit('x.example', (p) => applySubmission(p, snap, T0));
      assert.equal(out.changed, true);
      assert.equal((await store.list()).length, 1);
      assert.equal((await store.get('X.example')).host, 'x.example');
      const dup = await store.submit('x.example', (p) => applySubmission(p, snap, T0));
      assert.equal(dup.duplicate, true);
      assert.equal(await store.remove('x.example'), true);
      assert.equal(await store.remove('x.example'), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const e = submit(null, report('y.example', 50)).entry;
  assert.deepEqual(Object.keys(prune({ 'y.example': e }, T0 + 181 * DAY)), []);
  assert.deepEqual(Object.keys(prune({ 'y.example': e }, T0 + 100 * DAY)), ['y.example']);
});

test('expired standings are pruned before submission and low-XP capacity eviction is refused', async () => {
  const clock = { t: T0 };
  const lg = memoryLeague({ now: () => clock.t });
  await lg.submit('forgotten.example', (p) => applySubmission(p, snapshotOf(report('forgotten.example', 70, T0)), T0));
  clock.t = T0 + 181 * DAY;
  const fresh = snapshotOf(report('forgotten.example', 50, clock.t));
  const revived = await lg.submit('forgotten.example', (p) => applySubmission(p, fresh, clock.t));
  assert.equal(revived.entry.history.length, 1);
  assert.equal(revived.entry.xp, XP.join + 50);

  const entries = Object.fromEntries(Array.from({ length: MAX_ENTRIES }, (_, i) => {
    const host = `site${i}.example`;
    return [host, { host, xp: i + 1, updated_at: new Date(T0).toISOString() }];
  }));
  let doc = { entries, suppressed: {} };
  const full = docLeague({ load: async () => ({ doc: structuredClone(doc), tag: 0 }), save: async (next) => { doc = next; return true; }, now: () => T0 + 1000 });
  const refused = await full.submit('new.example', async () => ({ entry: { host: 'new.example', xp: 0, updated_at: new Date(T0 + 1000).toISOString() }, changed: true }));
  assert.equal(refused.error, 'capacity');
  assert.equal(Object.keys(doc.entries).length, MAX_ENTRIES);
});

test('filesystem League file is outside report IDs and read failures never initialize over existing data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'league-fs-'));
  try {
    const league = fsLeague({ dir, now: () => T0 });
    const snap = snapshotOf(report('fs.example', 50));
    await league.submit('fs.example', (p) => applySubmission(p, snap, T0));
    assert.ok(readdirSync(dir).includes('.league.json'));
    const reports = fsStore({ dir });
    assert.equal(await reports.reindex(), 0);
    const app = createApp({ scan: async () => ({}), store: reports, rateLimit: memoryRateLimiter(), resolve: async () => [] });
    assert.equal((await app.request(`${B}/api/reports/league`)).status, 404);

    writeFileSync(join(dir, '.league.json'), '{broken');
    await assert.rejects(league.submit('fs.example', () => ({ changed: true, entry: {} })), SyntaxError);
    assert.equal(await (await import('node:fs/promises')).readFile(join(dir, '.league.json'), 'utf8'), '{broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('filesystem League lock is created inside its reports directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'league-lock-'));
  let startedResolve; let releaseOperation;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const blocked = new Promise((resolve) => { releaseOperation = resolve; });
  try {
    const league = fsLeague({ dir, now: () => T0 });
    const operation = league.submit('locked.example', async () => {
      startedResolve();
      await blocked;
      return { changed: true, entry: { host: 'locked.example', xp: 0, updated_at: new Date(T0).toISOString() } };
    });
    await started;
    assert.ok(readdirSync(dir).includes('.league.lock'));
    releaseOperation();
    await operation;
  } finally { releaseOperation?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('rendering escapes host names and stays accessible', () => {
  const evil = submit(null, report('a.example', 70)).entry;
  evil.host = '<img src=x onerror=alert(1)>.example';
  const row = rankBoard([evil], 'top', T0)[0];
  const html = renderLeagueHtml({ base: 'https://c.example', board: 'top', rows: [row], page: 1, stats: { players: 1, average: 70, top: 70, achievements: 1 }, crowns: [], now: T0 });
  assert.ok(!html.includes('<img src=x'));
  assert.equal((html.match(/<main/g) || []).length, 1);
  assert.match(html, /<caption/);
  const st = standing([evil], evil.host, T0);
  const prof = renderProfileHtml({ base: 'https://c.example', st, now: T0 });
  assert.ok(!prof.includes('<img src=x'));
  assert.doesNotMatch(prof, /role="status"/);
  const imageWidth = Number(/league\/badge\/[^"]+" alt="[^"]+" width="(\d+)"/.exec(prof)[1]);
  const badgeWidth = Number(/width="(\d+)"/.exec(renderLeagueBadge({ rank: st.ranks.top, total: st.total, division: divisionOf(st.entry.score).id, score: st.entry.score }))[1]);
  assert.equal(imageWidth, badgeWidth);
});

test('podium lists ranks 1, 2, 3 in DOM order; browser standings rescan in browser mode', () => {
  const entries = [70, 90, 80].map((s, i) => submit(null, report(`p${i}.example`, s)).entry);
  const rows = rankBoard(entries, 'top', T0);
  const html = renderLeagueHtml({ base: 'https://c.example', board: 'top', rows, page: 1, stats: { players: 3, average: 80, top: 90, achievements: 0 }, crowns: [], now: T0 });
  const podium = /<ol class="podium"[^>]*>([\s\S]*?)<\/ol>/.exec(html)[1];
  assert.deepEqual([...podium.matchAll(/class="slot (p\d)"/g)].map((m) => m[1]), ['p1', 'p2', 'p3']);
  assert.match(LEAGUE_CSS, /\.podium \.p1\{grid-column:2/);
  const browserEntry = submit(null, report('b.example', 60, T0, { mode: { browser: true } })).entry;
  const prof = renderProfileHtml({ base: 'https://c.example', st: standing([browserEntry], 'b.example', T0), now: T0 });
  assert.match(prof, /href="\/scan\?url=[^"]+&amp;browser=true">Re-scan and climb/);
  const plain = renderProfileHtml({ base: 'https://c.example', st: standing([entries[0]], 'p0.example', T0), now: T0 });
  assert.doesNotMatch(plain, /browser=true/);
});

test('Markdown leaderboard paginates rows and links between pages', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ rank: i + 1, host: `site${i + 1}.example`, score: 90 - i, gain: 0, level: 1, xp: i, streak: 0, achievements: 0 }));
  const md = renderLeagueMarkdown({ base: 'https://c.example', rows, page: 2, stats: { players: 30, average: 75 }, crowns: [] });
  assert.match(md, /\| 26 \| \[site26\.example\]/);
  assert.doesNotMatch(md, /\| 1 \| \[site1\.example\]/);
  assert.match(md, /Page 2 of 2 · \[Previous\]\(https:\/\/c\.example\/league\.md\?page=1\)/);
});

test('League action and teaser XP colors override their dark-console defaults', () => {
  assert.match(LEAGUE_CSS, /\.console \.btn\{color:#fff\}/);
  assert.match(LEAGUE_CSS, /\.teaser \.xpn\{color:var\(--mint\)\}/);
  assert.match(LEAGUE_CSS, /\.events \.ev\{/);
  assert.doesNotMatch(LEAGUE_CSS, /(?<!events )\.ev\{/);
});

// ---- routes
function makeApp(o = {}) {
  let now = T0;
  const clock = () => now;
  const app = createApp({
    scan: async (url) => {
      const asked = new URL(url).href;
      return fakeReport(url, {
        scanned_at: new Date(now).toISOString(),
        exchanges: { home: { request: { url: asked }, response: { status: 200, finalUrl: asked }, redirects: [] } },
      });
    },
    store: memoryStore({ now: clock }), rateLimit: memoryRateLimiter({ limit: 100, windowSeconds: 600 }), resolve: async () => ['93.184.216.34'],
    browserAvailable: false, now: clock, ...o,
  });
  return { app, advance: (ms) => { now += ms; } };
}
const B = 'https://checker.example';
const json = (app, path, body, method = 'POST', headers = {}) => app.request(B + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

test('routes: scan, join through the form, profile, boards, badge, markdown', async () => {
  const { app } = makeApp({ leagueAdminToken: 'secret', baseUrl: 'https://canonical.example' });
  const scan = await (await json(app, '/api/scan', { url: 'https://example.com' })).json();
  const page = await (await app.request(`${B}/r/${scan.id}`, { headers: { accept: 'text/html' } })).text();
  assert.match(page, /Join the League/);
  const filteredPage = await (await app.request(`${B}/r/${scan.id}?role=dev&status=pass`)).text();
  assert.match(filteredPage, new RegExp(`href="/r/${scan.id}#check-`));
  const form = await app.request(`${B}/league/join`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://canonical.example' }, body: `report_id=${scan.id}` });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('location'), '/league/example.com?joined=1');
  const profile = await app.request(`${B}/league/example.com?joined=1`);
  assert.equal(profile.status, 200);
  assert.equal(profile.headers.get('cache-control'), 'no-store');
  assert.match(await profile.text(), /example\.com/);
  const profileMarkdown = await app.request(`${B}/league/example.com.md`);
  const profileMarkdownBody = await profileMarkdown.text();
  assert.match(profileMarkdownBody, /community-submitted/i);
  assert.match(profileMarkdownBody, /https:\/\/github\.com\/webmaxru\/agent-ready-check\/issues\/new/);
  const board = await (await app.request(`${B}/api/league`)).json();
  assert.equal(board.rows[0].host, 'example.com');
  assert.equal(board.players, 1);
  assert.equal((await app.request(`${B}/api/league?board=nope`)).status, 400);
  assert.match(await (await app.request(`${B}/league.md`)).text(), /example\.com/);
  assert.match(await (await app.request(`${B}/league`, { headers: { accept: 'text/markdown' } })).text(), /^# /);
  const badge = await app.request(`${B}/league/badge/example.com.svg`);
  assert.match(badge.headers.get('content-type'), /svg/);
  assert.equal((await app.request(`${B}/league/nobody.example`)).status, 404);
  assert.equal((await app.request(`${B}/api/league/nobody.example`)).status, 404);
  const again = await json(app, '/api/league', { report_id: scan.id });
  assert.equal((await again.json()).status, 'unchanged');
  const reportHtml = await app.request(`${B}/r/${scan.id}`);
  assert.equal(reportHtml.headers.get('cache-control'), 'no-cache');
  const reportMd = await app.request(`${B}/r/${scan.id}.md`);
  assert.equal(reportMd.headers.get('cache-control'), 'public, max-age=3600');
  // report page now shows the standing
  assert.match(await (await app.request(`${B}/r/${scan.id}`, { headers: { accept: 'text/html' } })).text(), /Open your profile/);
});

test('Markdown leaderboard route forwards the requested page', async () => {
  const league = memoryLeague({ now: () => T0 });
  for (let i = 1; i <= 30; i++) {
    const snap = snapshotOf(report(`page${i}.example`, 100 - i));
    await league.submit(snap.host, (prev) => applySubmission(prev, snap, T0));
  }
  const { app } = makeApp({ league });
  const md = await (await app.request(`${B}/league.md?page=2`)).text();
  assert.match(md, /\| 26 \| \[page26\.example\]/);
  assert.doesNotMatch(md, /\| 1 \| \[page1\.example\]/);
  const html = await app.request(`${B}/league?board=grinders&page=2`, { headers: { accept: 'text/html' } });
  assert.match(await html.text(), /href="\/league\.md\?board=grinders&amp;page=2"/);
  assert.match(html.headers.get('link'), /\/league\.md\?board=grinders&page=2/);
  assert.match(html.headers.get('link'), /\/api\/league\?board=grinders&page=2&limit=25/);
});

test('concurrent League reads share one in-flight board load', async () => {
  const underlying = memoryLeague({ now: () => T0 });
  let reads = 0; let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const league = { ...underlying, list: async () => { reads++; await waiting; return underlying.list(); } };
  const { app } = makeApp({ league });
  const requests = [
    app.request(`${B}/api/league`),
    app.request(`${B}/league`),
    app.request(`${B}/league/example.com`),
  ];
  while (!reads) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  finish();
  await Promise.all(requests);
});

test('League write failures return the same stable 503 from API and form joins', async () => {
  const store = memoryStore({ now: () => T0 });
  const id = await store.put(report('write-failure.example', 50));
  const underlying = memoryLeague({ now: () => T0 });
  const league = { ...underlying, submit: async () => { throw new Error('private storage detail'); } };
  const { app } = makeApp({ store, league });
  const api = await json(app, '/api/league', { report_id: id });
  const message = 'The League is temporarily unavailable. Please try again shortly.';
  assert.equal(api.status, 503);
  assert.equal((await api.json()).detail, message);
  const form = await app.request(`${B}/league/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: B },
    body: `report_id=${id}`,
  });
  assert.equal(form.status, 503);
  const formText = await form.text();
  assert.match(formText, new RegExp(message));
  assert.doesNotMatch(formText, /private storage detail/);
});

test('report-store read failures return the League 503, missing reports stay 404', async () => {
  const underlying = memoryStore({ now: () => T0 });
  const store = { ...underlying, get: async () => { throw new Error('blob outage'); } };
  const { app } = makeApp({ store });
  const id = 'abcdefghijklmnopqrstuv';
  const api = await json(app, '/api/league', { report_id: id });
  assert.equal(api.status, 503);
  assert.match((await api.json()).detail, /temporarily unavailable/);
  const form = await app.request(`${B}/league/join`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: `report_id=${id}` });
  assert.equal(form.status, 503);
  const { app: ok } = makeApp();
  assert.equal((await json(ok, '/api/league', { report_id: id })).status, 404);
});

test('the post-join profile reads the host fresh instead of a stale board snapshot', async () => {
  const league = memoryLeague({ now: () => T0 });
  const store = memoryStore({ now: () => T0 });
  const { app } = makeApp({ league, store });
  assert.equal((await app.request(`${B}/league`)).status, 200); // caches an empty board on this instance
  const id = await store.put(report('fresh.example', 61));
  const rep = await store.get(id);
  const snap = snapshotOf(rep);
  await league.submit(snap.host, (prev) => applySubmission(prev, snap, T0)); // written by another instance
  assert.equal((await app.request(`${B}/league/fresh.example`)).status, 404);
  const profile = await app.request(`${B}/league/fresh.example?joined=1`);
  assert.equal(profile.status, 200);
  assert.match(await profile.text(), /is on the board/);
  assert.equal((await app.request(`${B}/league/fresh.example`)).status, 200, 'the confirmation reload refreshed the shared snapshot');
});

test('post-join confirmation reads are shared and rate-bounded', async () => {
  const base = memoryLeague({ now: () => T0 });
  let lists = 0;
  const league = { ...base, list: async () => { lists++; return base.list(); } };
  const { app } = makeApp({ league });
  await app.request(`${B}/league`);
  assert.equal(lists, 1);
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => app.request(`${B}/league/h${i}.example?joined=1`)));
  assert.ok(burst.every((r) => r.status === 404));
  assert.equal(lists, 2, 'twenty concurrent confirmations share one reload');
  const t = Date.now();
  await app.request(`${B}/league/again.example?updated=1`);
  assert.equal(lists, 3);
  assert.ok(Date.now() - t >= 900, 'a further reload waits for the one-second spacing');
});

test('join confirmation uses submission time and profile rescans use the submitted URL', async () => {
  const store = memoryStore({ now: () => T0 });
  const delayed = report('www.example.com', 60, T0 - 30 * 60_000);
  delayed.url = 'http://www.example.com/';
  delayed.final_url = delayed.url;
  delayed.exchanges.home.request.url = delayed.url;
  delayed.exchanges.home.response.finalUrl = delayed.final_url;
  const id = await store.put(delayed);
  const { app, advance } = makeApp({ store });
  assert.equal((await json(app, '/api/league', { report_id: id })).status, 201);
  const profile = await app.request(`${B}/league/example.com?joined=1`);
  const html = await profile.text();
  assert.match(html, /is on the board/);
  assert.match(html, /href="\/scan\?url=http%3A%2F%2Fwww\.example\.com%2F">Re-scan and climb/);
  advance(11 * 60_000);
  assert.doesNotMatch(await (await app.request(`${B}/league/example.com?joined=1`)).text(), /is on the board/);
});

test('routes: API join by url, validation, cross-site form posts, moderation token', async () => {
  const { app } = makeApp({ leagueAdminToken: 'secret' });
  const r = await json(app, '/api/league', { url: 'https://example.com' });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.status, 'joined');
  assert.ok(body.standing.xp >= XP.join);
  assert.equal((await json(app, '/api/league', {})).status, 400);
  assert.equal((await json(app, '/api/league', { report_id: 'nope-nope' })).status, 400);
  assert.equal((await json(app, '/api/league', { report_id: 'zzzzzzzz' })).status, 404);
  const cross = await app.request(`${B}/league/join`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'report_id=abcdef' });
  assert.equal(cross.status, 403);
  assert.equal((await app.request(`${B}/api/league/example.com`, { method: 'DELETE' })).status, 401);
  assert.equal((await app.request(`${B}/api/league/example.com`, { method: 'DELETE', headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await app.request(`${B}/api/league/example.com`, { method: 'DELETE', headers: { authorization: 'Bearer secret' } })).status, 204);
  assert.equal((await app.request(`${B}/api/league/example.com`)).status, 404);
  const { app: open } = makeApp();
  assert.equal((await open.request(`${B}/api/league/example.com`, { method: 'DELETE', headers: { authorization: 'Bearer secret' } })).status, 404);
});

test('report panels keep quests and standings when submissions are ineligible or suppressed', async () => {
  const store = memoryStore({ now: () => T0 });
  const token = 'moderation-test-token';
  const { app, advance } = makeApp({ store, leagueAdminToken: token });
  const scan = await (await json(app, '/api/scan', { url: 'https://member.example/' })).json();
  assert.equal((await json(app, '/api/league', { report_id: scan.id })).status, 201);

  advance(DAY);
  const deepId = await store.put(fakeReport('https://member.example/docs', { scanned_at: new Date(T0 + DAY).toISOString() }));
  const deepPage = await (await app.request(`${B}/r/${deepId}`)).text();
  assert.match(deepPage, /Next quests/);
  assert.match(deepPage, /Your standing is/);
  assert.doesNotMatch(deepPage, /action="\/league\/join"/);

  assert.equal((await app.request(`${B}/api/league/member.example`, { method: 'DELETE', headers: { authorization: ['Bearer', token].join(' ') } })).status, 204);
  const removedPage = await (await app.request(`${B}/r/${scan.id}`)).text();
  assert.match(removedPage, /was removed from the League/);
  assert.match(removedPage, /Next quests/);
  assert.doesNotMatch(removedPage, /action="\/league\/join"/);
});

test('report panel explains the standing frequency restriction', async () => {
  const store = memoryStore({ now: () => T0 });
  const { app, advance } = makeApp({ store });
  const first = await store.put(report('frequency.example', 50));
  assert.equal((await json(app, '/api/league', { report_id: first })).status, 201);
  advance(60 * 60_000);
  const recent = await store.put(report('frequency.example', 51, T0 + 60 * 60_000));
  const page = await (await app.request(`${B}/r/${recent}`)).text();
  assert.match(page, /once every six hours/);
  assert.doesNotMatch(page, /action="\/league\/join"/);
});

test('suppression lookups share the standings snapshot lifetime and invalidate on moderation', async () => {
  const store = memoryStore({ now: () => T0 });
  const underlying = memoryLeague({ now: () => T0 });
  let suppressionReads = 0;
  const league = {
    ...underlying,
    isSuppressed: async (host) => { suppressionReads++; return underlying.isSuppressed(host); },
  };
  const token = 'moderation-test-token';
  const { app, advance } = makeApp({ store, league, leagueAdminToken: token });
  const id = await store.put(report('suppression.example', 50));
  await app.request(`${B}/r/${id}`);
  await app.request(`${B}/r/${id}`);
  assert.equal(suppressionReads, 1);
  advance(5_000);
  await app.request(`${B}/r/${id}`);
  assert.equal(suppressionReads, 2);
  const auth = { authorization: ['Bearer', token].join(' ') };
  assert.equal((await app.request(`${B}/api/league/suppression.example`, { method: 'DELETE', headers: auth })).status, 204);
  assert.match(await (await app.request(`${B}/r/${id}`)).text(), /was removed from the League/);
  assert.equal(suppressionReads, 3);
  assert.equal((await app.request(`${B}/api/league/suppression.example/restore`, { method: 'POST', headers: auth })).status, 204);
  await app.request(`${B}/r/${id}`);
  assert.equal(suppressionReads, 4);
});

test('League read snapshots are reused briefly and invalidated by local mutations', async () => {
  const underlying = memoryLeague({ now: () => T0 });
  let reads = 0;
  const league = { ...underlying, list: async () => { reads++; return underlying.list(); } };
  const token = 'moderation-test-token';
  const { app } = makeApp({ league, leagueAdminToken: token });
  await app.request(`${B}/api/league`);
  await app.request(`${B}/api/league`);
  assert.equal(reads, 1);

  assert.equal((await json(app, '/api/league', { url: 'https://cache.example' })).status, 201);
  assert.equal(reads, 2);
  await app.request(`${B}/api/league`);
  assert.equal(reads, 2);
  const auth = { authorization: ['Bearer', token].join(' ') };
  assert.equal((await app.request(`${B}/api/league/cache.example`, { method: 'DELETE', headers: auth })).status, 204);
  await app.request(`${B}/api/league`);
  assert.equal(reads, 3);
  assert.equal((await app.request(`${B}/api/league/cache.example/restore`, { method: 'POST', headers: auth })).status, 204);
  await app.request(`${B}/api/league`);
  assert.equal(reads, 4);
});

test('removal leaves a tombstone: submissions cannot re-add the host until an admin restores it (all doc stores)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'league-t-'));
  try {
    for (const lg of [memoryLeague({ now: () => T0 }), fsLeague({ dir, now: () => T0 })]) {
      const snap = snapshotOf(report('gone.example', 60));
      await lg.submit('gone.example', (p) => applySubmission(p, snap, T0));
      assert.equal(await lg.remove('gone.example'), true);
      assert.equal(await lg.get('gone.example'), null);
      const again = await lg.submit('gone.example', (p) => applySubmission(p, snapshotOf(report('gone.example', 70, T0 + DAY)), T0 + DAY));
      assert.equal(again.error, 'suppressed');
      assert.equal((await lg.list()).length, 0);
      assert.equal(await lg.remove('gone.example'), false);
      assert.equal(await lg.restore('gone.example'), true);
      assert.equal((await lg.submit('gone.example', (p) => applySubmission(p, snapshotOf(report('gone.example', 70, T0 + DAY)), T0 + DAY))).changed, true);
      // a pre-emptive block for a host that never joined
      assert.equal(await lg.remove('spam.example'), true);
      assert.equal((await lg.submit('spam.example', (p) => applySubmission(p, snapshotOf(report('spam.example', 60)), T0))).error, 'suppressed');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('routes: admin removal blocks re-adding (403) until restore; the removal link is configurable', async () => {
  const { app } = makeApp({ leagueAdminToken: 'secret', leagueRemovalUrl: 'https://tracker.example/new?x=1&y=2' });
  const auth = { authorization: 'Bearer secret' };
  assert.equal((await json(app, '/api/league', { url: 'https://example.com' })).status, 201);
  assert.equal((await app.request(`${B}/api/league/example.com`, { method: 'DELETE' })).status, 401);
  assert.equal((await app.request(`${B}/api/league/example.com`, { method: 'DELETE', headers: auth })).status, 204);
  assert.equal((await app.request(`${B}/api/league/example.com`, { method: 'DELETE', headers: auth })).status, 404);
  assert.equal((await app.request(`${B}/league/example.com`)).status, 404);
  const blocked = await json(app, '/api/league', { url: 'https://example.com' });
  assert.equal(blocked.status, 403);
  assert.equal((await app.request(`${B}/api/league/example.com/restore`, { method: 'POST' })).status, 401);
  assert.equal((await app.request(`${B}/api/league/example.com/restore`, { method: 'POST', headers: auth })).status, 204);
  assert.equal((await json(app, '/api/league', { url: 'https://example.com' })).status, 201);
  const html = await (await app.request(`${B}/league`)).text();
  assert.ok(html.includes('href="https://tracker.example/new?x=1&amp;y=2"'));
  const { app: def } = makeApp();
  assert.ok((await (await def.request(`${B}/league`)).text()).includes('https://github.com/webmaxru/agent-ready-check/issues/new'));
});

test('routes: reports older than 7 days are refused with 422', async () => {
  const { app, advance } = makeApp();
  const scan = await (await json(app, '/api/scan', { url: 'https://example.com' })).json();
  advance(8 * DAY);
  const r = await json(app, '/api/league', { report_id: scan.id });
  assert.equal(r.status, 422);
});

test('a standing cannot be updated more than once in six hours', async () => {
  const store = memoryStore({ now: () => T0 });
  const { app, advance } = makeApp({ store });
  const firstId = await store.put(report('interval.example', 42));
  assert.equal((await json(app, '/api/league', { report_id: firstId })).status, 201);
  advance(5 * 3_600_000);
  const nextId = await store.put(report('interval.example', 60, T0 + 5 * 3_600_000));
  const refused = await json(app, '/api/league', { report_id: nextId });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).detail, /once every six hours/);
});

test('MCP get_league reads boards and standings', async () => {
  const { app } = makeApp({ baseUrl: 'https://canonical.example' });
  await json(app, '/api/league', { url: 'https://example.com' });
  const call = async (args) => (await (await json(app, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_league', arguments: args } }, 'POST', { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' })).json()).result;
  const board = await call({});
  assert.match(board.content[0].text, /example\.com/);
  const one = await call({ host: 'example.com' });
  assert.equal(one.structuredContent.host, 'example.com');
  assert.match(one.content[0].text, /https:\/\/canonical\.example\/league\/example\.com/);
  assert.equal((await call({ host: 'nobody.example' })).isError, true);
});

test('literal .md hostnames resolve before Markdown aliases, with Accept negotiation on collisions', async () => {
  const { app } = makeApp();
  await json(app, '/api/league', { url: 'https://example.com/' });
  await json(app, '/api/league', { url: 'https://example.com.md/' });
  const literal = await app.request(`${B}/league/example.com.md`);
  assert.match(await literal.text(), /example\.com\.md/);
  assert.match(literal.headers.get('vary'), /Accept/);
  const alias = await app.request(`${B}/league/example.com.md`, { headers: { accept: 'text/markdown' } });
  assert.match(alias.headers.get('content-type'), /text\/markdown/);
  assert.match(await alias.text(), /# example\.com on the Agent-Ready League/);
  const literalMd = await app.request(`${B}/league/example.com.md?format=markdown`);
  assert.match(await literalMd.text(), /# example\.com\.md on the Agent-Ready League/);
  const alternate = await app.request(`${B}/league/example.com?format=markdown`);
  assert.match(await alternate.text(), /# example\.com on the Agent-Ready League/);
  assert.match((await app.request(`${B}/league/example.com`)).headers.get('link'), /example\.com\?format=markdown/);

  await json(app, '/api/league', { url: 'https://literal-only.example.md/' });
  const negotiated = await app.request(`${B}/league/literal-only.example.md`, { headers: { accept: 'text/markdown' } });
  assert.match(negotiated.headers.get('vary'), /Accept/);
  assert.match(negotiated.headers.get('content-type'), /text\/markdown/);
});

test('League join bodies are byte-limited while streaming and storage failures are not empty boards', async () => {
  const { app } = makeApp({ maxBodyBytes: 32, league: { list: async () => { throw new Error('storage unavailable'); } } });
  app.onError((_e, c) => c.text('storage unavailable', 500));
  const oversized = () => {
    let pulls = 0;
    const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(64)); } });
    return { body, pulls: () => pulls };
  };
  const apiBody = oversized();
  const apiResponse = await app.fetch(new Request(`${B}/api/league`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: apiBody.body, duplex: 'half' }));
  assert.equal(apiResponse.status, 413);
  assert.equal(apiBody.pulls(), 1);
  const formBody = oversized();
  const formResponse = await app.fetch(new Request(`${B}/league/join`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: formBody.body, duplex: 'half' }));
  assert.equal(formResponse.status, 413);
  assert.equal(formBody.pulls(), 1);
  assert.equal((await app.request(`${B}/api/league`)).status, 500);
});

test('Node join rate limit ignores untrusted client IP headers unless proxy trust is enabled', async () => {
  const { app } = makeApp({ runtime: 'node' });
  let last;
  for (let i = 0; i < 31; i++) {
    last = await app.fetch(new Request(`${B}/api/league`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${i + 1}` }, body: '{}',
    }), { remoteAddress: '192.0.2.10' });
  }
  assert.equal(last.status, 429);

  const { app: trusted } = makeApp({ runtime: 'node', trustProxy: true });
  for (let i = 0; i < 31; i++) {
    last = await trusted.fetch(new Request(`${B}/api/league`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}` }, body: '{}',
    }), { remoteAddress: '192.0.2.10' });
  }
  assert.equal(last.status, 400);
});

test('API refuses a standing that could not be retained at capacity', async () => {
  const { app } = makeApp({
    league: { submit: async () => ({ entry: null, changed: false, error: 'capacity', message: 'The League is full and cannot retain this standing.' }) },
  });
  const response = await json(app, '/api/league', { url: 'https://full.example' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).detail, /League is full/);
});

test('azure league: board.json lives in its own container and is written with ETag preconditions', async () => {
  const blobs = new Map(); const containers = new Set(); const calls = [];
  let etag = 0;
  const fakeFetch = async (url, init) => {
    const u = new URL(url); calls.push(`${init.method} ${u.pathname}${u.search}`);
    if (u.searchParams.get('restype') === 'container') { containers.add(u.pathname); return new Response(null, { status: 201 }); }
    const box = `/${u.pathname.split('/')[1]}`;
    if (init.method === 'PUT') {
      if (!containers.has(box)) return new Response(null, { status: 404 });
      const cur = blobs.get(u.pathname);
      if (init.headers['if-none-match'] === '*' && cur) return new Response(null, { status: 409 });
      if (init.headers['if-match'] && cur?.etag !== init.headers['if-match']) return new Response(null, { status: 412 });
      blobs.set(u.pathname, { body: new TextDecoder().decode(init.body), etag: `"e${++etag}"` });
      return new Response(null, { status: 201 });
    }
    const cur = blobs.get(u.pathname);
    return cur ? new Response(cur.body, { status: 200, headers: { etag: cur.etag } }) : new Response(null, { status: 404 });
  };
  const store = azureBlobStore({ connectionString: 'AccountName=arc1;AccountKey=a2V5a2V5a2V5;BlobEndpoint=https://arc1.blob.core.windows.net', fetch: fakeFetch, now: () => T0 });
  const lg = store.league;
  assert.deepEqual(await lg.list(), []);
  for (const h of ['a.example', 'b.example']) {
    const snap = snapshotOf(report(h, 55));
    assert.equal((await lg.submit(h, (p) => applySubmission(p, snap, T0))).changed, true);
  }
  assert.equal((await lg.list()).length, 2);
  assert.ok(blobs.has('/league/board.json'));
  assert.ok(![...blobs.keys()].some((k) => k.startsWith('/reports/')), 'nothing under reports/, which the lifecycle rule expires');
  assert.equal(await lg.remove('a.example'), true);
  assert.equal((await lg.list()).length, 1);
});

test('d1 league: one row per host, compare-and-swap on version', async () => {
  const rows = new Map(); let schemaRuns = 0; const schemaStatements = []; let submitRace = null; let restoreRace = false;
  let d1Now = T0;
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (sql.startsWith('CREATE')) { schemaRuns++; schemaStatements.push(sql); return { success: true }; }
      if (sql.startsWith('INSERT INTO league')) {
        const current = rows.get(args[0]);
        if (sql.includes('ON CONFLICT(host)')) {
          rows.set(args[0], { version: current ? current.version + 1 : 1, updated: args[1], body: args[2] });
          return { meta: { changes: 1 } };
        }
        if (current) throw new Error('UNIQUE constraint failed');
        rows.set(args[0], { version: 1, updated: args[1], body: args[2] });
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith('UPDATE league')) {
        const r = rows.get(args[2]);
        if (!r || r.version !== args[3] || r.body !== args[4]) return { meta: { changes: 0 } };
        Object.assign(r, { body: args[0], updated: args[1], version: r.version + 1 });
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith('DELETE FROM league')) {
        if (sql.includes('updated <')) {
          let changes = 0;
          for (const [h, r] of rows) if (r.updated < args[0] && !JSON.parse(r.body).tombstone) { rows.delete(h); changes++; }
          return { meta: { changes } };
        }
        if (sql.includes('host IN (')) {
          const live = [...rows].filter(([, r]) => !JSON.parse(r.body).tombstone).sort((a, b) => JSON.parse(a[1].body).xp - JSON.parse(b[1].body).xp);
          const excess = Math.max(0, live.length - MAX_ENTRIES);
          for (const [h] of live.slice(0, excess)) rows.delete(h);
          return { meta: { changes: excess } };
        }
        const r = rows.get(args[0]);
        if (!r || (args.length > 1 && (r.version !== args[1] || r.body !== args[2]))) return { meta: { changes: 0 } };
        rows.delete(args[0]);
        return { meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
    async first() {
      const r = rows.get(args[0]);
      if (!r) return null;
      const result = { body: r.body, version: r.version };
      if (sql === 'SELECT body, version FROM league WHERE host = ?' && submitRace?.host === args[0]) {
        rows.set(args[0], { version: r.version + 1, updated: T0 + 2 * DAY, body: JSON.stringify(submitRace.entry) });
        submitRace = null;
      } else if (sql === 'SELECT body, version FROM league WHERE host = ?' && restoreRace && JSON.parse(r.body).tombstone) {
        restoreRace = false;
        rows.set(args[0], { version: 1, updated: T0, body: JSON.stringify({ host: args[0], score: 80 }) });
      }
      return result;
    },
    async all() {
      return { results: [...rows.values()].filter((r) => r.updated >= args[0] && !JSON.parse(r.body).tombstone)
        .sort((a, b) => b.updated - a.updated).slice(0, args[1]).map((r) => ({ body: r.body })) };
    },
  });
  const db = { prepare: (sql) => stmt(sql), batch: async (l) => { const out = []; for (const x of l) out.push(await x.run()); return out; } };
  const lg = d1Store(db, { now: () => d1Now }).league;
  const snap = snapshotOf(report('d.example', 70));
  assert.equal((await lg.submit('d.example', (p) => applySubmission(p, snap, T0))).changed, true);
  assert.ok(schemaStatements.some((sql) => sql.includes('league_retention') && sql.includes('(updated)')));
  assert.ok(schemaStatements.some((sql) => sql.includes('league_active_xp') && sql.includes("$.xp")));
  const snap2 = snapshotOf(report('d.example', 75, T0 + DAY));
  d1Now = T0 + 8 * DAY;
  assert.equal((await lg.submit('d.example', (p) => applySubmission(p, snap2, T0 + DAY))).entry.score, 75);
  assert.equal(rows.get('d.example').updated, T0 + DAY);
  assert.equal((await lg.list()).length, 1);
  assert.equal((await lg.get('D.example')).score, 75);
  assert.equal(await lg.remove('d.example'), true);
  assert.equal(await lg.remove('d.example'), false);
  assert.equal((await lg.list()).length, 0);
  assert.equal(await lg.get('d.example'), null);
  assert.equal((await lg.submit('d.example', (p) => applySubmission(p, snap2, T0 + DAY))).error, 'suppressed');
  assert.equal(await lg.isSuppressed('d.example'), true);
  assert.equal(await lg.restore('d.example'), true);
  assert.equal(await lg.restore('d.example'), false);
  assert.equal((await lg.submit('d.example', (p) => applySubmission(p, snap2, T0 + DAY))).changed, true);

  const newer = snapshotOf(report('d.example', 85, T0 + 2 * DAY));
  const newerEntry = applySubmission(await lg.get('d.example'), newer, T0 + 2 * DAY).entry;
  submitRace = { host: 'd.example', entry: newerEntry };
  const older = snapshotOf(report('d.example', 80, T0 + DAY - 1000));
  assert.equal((await lg.submit('d.example', (p) => applySubmission(p, older, T0 + 2 * DAY))).error, 'stale');
  assert.equal((await lg.get('d.example')).score, 85);

  assert.equal(await lg.remove('restore-race.example'), true);
  restoreRace = true;
  assert.equal(await lg.restore('restore-race.example'), false);
  assert.equal((await lg.get('restore-race.example')).score, 80);

  rows.clear();
  rows.set('kept-tombstone.example', { version: 2, updated: T0 + 100 * 365 * DAY, body: JSON.stringify({ tombstone: true }) });
  rows.set('expired.example', { version: 1, updated: T0 - FORGET_MS - 1, body: JSON.stringify({ host: 'expired.example', xp: 0 }) });
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const host = `retained${i}.example`;
    rows.set(host, { version: 1, updated: T0, body: JSON.stringify({ host, xp: i + 1 }) });
  }
  assert.equal((await lg.list()).length, MAX_ENTRIES);
  const capacity = await lg.submit('too-low.example', async () => ({ entry: { host: 'too-low.example', xp: 0, updated_at: new Date(T0).toISOString() }, changed: true }));
  assert.equal(capacity.error, 'capacity');
  assert.equal(rows.has('expired.example'), false);
  assert.equal(JSON.parse(rows.get('kept-tombstone.example').body).tombstone, true);
  assert.equal((await lg.list()).length, MAX_ENTRIES);
  assert.ok(schemaRuns >= 1);
});

test('concurrent submissions to every store lose no updates', async () => {
  const hosts = Array.from({ length: 12 }, (_, i) => `site${i}.example`);
  const run = async (lg, other = lg) => {
    await Promise.all(hosts.map((h, i) => (i % 2 ? other : lg).submit(h, (p) => applySubmission(p, snapshotOf(report(h, 50)), T0))));
    assert.equal((await lg.list()).length, hosts.length);
    // the same site from two clients at once: exactly one of the two different reports is the latest and nothing is lost
    const [a, b] = [snapshotOf(report('site0.example', 60, T0 + DAY)), snapshotOf(report('site0.example', 70, T0 + 2 * DAY))];
    const results = await Promise.all([lg, other].map((store, i) => store.submit('site0.example', (p) => applySubmission(p, [a, b][i], T0 + 2 * DAY))));
    assert.ok(results.every((result) => result.changed || result.error === 'stale'));
    const e = await lg.get('site0.example');
    assert.equal(e.score, 70);
    assert.equal(e.history.length, 1 + results.filter((result) => result.changed).length);
    assert.equal((await lg.list()).length, hosts.length);
  };
  await run(memoryLeague({ now: () => T0 }));
  const dir = mkdtempSync(join(tmpdir(), 'league-c-'));
  try { await run(fsLeague({ dir, now: () => T0 }), fsLeague({ dir, now: () => T0 })); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('routes: www and apex are one standing, deep pages and redirects are refused, an older report cannot replace a newer one', async () => {
  const store = memoryStore({ now: () => T0 });
  const { app, advance } = makeApp({ store });
  const put = (url, over = {}) => {
    const finalUrl = new URL(over.final_url || url).href;
    const asked = new URL(url).href;
    return store.put(fakeReport(url, {
      scanned_at: new Date(T0).toISOString(),
      exchanges: { home: { request: { url: asked }, response: { status: 200, finalUrl }, redirects: finalUrl === asked ? [] : [{ url: asked, location: finalUrl }] } },
      ...over,
    }));
  };
  const idWww = await put('https://www.canon.example/');
  const idApex = await put('https://canon.example/', { scanned_at: new Date(T0 + 6 * 3_600_000).toISOString(), score: 55 });
  assert.equal((await json(app, '/api/league', { report_id: idWww })).status, 201);
  advance(6 * 3_600_000);
  assert.equal((await (await json(app, '/api/league', { report_id: idApex })).json()).host, 'canon.example');
  advance(6 * 3_600_000);
  const idDoubleWww = await put('https://www.www.canon.example/', { scanned_at: new Date(T0 + 12 * 3_600_000).toISOString(), score: 60 });
  assert.equal((await (await json(app, '/api/league', { report_id: idDoubleWww })).json()).host, 'canon.example');
  assert.equal((await app.request(`${B}/api/league/canon.example`)).status, 200);
  const board = await (await app.request(`${B}/api/league`)).json();
  assert.deepEqual(board.rows.map((r) => r.host), ['canon.example']);
  assert.equal((await app.request(`${B}/league/www.canon.example`)).status, 200);
  // the older report (www one) can no longer replace the newer standing
  const older = await put('https://canon.example/', { scanned_at: new Date(T0 - 1000).toISOString(), score: 99 });
  const stale = await json(app, '/api/league', { report_id: older });
  assert.equal(stale.status, 409);
  assert.equal((await (await app.request(`${B}/api/league/canon.example`)).json()).score, 60);
  const deep = await put('https://deep.example/blog/post');
  assert.equal((await json(app, '/api/league', { report_id: deep })).status, 422);
  const hop = await put('https://hop.example/', { final_url: 'https://other.example/' });
  assert.equal((await json(app, '/api/league', { report_id: hop })).status, 422);
  const ip = await put('https://93.184.216.34/');
  assert.equal((await json(app, '/api/league', { report_id: ip })).status, 422);
  assert.equal((await app.request(`${B}/league/join`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: `report_id=${deep}` })).status, 422);
});

test('pages say the ranking is community-submitted and show a removal route', async () => {
  const { app } = makeApp();
  await json(app, '/api/league', { url: 'https://example.com' });
  for (const path of ['/league', '/league/example.com']) {
    const html = await (await app.request(B + path)).text();
    assert.match(html, /community-submitted/i, path);
    assert.match(html, /removal/i, path);
  }
  assert.match(await (await app.request(`${B}/league.md`)).text(), /Community rankings/);
  assert.doesNotMatch(await (await app.request(`${B}/league`)).text(), /verified owner|owner-verified ranking/i);
});
