// The Agent-Ready League: rules (engine), stores and routes. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySubmission, snapshotOf, submissionProblem, rankBoard, standing, crownsOf, projectedRank, quests, divisionOf, playerLevel, DAY, WEEK, XP } from '../../src/league/engine.mjs';
import { memoryLeague, prune } from '../../src/league/store.mjs';
import { fsLeague } from '../../src/store/fs.mjs';
import { azureBlobStore } from '../../src/store/azure-blob.mjs';
import { d1Store } from '../../src/store/d1.mjs';
import { createApp } from '../../server/app.mjs';
import { memoryStore } from '../../src/store/memory.mjs';
import { memoryRateLimiter } from '../../server/ratelimit.mjs';
import { renderLeagueHtml, renderProfileHtml } from '../../src/league/render.mjs';
import { fakeReport } from './server-fake-report.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = Date.parse('2026-11-17T12:00:00Z');
const report = (host, score, at = T0, over = {}) => fakeReport(`https://${host}/`, { id: `r${Math.abs(hash(host + score + at))}`, score, scanned_at: new Date(at).toISOString(), ...over });
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
});

test('one standing per site: www folds into the apex, only home pages, no redirects to other sites, no IPs or ports', () => {
  const www = report('www.example.com', 50);
  assert.equal(snapshotOf(www).host, 'example.com');
  const redirected = { ...report('a.example', 50), final_url: 'https://www.a.example/en/' };
  assert.equal(submissionProblem(redirected, T0), null);
  assert.equal(snapshotOf(redirected).host, 'a.example');
  assert.match(submissionProblem({ ...report('a.example', 50), url: 'https://a.example/blog/post' }, T0), /home page/);
  assert.match(submissionProblem({ ...report('a.example', 50), final_url: 'https://b.example/' }, T0), /different site/);
  assert.match(submissionProblem(report('1.2.3.44', 50), T0), /public domain/);
  assert.match(submissionProblem(report('a.example:8080', 50), T0), /public domain/);
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

test('rendering escapes host names and stays accessible', () => {
  const evil = submit(null, report('a.example', 70)).entry;
  evil.host = '<img src=x onerror=alert(1)>.example';
  const row = rankBoard([evil], 'top', T0)[0];
  const html = renderLeagueHtml({ base: 'https://c.example', board: 'top', rows: [row], page: 1, stats: { players: 1, average: 70, top: 70, achievements: 1 }, crowns: [], now: T0 });
  assert.ok(!html.includes('<img src=x'));
  assert.equal((html.match(/<main/g) || []).length, 1);
  assert.match(html, /<caption/);
  const prof = renderProfileHtml({ base: 'https://c.example', st: standing([evil], evil.host, T0), now: T0 });
  assert.ok(!prof.includes('<img src=x'));
});

// ---- routes
function makeApp(o = {}) {
  let now = T0;
  const app = createApp({
    scan: async (url) => fakeReport(url, { scanned_at: new Date(now).toISOString() }),
    store: memoryStore(), rateLimit: memoryRateLimiter({ limit: 100, windowSeconds: 600 }), resolve: async () => ['93.184.216.34'],
    browserAvailable: false, now: () => now, ...o,
  });
  return { app, advance: (ms) => { now += ms; } };
}
const B = 'https://checker.example';
const json = (app, path, body, method = 'POST', headers = {}) => app.request(B + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

test('routes: scan, join through the form, profile, boards, badge, markdown', async () => {
  const { app } = makeApp({ leagueAdminToken: 'secret' });
  const scan = await (await json(app, '/api/scan', { url: 'https://example.com' })).json();
  const page = await (await app.request(`${B}/r/${scan.id}`, { headers: { accept: 'text/html' } })).text();
  assert.match(page, /Join the League/);
  const form = await app.request(`${B}/league/join`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: B }, body: `report_id=${scan.id}` });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('location'), '/league/example.com?joined=1');
  const profile = await app.request(`${B}/league/example.com?joined=1`);
  assert.equal(profile.status, 200);
  assert.equal(profile.headers.get('cache-control'), 'no-store');
  assert.match(await profile.text(), /example\.com/);
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
  // report page now shows the standing
  assert.match(await (await app.request(`${B}/r/${scan.id}`, { headers: { accept: 'text/html' } })).text(), /Open your profile/);
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

test('MCP get_league reads boards and standings', async () => {
  const { app } = makeApp();
  await json(app, '/api/league', { url: 'https://example.com' });
  const call = async (args) => (await (await json(app, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_league', arguments: args } }, 'POST', { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' })).json()).result;
  const board = await call({});
  assert.match(board.content[0].text, /example\.com/);
  const one = await call({ host: 'example.com' });
  assert.equal(one.structuredContent.host, 'example.com');
  assert.equal((await call({ host: 'nobody.example' })).isError, true);
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
  const rows = new Map(); let schemaRuns = 0;
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (sql.startsWith('CREATE')) { schemaRuns++; return { success: true }; }
      if (sql.startsWith('INSERT INTO league')) { if (rows.has(args[0])) throw new Error('UNIQUE constraint failed'); rows.set(args[0], { version: 1, updated: args[1], body: args[2] }); return { meta: { changes: 1 } }; }
      if (sql.startsWith('UPDATE league')) { const r = rows.get(args[2]); if (!r || (args.length > 3 && r.version !== args[3])) return { meta: { changes: 0 } }; Object.assign(r, { body: args[0], updated: args[1], version: r.version + 1 }); return { meta: { changes: 1 } }; }
      if (sql.startsWith('DELETE FROM league')) return { meta: { changes: rows.delete(args[0]) ? 1 : 0 } };
      return { success: true, meta: { changes: 0 } };
    },
    async first() { const r = rows.get(args[0]); return r ? { body: r.body, version: r.version } : null; },
    async all() { return { results: [...rows.values()].filter((r) => r.updated >= args[0]).map((r) => ({ body: r.body })) }; },
  });
  const db = { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((x) => x.run())) };
  const lg = d1Store(db, { now: () => T0 }).league;
  const snap = snapshotOf(report('d.example', 70));
  assert.equal((await lg.submit('d.example', (p) => applySubmission(p, snap, T0))).changed, true);
  const snap2 = snapshotOf(report('d.example', 75, T0 + DAY));
  assert.equal((await lg.submit('d.example', (p) => applySubmission(p, snap2, T0 + DAY))).entry.score, 75);
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
  assert.ok(schemaRuns >= 1);
});

