// The Hono app shared by the Node server, Docker/Azure and the Cloudflare Worker. Runtime-neutral:
// no node: imports. Runtime specifics (scan function, store, rate limiter, static assets) are injected.
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { normalizeUrl } from '../src/core/scan.mjs';
import { isBlockedIP, isIPLiteral } from '../src/core/net.mjs';
import { CHECKS, LAYERS, catalog } from '../src/checks/index.mjs';
import { createMcpHandler, checkInfo } from '../src/mcp/server.mjs';
import * as files from '../src/agent-files/index.mjs';
import { SITE, MCP_CARD_TYPE, LINKSET_TYPE, SKILL_NAME } from '../src/agent-files/site.mjs';
import { markdownToHtml, esc } from './markdown.mjs';
import { jsonLdData } from './layout.mjs';
import { rateLimitHeaders } from './ratelimit.mjs';
import * as defaultRenderers from './render.mjs';
import { ID_RE } from '../src/store/common.mjs';
import { memoryLeague } from '../src/league/store.mjs';
import { LEVEL_NAMES } from '../src/core/score.mjs';
import {
  BOARD_IDS, ACHIEVEMENT_BY_ID, applySubmission, snapshotOf, submissionProblem, rankBoard, rowOf, standing, crownsOf, projectedRank, quests,
  divisionOf, playerLevel, isActive, normalizeHost, reportHost,
} from '../src/league/engine.mjs';
import { leaguePanel, renderLeagueHtml, renderProfileHtml, renderLeagueMarkdown, renderProfileMarkdown, renderLeagueBadge, PER_PAGE } from '../src/league/render.mjs';

export const DEFAULT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const MD = 'text/markdown; charset=utf-8';
const HTML = 'text/html; charset=utf-8';
const PROBLEM = 'application/problem+json';
const STATUS_TITLES = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' };

/** True when the Accept header prefers text/markdown to text/html. */
export function wantsMarkdown(accept) {
  if (!accept) return false;
  const q = {};
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    q[type.trim()] = qp ? Number(qp.slice(2)) || 0 : 1;
  }
  const md = q['text/markdown'] ?? q['text/x-markdown'] ?? 0;
  if (md <= 0) return false;
  const html = Math.max(q['text/html'] ?? 0, q['application/xhtml+xml'] ?? 0);
  return md >= html;
}

