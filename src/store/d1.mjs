// Cloudflare D1 report store and rate limiter. Runtime-neutral: only uses the D1 binding API
// (prepare/bind/run/first/all/batch). Creates its tables on first use.
import { RETENTION_MS, newId, hostOf, normHost, ID_RE, serialize } from './common.mjs';
import { normalizeHost } from '../league/engine.mjs';
import { FORGET_MS, MAX_ENTRIES } from '../league/store.mjs';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, host TEXT NOT NULL, url TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS reports_host ON reports (host, created)',
  'CREATE INDEX IF NOT EXISTS reports_url ON reports (url, created)',
  'CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, start INTEGER NOT NULL, used INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS league (host TEXT PRIMARY KEY, version INTEGER NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL)',
  "CREATE INDEX IF NOT EXISTS league_retention ON league (updated) WHERE json_extract(body, '$.tombstone') IS NULL",
  "CREATE INDEX IF NOT EXISTS league_active_xp ON league (CAST(json_extract(body, '$.xp') AS REAL), host) WHERE json_extract(body, '$.tombstone') IS NULL",
];

function schema(db) {
  if (!db.__isAINativeSchema) db.__isAINativeSchema = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { db.__isAINativeSchema = null; throw e; });
  return db.__isAINativeSchema;
}

/** League standings on D1: one row per host, a version column makes each read-modify-write a compare-and-swap. */
export function d1League(db, { now = () => Date.now() } = {}) {
  const parse = (row) => { try { return row ? JSON.parse(row.body) : null; } catch { return null; } };
  const expire = () => db.prepare("DELETE FROM league WHERE updated < ? AND json_extract(body, '$.tombstone') IS NULL").bind(now() - FORGET_MS).run();
  const evict = () => db.prepare(`DELETE FROM league WHERE host IN (
    SELECT host FROM league WHERE json_extract(body, '$.tombstone') IS NULL
    ORDER BY CAST(json_extract(body, '$.xp') AS REAL), host
    LIMIT max((SELECT COUNT(*) FROM league WHERE json_extract(body, '$.tombstone') IS NULL) - ?, 0)
  )`).bind(MAX_ENTRIES);
  // Writes from this instance run one at a time; the version column only settles conflicts with other instances.
  let queue = Promise.resolve();
  const serial = (fn) => (...a) => { const run = queue.then(() => fn(...a)); queue = run.catch(() => {}); return run; };
  return {
    kind: 'd1',
    async list() {
      await schema(db);
      const { results } = await db.prepare("SELECT body FROM league WHERE updated >= ? AND json_extract(body, '$.tombstone') IS NULL ORDER BY updated DESC LIMIT ?").bind(now() - FORGET_MS, MAX_ENTRIES).all();
      return (results || []).map(parse).filter((e) => e && !e.tombstone);
    },
    async get(host) {
      await schema(db);
      const e = parse(await db.prepare('SELECT body FROM league WHERE host = ?').bind(normalizeHost(host)).first());
      return e && !e.tombstone ? e : null;
    },
    submit: serial(async (host, fn) => {
      await schema(db);
      const h = normalizeHost(host);
      for (let attempt = 0; attempt < 6; attempt++) {
        await expire();
        const row = await db.prepare('SELECT body, version FROM league WHERE host = ?').bind(h).first();
        const cur = parse(row);
        if (cur?.tombstone) return { entry: null, changed: false, events: [], error: 'suppressed', message: 'This site was removed from the League and cannot be added again by a submission.' };
        const out = await fn(cur);
        if (!out.changed) return out;
        const body = JSON.stringify(out.entry);
        const updated = Date.parse(out.entry.updated_at);
        try {
          const write = row
            ? db.prepare('UPDATE league SET body = ?, version = version + 1, updated = ? WHERE host = ? AND version = ? AND body = ?').bind(body, updated, h, row.version, row.body)
            : db.prepare('INSERT INTO league (host, version, updated, body) VALUES (?, 1, ?, ?)').bind(h, updated, body);
          const results = await db.batch([write, evict()]);
          if ((results?.[0]?.meta?.changes ?? 1) > 0) {
            const retained = parse(await db.prepare('SELECT body FROM league WHERE host = ?').bind(h).first());
            if (!retained || retained.tombstone) return { entry: null, changed: false, events: [], error: 'capacity', message: 'The League is full and cannot retain this standing. Try again later.' };
            return out;
          }
        } catch (e) { if (!row && /unique|constraint/i.test(String(e?.message))) continue; throw e; }
      }
      throw new Error('The League is busy, try again in a moment.');
    }),
    // A removal keeps a tombstone row (body {"tombstone":true}) so submissions cannot add the host straight back.
    remove: serial(async (host, { suppress = true } = {}) => {
      await schema(db);
      const h = normalizeHost(host);
      await expire();
      const row = await db.prepare('SELECT body, version FROM league WHERE host = ?').bind(h).first();
      const cur = parse(row);
      if (cur?.tombstone || (!row && !suppress)) return false;
      if (!suppress) {
        const r = await db.prepare('DELETE FROM league WHERE host = ? AND version = ? AND body = ?').bind(h, row.version, row.body).run();
        return (r?.meta?.changes ?? 0) > 0;
      }
      const body = JSON.stringify({ tombstone: true, at: new Date(now()).toISOString() });
      await db.prepare(`INSERT INTO league (host, version, updated, body) VALUES (?, 1, ?, ?)
        ON CONFLICT(host) DO UPDATE SET body = excluded.body, version = league.version + 1, updated = excluded.updated`)
        .bind(h, now() + 100 * 365 * 86_400_000, body).run();
      return true;
    }),
    restore: serial(async (host) => {
      await schema(db);
      const h = normalizeHost(host);
      const row = await db.prepare('SELECT body, version FROM league WHERE host = ?').bind(h).first();
      const cur = parse(row);
      if (!cur?.tombstone) return false;
      const r = await db.prepare('DELETE FROM league WHERE host = ? AND version = ? AND body = ?').bind(h, row.version, row.body).run();
      return (r?.meta?.changes ?? 0) > 0;
    }),
    async isSuppressed(host) {
      await schema(db);
      return !!parse(await db.prepare('SELECT body FROM league WHERE host = ?').bind(normalizeHost(host)).first())?.tombstone;
    },
  };
}