test('concurrent submissions to every store lose no updates', async () => {
  const hosts = Array.from({ length: 12 }, (_, i) => `site${i}.example`);
  const run = async (lg) => {
    await Promise.all(hosts.map((h) => lg.submit(h, (p) => applySubmission(p, snapshotOf(report(h, 50)), T0))));
    assert.equal((await lg.list()).length, hosts.length);
    // the same site from two clients at once: exactly one of the two different reports is the latest and nothing is lost
    const [a, b] = [snapshotOf(report('site0.example', 60, T0 + DAY)), snapshotOf(report('site0.example', 70, T0 + 2 * DAY))];
    await Promise.all([a, b].map((s) => lg.submit('site0.example', (p) => applySubmission(p, s, T0 + 2 * DAY))));
    const e = await lg.get('site0.example');
    assert.equal(e.score, 70);
    assert.equal(e.history.length, 3);
    assert.equal((await lg.list()).length, hosts.length);
  };
  await run(memoryLeague({ now: () => T0 }));
  const dir = mkdtempSync(join(tmpdir(), 'league-c-'));
  try { await run(fsLeague({ dir, now: () => T0 })); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('routes: www and apex are one standing, deep pages and redirects are refused, an older report cannot replace a newer one', async () => {
  const store = memoryStore();
  const { app } = makeApp({ store });
  const put = (url, over = {}) => store.put(fakeReport(url, { scanned_at: new Date(T0).toISOString(), ...over }));
  const idWww = await put('https://www.canon.example/');
  const idApex = await put('https://canon.example/', { scanned_at: new Date(T0 + 1000).toISOString(), score: 55 });
  assert.equal((await json(app, '/api/league', { report_id: idWww })).status, 201);
  assert.equal((await (await json(app, '/api/league', { report_id: idApex })).json()).host, 'canon.example');
  const board = await (await app.request(`${B}/api/league`)).json();
  assert.deepEqual(board.rows.map((r) => r.host), ['canon.example']);
  assert.equal((await app.request(`${B}/league/www.canon.example`)).status, 200);
  // the older report (www one) can no longer replace the newer standing
  const older = await put('https://canon.example/', { scanned_at: new Date(T0 - 1000).toISOString(), score: 99 });
  const stale = await json(app, '/api/league', { report_id: older });
  assert.equal(stale.status, 409);
  assert.equal((await (await app.request(`${B}/api/league/canon.example`)).json()).score, 55);
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