async function weakEtag(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return `W/"${[...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

class HttpError extends Error {
  constructor(status, detail, extra = {}) { super(detail); this.status = status; Object.assign(this, extra); }
}

/**
 * @param {object} o
 * @param {(url:string, opts:{browser:boolean})=>Promise<object>} o.scan   core scan for this runtime (returns a report)
 * @param {object} o.store         report store (src/store/*)
 * @param {object} o.rateLimit     limiter with hit(key) (server/ratelimit.mjs or d1RateLimiter)
 * @param {string} [o.baseUrl]     public origin; derived from the request when absent
 * @param {boolean} [o.browserAvailable]
 * @param {(host:string)=>Promise<string[]>} [o.resolve]  DNS lookup for the pre-scan address check (422)
 * @param {boolean} [o.allowPrivate]  tests/local only: allow private targets
 * @param {(path:string, request:Request)=>Promise<Response|null>} [o.assets]  static files (public/)
 * @param {string} [o.homeHtml]    the landing page HTML (Worker bundle inlines public/index.html)
 * @param {object} [o.renderers]   override src/report renderers (tests)
 * @param {number} [o.cacheMs]     result cache per URL (default 10 min)
 * @param {number} [o.maxBodyBytes]
 * @param {string[]} [o.allowedOrigins] extra browser origins for /mcp
 * @param {string} [o.csp]
 * @param {string} [o.runtime]
 * @param {object} [o.league]      League store (src/league/store.mjs); defaults to store.league, else in memory
 * @param {string} [o.leagueAdminToken]  bearer token that allows DELETE /api/league/{host} (moderation); unset disables it
 * @param {string} [o.leagueRemovalUrl]  where the pages send owners who want a listing removed (default: the project's issue form)
 * @param {() => number} [o.now]   clock (tests)
 */
export function createApp(o) {
  const {
    scan, store, rateLimit, browserAvailable = false, resolve = null, allowPrivate = false, assets = null,
    renderers = defaultRenderers, cacheMs = 600_000, maxBodyBytes = 16_384, allowedOrigins = [], csp = DEFAULT_CSP, runtime = 'node', trustProxy = false, leagueAdminToken = '', leagueRemovalUrl = undefined,
  } = o;
  const R = { ...defaultRenderers, ...renderers };
  const app = new Hono();
  // gzip/deflate for text responses of 1 KB or more on Node (event streams excluded by the middleware). On Workers
  // the runtime compresses on the wire when Content-Encoding is set (server/worker.mjs), so the app must not.
  if (runtime === 'node' || runtime === 'azure') app.use('*', compress());
  const cache = new Map(); // key -> { report, at }
  const inflight = new Map(); // key -> promise
  let selfScans = 0;

  const baseOf = (c) => {
    if (o.baseUrl) return String(o.baseUrl).replace(/\/+$/, '');
    const u = new URL(c.req.url);
    const proto = (c.req.header('x-forwarded-proto') || '').split(',')[0].trim() || u.protocol.replace(':', '');
    const host = (c.req.header('x-forwarded-host') || '').split(',')[0].trim() || c.req.header('host') || u.host;
    return `${proto}://${host}`;
  };
  const clientKey = (c) => {
    const remote = c.env?.remoteAddress || c.env?.incoming?.socket?.remoteAddress;
    if (runtime === 'node') return (trustProxy && (c.req.header('x-forwarded-for') || '').split(',')[0].trim()) || remote || 'anonymous';
    if (runtime === 'azure') return (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || remote || 'anonymous';
    return c.req.header('cf-connecting-ip') || (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || remote || 'anonymous';
  };
  const readLimitedBody = async (c) => {
    const length = Number(c.req.header('content-length'));
    if (Number.isFinite(length) && length > maxBodyBytes) {
      await c.req.raw.body?.cancel().catch(() => {});
      return { tooLarge: true };
    }
    const reader = c.req.raw.body?.getReader();
    if (!reader) return { text: '' };
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel().catch(() => {});
          return { tooLarge: true };
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { text: new TextDecoder().decode(body) };
  };

  const problem = (c, status, detail, extra = {}) => {
    const body = { type: extra.type || 'about:blank', title: extra.title || STATUS_TITLES[status] || 'Error', status, detail, instance: new URL(c.req.url).pathname, ...(extra.fields || {}) };
    return c.body(JSON.stringify(body, null, 2), status, { 'content-type': PROBLEM, ...(extra.headers || {}) });
  };

  /** Send text with a weak ETag and 304 handling. */
  const sendText = async (c, text, type, headers = {}) => {
    const etag = await weakEtag(text);
    const h = { 'content-type': type, etag, 'cache-control': headers['cache-control'] || 'public, max-age=300', ...headers };
    const inm = c.req.header('if-none-match');
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) return c.body(null, 304, h);
    return c.body(c.req.method === 'HEAD' ? null : text, 200, h);
  };

  /** An HTML page that also answers Accept: text/markdown. */
  const htmlOrMd = async (c, { html, md, headers = {}, htmlHeaders = {}, mdHeaders = {} }) => {
    c.header('Vary', 'Accept');
    if (wantsMarkdown(c.req.header('accept'))) return sendText(c, typeof md === 'function' ? await md() : md, MD, { ...headers, ...mdHeaders });
    return sendText(c, typeof html === 'function' ? await html() : html, HTML, { ...headers, ...htmlHeaders });
  };

  const mdPage = (c, path, mdText, description) => {
    const base = baseOf(c);
    const { title, html } = markdownToHtml(mdText);
    const body = `<h1>${esc(title)}</h1>\n<p class="lead">${esc(description)}</p>\n<div class="prose">${html}</div>`;
    return htmlOrMd(c, { html: () => R.shell({ base, path, title, description, body, mdPath: `${path}.md`, jsonld: jsonLdData(base, { name: title, description, path }) }), md: mdText, headers: { link: `<${path}.md>; rel="alternate"; type="text/markdown"` } });
  };

  // ---- security headers and CORS on every response
  app.use('*', async (c, next) => {
    await next();
    const h = c.res.headers;
    const set = (k, v) => { if (!h.has(k)) h.set(k, v); };
    set('Content-Security-Policy', csp);
    set('X-Content-Type-Options', 'nosniff');
    set('X-Frame-Options', 'DENY');
    set('Referrer-Policy', 'strict-origin-when-cross-origin');
    set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    const p = new URL(c.req.url).pathname;
    if (p !== '/mcp' && (p.startsWith('/api/') || p.startsWith('/.well-known/') || /\.(txt|json|xml|md|svg)$/.test(p) || p.startsWith('/badge') || p === '/mcp/server-card')) {
      set('Access-Control-Allow-Origin', '*');
      set('Access-Control-Expose-Headers', 'RateLimit, RateLimit-Policy, Retry-After, Link, ETag');
    }
  });
  app.options('/api/*', (c) => c.body(null, 204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, accept', 'Access-Control-Max-Age': '86400' }));

  // ---- scanning with cache, dedupe, rate limit, self-scan guard and storage
  async function preflight(url) {
    if (allowPrivate) return; // local testing: any port, any address
    if (!['80', '443', ''].includes(url.port)) throw new HttpError(422, `Port ${url.port} is not allowed; only 80 and 443 can be scanned.`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new HttpError(422, `${host} is a local name and cannot be scanned.`);
    if (isIPLiteral(host)) { if (isBlockedIP(host)) throw new HttpError(422, `${host} is a private or reserved address and cannot be scanned.`); return; }
    if (resolve) {
      let addrs = [];
      try { addrs = await resolve(host); } catch { throw new HttpError(422, `The host name ${host} does not resolve.`); }
      if (!addrs.length) throw new HttpError(422, `The host name ${host} does not resolve.`);
      if (addrs.some(isBlockedIP)) throw new HttpError(422, `${host} resolves to a private or reserved address and cannot be scanned.`);
    }
  }

  async function runScan(c, input, { browser = false } = {}) {
    let url;
    try { url = normalizeUrl(input); } catch (e) { throw new HttpError(400, e.message); }
    if (String(input).length > 2048) throw new HttpError(400, 'The URL is longer than 2048 characters.');
    const useBrowser = !!browser && browserAvailable;
    const key = `${url.href}${useBrowser ? '#browser' : ''}`;
    const base = baseOf(c);
    const withUrl = (r) => ({ ...r, report_url: r.id ? `${base}/r/${r.id}` : null });
    const hasHomepageExchange = (report) => {
      const id = report?.homepage_exchange_id;
      if (!(typeof id === 'string' && id.length > 0) && !(typeof id === 'number' && Number.isFinite(id))) return false;
      return !!report?.exchanges?.[id];
    };

    const hit = cache.get(key);
    if (hit && hasHomepageExchange(hit.report) && Date.now() - hit.at < cacheMs && !hit.report.mode?.browser_error) return { report: withUrl(hit.report), cached: true };
    if (store?.latestForUrl) {
      const prev = await store.latestForUrl(url.href, cacheMs).catch(() => null);
      if (prev && hasHomepageExchange(prev) && !!prev.mode?.browser === useBrowser && !prev.mode?.browser_error) { cache.set(key, { report: prev, at: Date.parse(prev.scanned_at) || Date.now() }); return { report: withUrl(prev), cached: true }; }
    }
    if (inflight.has(key)) return { report: withUrl(await inflight.get(key)), cached: true };

    await preflight(url);
    const isSelf = url.host === new URL(base).host;
    if (isSelf && selfScans > 0) throw new HttpError(409, 'A scan of this service is already running; try again in a minute.');
    const rl = await rateLimit.hit(clientKey(c));
    c.set('rl', rl);
    if (!rl.allowed) throw new HttpError(429, `This client used its ${rl.limit} scans for the current ${rl.window}-second window. Retry after ${rl.reset} seconds.`, { retryAfter: rl.reset, rl });

    const job = (async () => {
      if (isSelf) selfScans++;
      try {
        const report = await scan(url.href, { browser: useBrowser });
        let id = null;
        try { id = await store.put(report); } catch (e) { report.storage_error = String(e?.message || e); }
        const stored = { ...report, id };
        cache.set(key, { report: stored, at: Date.now() });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return stored;
      } finally { if (isSelf) selfScans--; }
    })();
    inflight.set(key, job);
    try { return { report: withUrl(await job), cached: false }; } finally { inflight.delete(key); }
  }

  const scanError = (c, e) => {
    if (e instanceof HttpError || e?.status) {
      const status = e.status || 500;
      const headers = {};
      if (status === 429) { Object.assign(headers, rateLimitHeaders(e.rl || { policy: rateLimit.policy || 'scans', limit: rateLimit.limit, remaining: 0, reset: e.retryAfter, window: rateLimit.windowSeconds })); headers['Retry-After'] = String(e.retryAfter ?? 60); }
      return problem(c, status, e.message, status === 429 ? { type: 'https://iana.org/assignments/http-problem-types#quota-exceeded', title: 'Request cannot be satisfied as assigned quota has been exceeded', headers, fields: { 'violated-policies': [rateLimit.policy || 'scans'] } } : { headers });
    }
    return problem(c, 500, `The scan failed: ${e?.message || e}`);
  };

  const rlHeaders = (c) => { const rl = c.get('rl'); return rl ? rateLimitHeaders(rl) : { 'RateLimit-Policy': `"${rateLimit.policy || 'scans'}";q=${rateLimit.limit};w=${rateLimit.windowSeconds}` }; };

  async function apiScanResponse(c, input, { browser, format }) {
    if (format && !['json', 'markdown', 'agent'].includes(format)) return problem(c, 400, 'format must be json, markdown or agent.');
    let out;
    try { out = await runScan(c, input, { browser }); } catch (e) { return scanError(c, e); }
    const headers = { ...rlHeaders(c), 'cache-control': 'no-store', 'x-cache': out.cached ? 'HIT' : 'MISS' };
    if (out.report.id) headers['content-location'] = `/api/reports/${out.report.id}`;
    if (format === 'markdown') return c.body(R.renderReportMarkdown(out.report, { baseUrl: baseOf(c), reportId: out.report.id }), 200, { ...headers, 'content-type': MD });
    if (format === 'agent') return c.body(R.renderFixPrompts(out.report, { baseUrl: baseOf(c), reportId: out.report.id }), 200, { ...headers, 'content-type': MD });
    return c.body(JSON.stringify(out.report), 200, { ...headers, 'content-type': 'application/json' });
  }

  // ---- API
  app.post('/api/scan', async (c) => {
    const len = Number(c.req.header('content-length') || 0);
    if (len > maxBodyBytes) return problem(c, 413, `The body is larger than ${maxBodyBytes} bytes.`);
    const type = c.req.header('content-type') || '';
    let body;
    try {
      const raw = await c.req.text();
      if (raw.length > maxBodyBytes) return problem(c, 413, `The body is larger than ${maxBodyBytes} bytes.`);
      if (type && !/json/i.test(type) && !/form-urlencoded/i.test(type)) return problem(c, 415, 'Send the body as application/json: {"url": "https://example.com"}.');
      body = /form-urlencoded/i.test(type) ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}');
    } catch { return problem(c, 400, 'The body is not valid JSON. Send {"url": "https://example.com"}.'); }
    if (!body || typeof body !== 'object' || typeof body.url !== 'string') return problem(c, 400, 'The body needs a "url" string, for example {"url": "https://example.com"}.');
    return apiScanResponse(c, body.url, { browser: body.browser === true || body.browser === 'true', format: body.format || 'json' });
  });
  app.get('/api/scan', (c) => {
    const url = c.req.query('url');
    if (!url) return problem(c, 400, 'The url query parameter is required, for example /api/scan?url=example.com.');
    return apiScanResponse(c, url, { browser: c.req.query('browser') === 'true', format: c.req.query('format') || 'json' });
  });
  app.get('/api/checks', (c) => {
    const layer = c.req.query('layer');
    if (layer && !LAYERS.some((l) => l.id === layer)) return problem(c, 400, `Unknown layer "${layer}". Layers: ${LAYERS.map((l) => l.id).join(', ')}.`);
    const checks = CHECKS.filter((x) => !layer || x.layer === layer).map((x) => checkInfo(x.id));
    return sendText(c, JSON.stringify({ version: SITE.version, checked: catalog.checked, count: checks.length, layers: LAYERS, checks }), 'application/json', rlHeaders(c));
  });
  app.get('/api/checks/:id', (c) => {
    const info = checkInfo(c.req.param('id'));
    if (!info) return problem(c, 404, `No check with id "${c.req.param('id')}". See /api/checks.`);
    return sendText(c, JSON.stringify(info), 'application/json', rlHeaders(c));
  });
  app.get('/api/reports/:id', async (c) => {
    const r = await store.get(c.req.param('id')).catch(() => null);
    if (!r) return problem(c, 404, 'No stored report with that id (reports are kept 30 days).', { headers: rlHeaders(c) });
    return c.body(JSON.stringify({ ...r, report_url: `${baseOf(c)}/r/${r.id}` }), 200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', ...rlHeaders(c) });
  });
  app.get('/api/health', (c) => c.json({ status: 'ok', version: SITE.version, runtime, browser: browserAvailable, checks: CHECKS.length, store: store?.kind || null }, 200, { 'cache-control': 'no-store', ...rlHeaders(c) }));
  // ---- AI-Native League (docs/LEAGUE.md): boards, profiles, joining, badges
  const league = o.league || store?.league || memoryLeague();
  const clock = o.now || (() => Date.now());
  let leagueSnapshot = null; let leagueSnapshotAt = 0; let leagueGeneration = 0; let leagueLoad = null;
  const leagueSuppressionSnapshot = new Map();
  const joins = new Map(); // client -> recent join timestamps (per instance; joins are cheap, this only stops floods)
  const joinAllowed = (c) => {
    const k = clientKey(c); const t = clock(); const recent = (joins.get(k) || []).filter((x) => t - x < 3_600_000);
    if (recent.length >= 30) return false;
    recent.push(t); joins.set(k, recent);
    if (joins.size > 5000) joins.delete(joins.keys().next().value);
    return true;
  };
  const invalidateLeagueSnapshot = () => { leagueGeneration++; leagueSnapshot = null; leagueLoad = null; leagueSuppressionSnapshot.clear(); };
  let leagueSnapshotStarted = -Infinity; let confirmLoad = null; let confirmStarted = -Infinity;
  const mono = () => performance.now();
  const loadLeague = () => {
    const generation = leagueGeneration; const started = mono();
    const load = { generation, started, promise: null };
    load.promise = Promise.resolve().then(() => league.list()).then((entries) => {
      if (generation === leagueGeneration && started >= leagueSnapshotStarted) { leagueSnapshot = entries; leagueSnapshotAt = clock(); leagueSnapshotStarted = started; leagueSuppressionSnapshot.clear(); }
      return entries;
    }).finally(() => { if (leagueLoad === load) leagueLoad = null; });
    leagueLoad = load;
    return load.promise;
  };
  const leagueEntries = async () => {
    if (leagueSnapshot && clock() - leagueSnapshotAt < 5_000) return leagueSnapshot;
    if (leagueLoad?.generation === leagueGeneration) return leagueLoad.promise;
    return loadLeague();
  };
  // Standings loaded after `since` (a post-join confirmation may land on an instance whose snapshot predates the write).
  // Waiting requests share one reload, and at most one such reload starts per second, so query flags cannot multiply store reads.
  const leagueEntriesSince = async (since) => {
    if (leagueSnapshot && leagueSnapshotStarted >= since) return leagueSnapshot;
    if (leagueLoad?.generation === leagueGeneration && leagueLoad.started >= since) return leagueLoad.promise;
    if (!confirmLoad) {
      const wait = Math.max(0, confirmStarted + 1_000 - mono());
      confirmLoad = new Promise((r) => setTimeout(r, wait)).then(() => { confirmLoad = null; confirmStarted = mono(); return loadLeague(); });
    }
    return confirmLoad;
  };
  const leagueSuppressed = async (host) => {
    const entries = await leagueEntries();
    const generation = leagueGeneration;
    if (leagueSuppressionSnapshot.has(host)) return leagueSuppressionSnapshot.get(host);
    const suppressed = await league.isSuppressed?.(host) || false;
    if (generation === leagueGeneration && leagueSnapshot === entries) leagueSuppressionSnapshot.set(host, suppressed);
    return suppressed;
  };
  const leagueStats = (entries) => {
    const act = entries.filter((e) => isActive(e, clock()));
    return { players: act.length, average: act.length ? Math.round(act.reduce((s, e) => s + e.score, 0) / act.length) : 0, top: act.reduce((m, e) => Math.max(m, e.score), 0), achievements: act.reduce((s, e) => s + Object.keys(e.achievements || {}).length, 0) };
  };
  const publicEntry = (entries, e) => {
    const st = standing(entries, e.host, clock());
    return {
      host: e.host, active: st.active, score: e.score, best_score: e.best_score, level: e.level, level_name: LEVEL_NAMES[e.level] || '', best_level: e.best_level,
      division: divisionOf(e.score).id, xp: e.xp, player_level: playerLevel(e.xp).level, streak: row(e).streak, best_streak: e.best_streak,
      joined_at: e.joined_at, updated_at: e.updated_at, report_id: e.report_id,
      ranks: st.ranks, players: st.total, crowns: st.crowns,
      achievements: Object.entries(e.achievements || {}).map(([id, at]) => ({ id, name: ACHIEVEMENT_BY_ID[id]?.name || id, xp: ACHIEVEMENT_BY_ID[id]?.xp || 0, unlocked_at: at })),
      layers: e.layers, history: e.history,
    };
  };
  const row = (e) => rowOf(e, 0, clock());
  const boardOf = (v) => (BOARD_IDS.includes(v) ? v : 'top');
  const pageOf = (v) => Math.max(1, Math.min(1000, parseInt(v, 10) || 1));

  /** Everything the report page needs to show the League panel; null when this report cannot be submitted. */
  async function panelFor(report) {
    try {
      if (!report?.id) return '';
      const reportProblem = submissionProblem(report, clock());
      const entries = await leagueEntries();
      const host = reportHost(report); const entry = entries.find((e) => e.host === host) || null;
      const suppressed = entry ? false : await leagueSuppressed(host); // removal deletes the standing, so a listed host is never suppressed
      const standingProblem = entry && !reportProblem ? applySubmission(entry, snapshotOf(report), clock()) : null;
      const joinProblem = reportProblem || (standingProblem?.error ? standingProblem.message : null);
      const st = entry ? standing(entries, host, clock()) : null;
      const at = Date.parse(report.scanned_at);
      const ctx = {
        entry, rank: st?.ranks || null, total: st?.total ?? 0,
        projected: projectedRank(entries, host, Math.round(report.score), report.compat?.isitagentready?.level ?? 0, clock()),
        quests: quests(report),
        teaser: !joinProblem && !suppressed ? applySubmission(null, snapshotOf(report), clock()).events.filter((e) => e.type === 'achievement' && e.id !== 'player-one').map((e) => e.id) : [],
        newer: !!entry && at > Date.parse(entry.updated_at_report), older: !!entry && at < Date.parse(entry.updated_at_report),
        joinProblem, suppressed,
      };
      return leaguePanel({ report, ctx });
    } catch { return ''; }
  }

  const LEAGUE_UNAVAILABLE = 'The League is temporarily unavailable. Please try again shortly.';
  // A missing report is a 404; a failed read is a retryable 503, so an outage never looks like an expired report.
  async function storedReport(id) {
    try { return await store.get(id); } catch (e) {
      console.error('Report read for a League submission failed', e);
      throw new HttpError(503, LEAGUE_UNAVAILABLE);
    }
  }

  async function joinReport(report) {
    const why = submissionProblem(report, clock());
    if (why) throw new HttpError(422, why);
    const snap = snapshotOf(report);
    let out;
    try { out = await league.submit(snap.host, (prev) => applySubmission(prev, snap, clock())); } catch (e) {
      console.error('League submission failed', e);
      throw new HttpError(503, LEAGUE_UNAVAILABLE);
    }
    if (out.error === 'stale') throw new HttpError(409, out.message);
    if (out.error === 'frequency') throw new HttpError(409, out.message);
    if (out.error === 'suppressed') throw new HttpError(403, out.message);
    if (out.error === 'capacity') throw new HttpError(503, out.message);
    if (out.changed) invalidateLeagueSnapshot();
    return { ...out, host: snap.host, created: out.events.some((e) => e.type === 'joined') };
  }
  const joinJson = async (c, out, status) => {
    const entries = await leagueEntries();
    const e = entries.find((x) => x.host === out.host) || out.entry;
    return c.body(JSON.stringify({ status: out.duplicate ? 'unchanged' : out.created ? 'joined' : 'updated', host: out.host, gained_xp: out.gained || 0, events: out.events, standing: publicEntry(entries.some((x) => x.host === e.host) ? entries : [...entries, e], e), profile_url: `${baseOf(c)}/league/${encodeURIComponent(out.host)}` }), status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  };

  app.get('/api/league', async (c) => {
    const board = c.req.query('board') || 'top';
    if (!BOARD_IDS.includes(board)) return problem(c, 400, `Unknown board "${board}". Boards: ${BOARD_IDS.join(', ')}.`);
    const per = Math.max(1, Math.min(100, parseInt(c.req.query('limit'), 10) || PER_PAGE)); const page = pageOf(c.req.query('page'));
    const entries = await leagueEntries();
    const rows = rankBoard(entries, board, clock());
    return sendText(c, JSON.stringify({ board, boards: BOARD_IDS, ...leagueStats(entries), total: rows.length, page, per_page: per, rows: rows.slice((page - 1) * per, page * per).map((r) => ({ ...r, profile_url: `${baseOf(c)}/league/${encodeURIComponent(r.host)}` })) }), 'application/json', { 'cache-control': 'public, max-age=60', ...rlHeaders(c) });
  });
  app.get('/api/league/:host', async (c) => {
    const host = normalizeHost(c.req.param('host'));
    const entries = await leagueEntries();
    const e = entries.find((x) => x.host === host);
    if (!e) return problem(c, 404, `${host} has not joined the League. Scan it, then submit the report.`, { headers: rlHeaders(c) });
    return sendText(c, JSON.stringify(publicEntry(entries, e)), 'application/json', { 'cache-control': 'public, max-age=60', ...rlHeaders(c) });
  });
  app.post('/api/league', async (c) => {
    if (!joinAllowed(c)) return problem(c, 429, 'Too many League submissions from this client. Try again later.', { headers: { 'Retry-After': '3600' } });
    let body;
    try {
      const read = await readLimitedBody(c);
      if (read.tooLarge) return problem(c, 413, `The body is larger than ${maxBodyBytes} bytes.`);
      body = JSON.parse(read.text || '{}');
    } catch { return problem(c, 400, 'The body is not valid JSON. Send {"report_id": "..."} or {"url": "https://example.com"}.'); }
    try {
      let report = null;
      if (body && typeof body.report_id === 'string') {
        if (!ID_RE.test(body.report_id)) throw new HttpError(400, 'report_id is not a valid report id.');
        report = await storedReport(body.report_id);
        if (!report) throw new HttpError(404, 'No stored report with that id (reports are kept 30 days). Scan the site again.');
      } else if (body && typeof body.url === 'string') {
        report = (await runScan(c, body.url, { browser: body.browser === true })).report;
      } else throw new HttpError(400, 'Send {"report_id": "..."} from an earlier scan, or {"url": "https://example.com"} to scan and join in one call.');
      const out = await joinReport(report);
      return await joinJson(c, out, out.created ? 201 : 200);
    } catch (e) { return scanError(c, e); }
  });
  const adminOnly = (c) => {
    const token = leagueAdminToken;
    if (!token) return problem(c, 404, `Nothing at ${new URL(c.req.url).pathname}.`);
    const given = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    let diff = given.length ^ token.length;
    for (let i = 0; i < token.length; i++) diff |= (given.charCodeAt(i) || 0) ^ token.charCodeAt(i);
    return diff !== 0 ? problem(c, 401, 'A valid bearer token is required.', { headers: { 'WWW-Authenticate': 'Bearer' } }) : null;
  };
  // Removal leaves a tombstone: submissions cannot add the host again until an admin restores it.
  app.delete('/api/league/:host', async (c) => {
    const denied = adminOnly(c); if (denied) return denied;
    if (!(await league.remove(c.req.param('host')))) return problem(c, 404, 'That host is not on the board, or is already removed.');
    invalidateLeagueSnapshot();
    return c.body(null, 204);
  });
  app.post('/api/league/:host/restore', async (c) => {
    const denied = adminOnly(c); if (denied) return denied;
    if (!(await league.restore(c.req.param('host')))) return problem(c, 404, 'That host is not removed.');
    invalidateLeagueSnapshot();
    return c.body(null, 204);
  });
  app.all('/api/*', (c) => problem(c, 404, `No API operation at ${new URL(c.req.url).pathname}. See /openapi.json.`, { headers: rlHeaders(c) }));

  // ---- MCP
  app.on(['POST', 'GET', 'DELETE'], '/mcp', async (c) => {
    const len = Number(c.req.header('content-length') || 0);
    if (len > 65_536) return problem(c, 413, 'The JSON-RPC message is larger than 64 KB.');
    // A tool call's scan needs this request's base URL and client key, so the handler is built per request (it is stateless).
    const local = { url: c.req.url, headers: c.req.raw.headers, env: c.env };
    const handler = createMcpHandler({
      allowedOrigins,
      getReport: (id) => store.get(id),
      getLeague: async ({ board, host, limit }) => {
        const entries = await leagueEntries();
        if (host) {
          const e = entries.find((x) => x.host === normalizeHost(host));
          if (!e) return null;
          const d = publicEntry(entries, e);
          return { data: d, text: `${d.host}: score ${d.score}, ${d.division} division, #${d.ranks.top ?? '-'} of ${d.players} on the Top board, ${d.xp} XP, ${d.achievements.length} achievements, streak ${d.streak} weeks. Profile: ${baseOf(c)}/league/${encodeURIComponent(d.host)}` };
        }
        const rows = rankBoard(entries, board, clock()).slice(0, limit);
        return { data: { board, ...leagueStats(entries), rows }, text: [`${board} board, ${rows.length} of ${leagueStats(entries).players} sites:`, ...rows.map((r) => `#${r.rank} ${r.host}: score ${r.score}, ${r.division}, ${r.xp} XP`)].join('\n') };
      },
      scan: async (url, opts) => {
        const fake = { req: { url: local.url, header: (k) => local.headers.get(k) }, env: local.env, set: () => {}, get: () => undefined };
        try { return (await runScan(fake, url, opts)).report; } catch (e) { throw Object.assign(new Error(e.message), { status: e.status, retryAfter: e.retryAfter }); }
      },
    });
    const res = await handler(c.req.raw);
    return new Response(res.body, { status: res.status, headers: res.headers });
  });
  app.options('/mcp', (c) => c.body(null, 204, { allow: 'POST, OPTIONS' }));
  const card = (c) => JSON.stringify(files.serverCard(baseOf(c)), null, 2);
  app.get('/mcp/server-card', (c) => sendText(c, card(c), MCP_CARD_TYPE));

  // ---- agent files
  app.get('/robots.txt', (c) => sendText(c, files.robotsTxt(baseOf(c)), 'text/plain; charset=utf-8'));
  app.get('/llms.txt', (c) => sendText(c, files.llmsTxt(baseOf(c)), 'text/plain; charset=utf-8'));
  app.get('/llms-full.txt', (c) => sendText(c, files.llmsFullTxt(baseOf(c)), 'text/plain; charset=utf-8'));
  app.get('/sitemap.xml', (c) => sendText(c, files.sitemapXml(baseOf(c)), 'application/xml; charset=utf-8'));
  app.get('/openapi.json', (c) => sendText(c, JSON.stringify(files.openapi(baseOf(c)), null, 2), 'application/openapi+json'));
  app.get('/.well-known/openapi.json', (c) => c.redirect('/openapi.json', 301));
  app.get('/.well-known/api-catalog', (c) => sendText(c, JSON.stringify(files.apiCatalog(baseOf(c)), null, 2), LINKSET_TYPE));
  app.get('/.well-known/mcp/server-card.json', (c) => sendText(c, card(c), 'application/json'));
  app.get('/.well-known/mcp.json', (c) => sendText(c, card(c), 'application/json'));
  app.get('/.well-known/mcp/server-cards.json', (c) => sendText(c, JSON.stringify({ servers: [files.serverCard(baseOf(c))] }, null, 2), 'application/json'));
  app.get('/.well-known/agent-skills/index.json', async (c) => sendText(c, JSON.stringify(await files.agentSkillsIndex(baseOf(c)), null, 2), 'application/json'));
  app.get(`/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`, (c) => sendText(c, files.skillMd(baseOf(c)), MD));
  app.get('/.well-known/ard.json', (c) => sendText(c, JSON.stringify(files.ardManifest(baseOf(c)), null, 2), 'application/json'));
  app.get('/.well-known/security.txt', (c) => sendText(c, files.securityTxt(baseOf(c)), 'text/plain; charset=utf-8', { 'cache-control': 'public, max-age=86400' }));
  app.get('/.well-known/gpc.json', (c) => sendText(c, JSON.stringify(files.gpcJson()), 'application/json'));
  for (const [path, a] of Object.entries(R.ASSETS || {})) {
    // Binary assets (fonts) are stored base64-encoded; decode once to bytes (atob works in Node and Workers).
    const body = a.encoding === 'base64' ? Uint8Array.from(atob(a.body), (ch) => ch.charCodeAt(0)) : a.body;
    app.get(path, (c) => sendText(c, body, a.type, { 'cache-control': 'public, max-age=86400' }));
  }

  // ---- pages
  const homeLink = (base) => [
    '</.well-known/api-catalog>; rel="api-catalog"',
    `<${base}/openapi.json>; rel="service-desc"; type="application/openapi+json"`,
    '</docs>; rel="service-doc"; type="text/html"',
    '</llms.txt>; rel="describedby"; type="text/plain"',
    '</index.md>; rel="alternate"; type="text/markdown"',
    '</sitemap.xml>; rel="sitemap"; type="application/xml"',
    '</.well-known/ard.json>; rel="ard"; type="application/json"',
    '</mcp/server-card>; rel="mcp-server-card"; type="application/mcp-server-card+json"',
    '</privacy>; rel="privacy-policy"',
    '</terms>; rel="terms-of-service"',
  ].join(', ');
  const homeHtml = async (c) => {
    if (o.homeHtml) return o.homeHtml;
    if (assets) {
      const r = await assets('/index.html', c.req.raw).catch(() => null);
      if (r && r.ok) return r.text();
    }
    return R.renderHomeHtml({ baseUrl: baseOf(c), browserAvailable });
  };
  app.get('/', (c) => htmlOrMd(c, { html: () => homeHtml(c), md: () => files.homeMd(baseOf(c)), headers: { link: homeLink(baseOf(c)) } }));
  app.get('/index.html', (c) => c.redirect('/', 301));
  app.get('/index.md', (c) => sendText(c, files.homeMd(baseOf(c)), MD));
  const PAGE_GEN = { docs: files.docsMd, checks: files.checksMd, privacy: files.privacyMd, terms: files.termsMd };
  for (const p of files.PAGES.filter((x) => x.path !== '/' && PAGE_GEN[x.path.slice(1)])) { // /league is dynamic and has its own routes
    const name = p.path.slice(1);
    app.get(p.path, (c) => mdPage(c, p.path, PAGE_GEN[name](baseOf(c)), p.summary));
    app.get(`${p.path}.md`, (c) => sendText(c, PAGE_GEN[name](baseOf(c)), MD));
  }

  const errorPage = (c, status, detail) => {
    c.header('Vary', 'Accept');
    if (wantsMarkdown(c.req.header('accept'))) return c.body(`# ${STATUS_TITLES[status] || 'Error'}\n\n${detail}\n`, status, { 'content-type': MD });
    const title = STATUS_TITLES[status] || 'Error';
    const html = R.shell({ base: baseOf(c), path: new URL(c.req.url).pathname, title, description: detail, body: `<h1>${esc(title)}</h1>\n<p class="lead">${esc(detail)}</p>\n<p><a href="/">Scan another site</a></p>`, noindex: true });
    return c.body(html, status, { 'content-type': HTML, ...(status === 429 && c.get('rl') ? { 'Retry-After': String(c.get('rl').reset), ...rateLimitHeaders(c.get('rl')) } : {}) });
  };

  // ---- League pages
  const leagueView = async (c) => {
    const board = boardOf(c.req.query('board')); const page = pageOf(c.req.query('page'));
    const entries = await leagueEntries();
    const rows = rankBoard(entries, board, clock());
    return { board, page: Math.min(page, Math.max(1, Math.ceil(rows.length / PER_PAGE))), entries, rows, stats: leagueStats(entries), crowns: crownsOf(entries, clock()) };
  };
  app.get('/league', async (c) => {
    const v = await leagueView(c); const base = baseOf(c);
    const query = `board=${v.board}&page=${v.page}`;
    return htmlOrMd(c, { html: () => renderLeagueHtml({ removalUrl: leagueRemovalUrl, base, board: v.board, rows: v.rows, page: v.page, stats: v.stats, crowns: v.crowns, now: clock(), browserAvailable }), md: () => renderLeagueMarkdown({ removalUrl: leagueRemovalUrl, base, board: v.board, rows: v.rows, page: v.page, stats: v.stats, crowns: v.crowns }), headers: { 'cache-control': 'public, max-age=60', link: `</league.md?${query}>; rel="alternate"; type="text/markdown", </api/league?${query}&limit=${PER_PAGE}>; rel="alternate"; type="application/json"` } });
  });
  app.get('/league.md', async (c) => {
    const v = await leagueView(c);
    return sendText(c, renderLeagueMarkdown({ removalUrl: leagueRemovalUrl, base: baseOf(c), board: v.board, rows: v.rows, page: v.page, stats: v.stats, crowns: v.crowns }), MD, { 'cache-control': 'public, max-age=60' });
  });
  app.get('/league/join', (c) => c.redirect('/league', 302));
  app.post('/league/join', async (c) => {
    const origin = c.req.header('origin');
    if (origin && origin !== 'null' && new URL(origin).host !== new URL(baseOf(c)).host) return errorPage(c, 403, 'Submissions must come from this site.');
    if (!joinAllowed(c)) return errorPage(c, 429, 'Too many League submissions from this client. Try again in an hour.');
    let id = '';
    try {
      const read = await readLimitedBody(c);
      if (read.tooLarge) return errorPage(c, 413, 'The submission is too large.');
      id = /json/i.test(c.req.header('content-type') || '') ? String(JSON.parse(read.text || '{}').report_id || '') : String(new URLSearchParams(read.text).get('report_id') || '');
    } catch { return errorPage(c, 400, 'The submission could not be read.'); }
    if (!ID_RE.test(id)) return errorPage(c, 400, 'Submit a report from its report page (the Join button).');
    try {
      const report = await storedReport(id);
      if (!report) return errorPage(c, 404, 'That report does not exist or has expired. Scan the site again.');
      const out = await joinReport(report);
      return c.redirect(`/league/${encodeURIComponent(out.host)}?${out.created ? 'joined' : 'updated'}=1`, 303);
    } catch (e) { return errorPage(c, e?.status || 500, e?.message || 'Something went wrong on our side.'); }
  });
  app.get('/league/badge/:file', async (c) => {
    const f = c.req.param('file');
    if (!f.endsWith('.svg')) return problem(c, 404, 'League badges end in .svg, for example /league/badge/example.com.svg.');
    const host = normalizeHost(f.slice(0, -4));
    const entries = await leagueEntries();
    const st = standing(entries, host, clock());
    const svg = renderLeagueBadge(st && st.active && st.ranks.top ? { rank: st.ranks.top, total: st.total, division: divisionOf(st.entry.score).id, score: st.entry.score } : {});
    return c.body(svg, 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=600' });
  });
  app.get('/league/:host', async (c) => {
    const arrived = mono();
    let entries = await leagueEntries();
    const raw = c.req.param('host'); const rawHost = normalizeHost(raw); const suffix = raw.endsWith('.md');
    const literal = entries.find((e) => e.host === rawHost);
    const aliasHost = suffix ? normalizeHost(raw.slice(0, -3)) : rawHost;
    const alias = suffix ? entries.find((e) => e.host === aliasHost) : null;
    let host; let md;
    if (c.req.query('format') === 'markdown') {
      host = rawHost; md = true;
    } else if (suffix && literal && alias) {
      c.header('Vary', 'Accept');
      md = wantsMarkdown(c.req.header('accept'));
      host = md ? aliasHost : rawHost;
    } else if (literal) {
      host = rawHost;
      if (suffix) c.header('Vary', 'Accept');
      md = suffix ? wantsMarkdown(c.req.header('accept')) : false;
    } else {
      host = suffix ? aliasHost : rawHost;
      md = suffix;
    }
    // Right after a join this instance may still hold a snapshot from before the write: use standings loaded after this request.
    if (!md && (c.req.query('joined') || c.req.query('updated'))) entries = await leagueEntriesSince(arrived).catch(() => entries);
    const st = standing(entries, host, clock());
    if (!st) return errorPage(c, 404, `${host} has not joined the League yet. Scan it, then press Join on the report page.`);
    const base = baseOf(c);
    if (md) return sendText(c, renderProfileMarkdown({ base, st, removalUrl: leagueRemovalUrl, now: clock() }), MD, { 'cache-control': 'public, max-age=60' });
    const fresh = st.entry.submitted_at && clock() - Date.parse(st.entry.submitted_at) < 600_000;
    const banner = fresh ? (c.req.query('joined') ? 'joined' : c.req.query('updated') ? 'updated' : null) : null;
    const report = await store.get(st.entry.report_id).catch(() => null);
    return htmlOrMd(c, { html: () => renderProfileHtml({ removalUrl: leagueRemovalUrl, base, st, quests: report ? quests(report) : null, report, banner, now: clock() }), md: () => renderProfileMarkdown({ base, st, removalUrl: leagueRemovalUrl, now: clock() }), headers: { 'cache-control': banner ? 'no-store' : 'public, max-age=60', link: `</league/${encodeURIComponent(host)}?format=markdown>; rel="alternate"; type="text/markdown", </api/league/${encodeURIComponent(host)}>; rel="alternate"; type="application/json"` } });
  });

  app.get('/scan', async (c) => {
    const input = c.req.query('url');
    if (!input) return c.redirect('/', 302);
    let out;
    try { out = await runScan(c, input, { browser: c.req.query('browser') === 'true' }); } catch (e) {
      if (e?.status === 429) c.set('rl', e.rl);
      return errorPage(c, e?.status || 500, e?.message || String(e));
    }
    const base = baseOf(c);
    const r = out.report;
    c.header('Vary', 'Accept');
    c.header('Cache-Control', 'no-store');
    if (r.id) c.header('Content-Location', `/r/${r.id}`);
    for (const [k, v] of Object.entries(rlHeaders(c))) c.header(k, v);
    if (wantsMarkdown(c.req.header('accept'))) return c.body(R.renderReportMarkdown(r, { baseUrl: base, reportId: r.id }), 200, { 'content-type': MD });
    return c.body(R.renderReportHtml(r, { baseUrl: base, reportId: r.id, filter: R.parseFilter ? R.parseFilter(new URL(c.req.url).searchParams) : undefined, browserAvailable, league: await panelFor(r) }), 200, { 'content-type': HTML });
  });

  app.get('/r/:id', async (c) => {
    const id = c.req.param('id').replace(/\.(md|json)$/, '');
    const r = await store.get(id).catch(() => null);
    if (!r) return errorPage(c, 404, 'This report does not exist or has expired (reports are kept 30 days).');
    const base = baseOf(c);
    const report = { ...r, report_url: `${base}/r/${r.id}` };
    if (c.req.param('id').endsWith('.json')) return c.json(report);
    if (c.req.param('id').endsWith('.md')) return sendText(c, R.renderReportMarkdown(report, { baseUrl: base, reportId: r.id }), MD, { 'cache-control': 'public, max-age=3600' });
    return htmlOrMd(c, { html: async () => R.renderReportHtml(report, { baseUrl: base, reportId: r.id, filter: R.parseFilter ? R.parseFilter(new URL(c.req.url).searchParams) : undefined, browserAvailable, league: await panelFor(report) }), md: () => R.renderReportMarkdown(report, { baseUrl: base, reportId: r.id }), headers: { 'cache-control': 'public, max-age=3600', link: `</r/${r.id}.md>; rel="alternate"; type="text/markdown", </api/reports/${r.id}>; rel="alternate"; type="application/json"` }, htmlHeaders: { 'cache-control': 'no-cache' } });
  });

  const badge = async (c, host) => {
    const r = host ? await store.latestForHost(host).catch(() => null) : null;
    const svg = R.renderBadge({ score: r ? r.score : null, level: r ? r.compat?.isitagentready?.level : null, label: 'ai-native' });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=600' });
  };
  app.get('/badge/:file', (c) => {
    const f = c.req.param('file');
    if (!f.endsWith('.svg')) return problem(c, 404, 'Badges end in .svg, for example /badge/example.com.svg.');
    return badge(c, f.slice(0, -4).toLowerCase());
  });
  app.get('/badge', (c) => {
    const input = c.req.query('url');
    if (!input) return problem(c, 400, 'The url query parameter is required.');
    let u; try { u = normalizeUrl(input); } catch (e) { return problem(c, 400, e.message); }
    return badge(c, u.host.toLowerCase());
  });

  // ---- static assets (public/) and 404
  app.get('*', async (c, next) => {
    if (!assets) return next();
    const path = new URL(c.req.url).pathname;
    if (path.includes('..')) return next();
    const r = await assets(path, c.req.raw).catch(() => null);
    if (r && r.ok) return new Response(r.body, { status: r.status, headers: r.headers });
    return next();
  });
  app.notFound((c) => {
    const accept = c.req.header('accept') || '';
    if (/text\/html/.test(accept) || wantsMarkdown(accept)) return errorPage(c, 404, `Nothing at ${new URL(c.req.url).pathname}.`);
    return problem(c, 404, `Nothing at ${new URL(c.req.url).pathname}.`);
  });
  app.onError((e, c) => {
    console.error(e);
    return problem(c, 500, 'Something went wrong on our side.');
  });
  return app;
}

export { esc };