export function d1Store(db, { retentionMs = RETENTION_MS, now = () => Date.now() } = {}) {
  if (!db) throw new Error('d1Store needs a D1 binding');
  let lastPrune = 0;
  const prune = async () => {
    const t = now();
    if (t - lastPrune < 3_600_000) return;
    lastPrune = t;
    await db.prepare('DELETE FROM reports WHERE created < ?').bind(t - retentionMs).run();
  };
  const parse = (row) => { try { return row ? JSON.parse(row.body) : null; } catch { return null; } };
  return {
    kind: 'd1',
    league: d1League(db, { now }),
    async put(report) {
      await schema(db);
      const id = report.id || newId();
      await db.prepare('INSERT INTO reports (id, host, url, created, body) VALUES (?, ?, ?, ?, ?)')
        .bind(id, hostOf(report), report.url, now(), serialize({ ...report, id })).run();
      prune().catch(() => {});
      return id;
    },
    async get(id) {
      if (!ID_RE.test(String(id))) return null;
      await schema(db);
      return parse(await db.prepare('SELECT body FROM reports WHERE id = ? AND created >= ?').bind(id, now() - retentionMs).first());
    },
    async latestForHost(host) {
      await schema(db);
      return parse(await db.prepare('SELECT body FROM reports WHERE host = ? AND created >= ? ORDER BY created DESC LIMIT 1').bind(normHost(host), now() - retentionMs).first());
    },
    async latestForUrl(url, maxAgeMs = retentionMs) {
      await schema(db);
      return parse(await db.prepare('SELECT body FROM reports WHERE url = ? AND created >= ? ORDER BY created DESC LIMIT 1').bind(url, now() - maxAgeMs).first());
    },
  };
}

/**
 * Fixed-window rate limiter on D1 (shared by every Worker isolate). Same interface as server/ratelimit.mjs:
 * hit(key) -> { allowed, limit, remaining, reset (seconds), window (seconds), policy }
 */
export function d1RateLimiter(db, { limit = 10, windowSeconds = 600, policy = 'scans', now = () => Date.now() } = {}) {
  return {
    limit, windowSeconds, policy,
    async hit(key) {
      await schema(db);
      const t = now();
      const k = `${policy}:${key}`;
      const row = await db.prepare('SELECT start, used FROM rate WHERE k = ?').bind(k).first();
      let start = row?.start ?? t; let used = row?.used ?? 0;
      if (t - start >= windowSeconds * 1000) { start = t; used = 0; }
      const reset = Math.max(0, Math.ceil((start + windowSeconds * 1000 - t) / 1000));
      if (used >= limit) return { allowed: false, limit, remaining: 0, reset, window: windowSeconds, policy };
      used += 1;
      await db.prepare('INSERT INTO rate (k, start, used) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET start = excluded.start, used = excluded.used').bind(k, start, used).run();
      return { allowed: true, limit, remaining: limit - used, reset, window: windowSeconds, policy };
    },
  };
}
