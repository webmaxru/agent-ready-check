// League pages: the leaderboard, a site's profile, the panel on a report page, the rank badge and Markdown versions.
// Runtime-neutral, no inline scripts or styles (the CSP allows only 'self'). Every host name goes through esc().
import { esc } from '../report/util.mjs';
import { shell, pixelSvg, scanForm } from '../report/html.mjs';
import { LEVEL_NAMES } from '../core/score.mjs';
import catalog from '../catalog.json' with { type: 'json' };
import {
  BOARDS, BOARD_IDS, DIVISIONS, ACHIEVEMENTS, ACHIEVEMENT_BY_ID, XP, DORMANT_MS,
  divisionOf, nextDivision, playerLevel, weekOf, isActive, reportHost,
} from './engine.mjs';

export const LEAGUE_ASSET_VERSION = '1';
export const PER_PAGE = 25;
/** Where owners ask for removal. github.com/vibeprogrammer/agent-ready-check redirects to this repository; deployments can set LEAGUE_REMOVAL_URL. */
export const DEFAULT_REMOVAL_URL = 'https://github.com/webmaxru/agent-ready-check/issues/new';
const LAYER_NAME = Object.fromEntries(catalog.layers.map((l) => [l.id, l.name]));
const layerName = (id) => LAYER_NAME[id] || id;

/** n pixel steps rising to the right, like the level ladder. */
const stairs = (n) => Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x) => ((6 - y) < Math.round(((Math.floor((x * n) / 7) + 1) / n) * 7) ? '#' : '.')).join(''));
const GLYPHS = {
  star: ['...#...', '...#...', '.#####.', '#######', '.#####.', '.##.##.', '.#...#.'],
  bars: ['.......', '.....##', '.....##', '..##.##', '..##.##', '#.##.##', '#.##.##'],
  crown: ['#..#..#', '##.#.##', '#######', '#######', '#######', '.#####.', '.......'],
  shield: ['#######', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  gem: ['.#####.', '#######', '#######', '.#####.', '..###..', '...#...', '.......'],
  ring: ['..###..', '.#...#.', '#.....#', '#.....#', '#.....#', '.#...#.', '..###..'],
  bot: ['..#.#..', '.#####.', '#.###.#', '#######', '#.#.#.#', '.#####.', '.#...#.'],
  doc: ['.####..', '.#..##.', '.#..###', '.#....#', '.#....#', '.#....#', '.#####.'],
  sign: ['.#####.', '.#####.', '..###..', '...#...', '...#...', '...#...', '..###..'],
  plug: ['.#.#...', '.#.#...', '#####..', '#####..', '.###...', '..#....', '..#....'],
  wand: ['....#.#', '.....#.', '...#.#.', '..#....', '.#.....', '#......', '.......'],
  lock: ['..###..', '.#...#.', '.#...#.', '#######', '#######', '###.###', '#######'],
  eye: ['.......', '..###..', '.#####.', '##.#.##', '.#####.', '..###..', '.......'],
  step3: stairs(3), step4: stairs(4), step5: stairs(5),
  up: ['...#...', '..###..', '.#####.', '#######', '..###..', '..###..', '..###..'],
  rocket: ['...#...', '..###..', '..###..', '..###..', '.#####.', '.#.#.#.', '...#...'],
  flame: ['...#...', '..##...', '..###..', '.####.#', '.#####.', '.#####.', '..###..'],
  flame2: ['..#.#..', '..###..', '.#####.', '#######', '#######', '.#####.', '..###..'],
  lockq: ['..###..', '.#...#.', '.....#.', '...##..', '..#....', '.......', '..#....'],
  trophy: ['#######', '#.###.#', '#.###.#', '.#####.', '..###..', '...#...', '..###..'],
};
const glyph = (name, size = 28, cls = 'px') => pixelSvg(GLYPHS[name] || GLYPHS.star, { size, cls });
const blocks = (n, on, cls = '') => `<span class="blocks${cls ? ` ${cls}` : ''}" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<span${i < on ? ' class="on"' : ''}></span>`).join('')}</span>`;

export const divisionChip = (id) => { const d = DIVISIONS.find((x) => x.id === id) || DIVISIONS[4]; return `<span class="div div-${esc(d.id)}">${esc(d.name)}</span>`; };
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const ago = (iso, now) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 3600) return 'just now';
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};
const hostUrl = (h) => `/league/${encodeURIComponent(h)}`;

function copyBlock(id, label, text) {
  return `<div class="copyable"><div class="copyhead"><span class="small">${esc(label)}</span><button type="button" class="copy" data-copy="${esc(id)}" hidden>Copy</button></div><pre id="${esc(id)}"><code>${esc(text)}</code></pre></div>`;
}

// ---- the leaderboard --------------------------------------------------------------------------------------------

function podium(rows) {
  if (rows.length < 3) return '';
  const slot = (r, cls) => `<li class="slot ${cls}"><a class="who" href="${hostUrl(r.host)}">${esc(r.host)}</a>${divisionChip(r.division)}<span class="pts">${esc(r.score)}</span><span class="step"><span class="n">${r.rank}</span></span></li>`;
  return `<ol class="podium" aria-label="Top three">${slot(rows[1], 'p2')}${slot(rows[0], 'p1')}${slot(rows[2], 'p3')}</ol>`;
}

function boardTable(rows, board, offset, now) {
  const metric = BOARDS[board].metric;
  const head = `<tr><th scope="col" class="rk">Rank</th><th scope="col">Site</th><th scope="col">Division</th><th scope="col" class="num${board === 'top' || board === 'fresh' ? ' key' : ''}">Score</th><th scope="col" class="num opt${board === 'climbers' ? ' key' : ''}">Gain 30d</th><th scope="col" class="opt">Level</th><th scope="col" class="num${board === 'grinders' ? ' key' : ' opt'}">XP</th><th scope="col" class="num opt">Streak</th><th scope="col" class="num opt">Badges</th></tr>`;
  const body = rows.map((r) => `<tr${r.rank <= 3 && board === 'top' ? ` class="top${r.rank}"` : ''}><th scope="row" class="rk">${r.rank}</th><td class="site"><a href="${hostUrl(r.host)}">${esc(r.host)}</a><span class="small">${esc(ago(r.updated_at, now))}</span></td><td>${divisionChip(r.division)}</td><td class="num key-${board === 'top' || board === 'fresh' ? 'on' : 'off'}">${esc(r.score)}${blocks(5, Math.round(r.score / 20), 'tiny')}</td><td class="num opt${r.gain > 0 ? ' up' : ''}${board === 'climbers' ? ' key' : ''}">${r.gain > 0 ? `+${esc(r.gain)}` : r.gain < 0 ? `${esc(r.gain)}` : '0'}</td><td class="opt"><span class="lvl" title="${esc(r.level_name)}">L${esc(r.level)}</span></td><td class="num${board === 'grinders' ? ' key' : ' opt'}">${fmt(r.xp)} <span class="small">Lv ${esc(r.player_level)}</span></td><td class="num opt">${r.streak > 1 ? `${glyph('flame', 14)} ${esc(r.streak)}w` : '<span class="muted">0</span>'}</td><td class="num opt">${esc(r.achievements)}<span class="small">/${ACHIEVEMENTS.length}</span></td></tr>`).join('');
  return `<div class="tablewrap"><table class="league"><caption class="vh">${esc(BOARDS[board].name)} board, ranked by ${esc(metric.toLowerCase())}. Showing ranks ${offset + 1} to ${offset + rows.length}.</caption><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function rulesHtml(removalUrl = DEFAULT_REMOVAL_URL) {
  const divs = DIVISIONS.map((d) => `<li>${divisionChip(d.id)} <span>${d.min === 0 ? 'under 40' : `${d.min} and up`}</span></li>`).join('');
  const ach = ACHIEVEMENTS.map((a) => `<li><span class="tile">${glyph(a.glyph, 20)}</span><span><b>${esc(a.name)}</b> <span class="xpn">+${a.xp} XP</span><br><span class="small">${esc(a.how)}</span></span></li>`).join('');
  return `<section class="band" id="rules" aria-labelledby="rules-h"><h2 id="rules-h" class="sh">How the game works</h2>
<div class="twocol rules">
<div>
<h3>The board never lies</h3>
<p>You join with a report this service made, never a score you typed. Your standing is always your latest submitted report, so a regression shows and nobody sits on a stale high. Standings that are not re-scanned for ${DORMANT_MS / 86_400_000} days drop off the boards.</p>
<h3 id="removal">Community rankings and removal</h3>
<p>Rankings are community-submitted: anyone can add a public site from a scan this service ran, so a listing does not mean the site's owner took part, checked it or agrees with it. Nothing here is ownership verification or an endorsement. If you run a listed site and want it off the board, <a href="${esc(removalUrl)}">open an issue</a> with the host name; a maintainer removes it. Owner-verified self-service opt-out is planned.</p>
<h3>XP rewards effort</h3>
<ul class="plain">
<li><b>+${XP.join} XP</b> for joining.</li>
<li><b>+${XP.perPoint} XP</b> for every point above your own best score, so a site that starts at 20 can out-grind one that starts at 80.</li>
<li><b>+${XP.perLevel} XP</b> for every isitagentready-compatible level above your best.</li>
<li><b>+${XP.streakStep} XP x streak</b> (up to ${XP.streakCap}) when you re-scan in consecutive weeks.</li>
<li>XP for achievements, below. Dropping and re-climbing earns nothing twice.</li>
</ul>
<h3>Divisions</h3>
<ul class="divs">${divs}</ul>
</div>
<div>
<h3>${ACHIEVEMENTS.length} achievements</h3>
<ul class="achlist">${ach}</ul>
</div>
</div>
</section>`;
}

/**
 * The /league page.
 * @param {{ base:string, board:string, rows:object[], page:number, stats:object, crowns:object[], now:number, browserAvailable?:boolean }} o
 */
export function renderLeagueHtml({ base, board = 'top', rows, page = 1, stats, crowns = [], now = Date.now(), browserAvailable = false, removalUrl = DEFAULT_REMOVAL_URL }) {
  const b = BOARD_IDS.includes(board) ? board : 'top';
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const pg = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((pg - 1) * PER_PAGE, pg * PER_PAGE);
  const tabs = `<nav class="tabs" aria-label="Boards">${BOARD_IDS.map((id) => `<a href="/league${id === 'top' ? '' : `?board=${id}`}"${id === b ? ' aria-current="page"' : ''}>${esc(BOARDS[id].name)}</a>`).join('')}</nav>`;
  const empty = {
    top: 'Nobody has joined yet. The first score on the board sets the bar.',
    climbers: 'No climbers yet. Fix something, re-scan, and your gain shows up here.',
    grinders: 'No XP earned yet.',
    fresh: 'Nobody joined in the last 14 days.',
  }[b];
  const nav = pages > 1 ? `<nav class="pager" aria-label="Pages">${pg > 1 ? `<a class="btn quiet" href="/league?board=${b}&amp;page=${pg - 1}">Previous</a>` : ''}<span class="small">Page ${pg} of ${pages}</span>${pg < pages ? `<a class="btn quiet" href="/league?board=${b}&amp;page=${pg + 1}">Next</a>` : ''}</nav>` : '';
  const spot = catalog.layers[weekOf(now) % catalog.layers.length];
  const crownCards = crowns.sort((x, y) => catalog.layers.findIndex((l) => l.id === x.layer) - catalog.layers.findIndex((l) => l.id === y.layer))
    .map((c) => `<li><span class="crown">${glyph('crown', 16)}</span><span class="cl">${esc(layerName(c.layer))}</span><a href="${hostUrl(c.host)}">${esc(c.host)}</a><span class="cs">${esc(c.score)}</span></li>`).join('');
  const statCells = [['Players', fmt(stats.players)], ['Average score', stats.players ? stats.average : '–'], ['Top score', stats.players ? stats.top : '–'], ['Achievements won', fmt(stats.achievements)]]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const body = `<section class="lhero" aria-labelledby="league-h">
<div>
<p class="kicker">${glyph('trophy', 16)} Agent-Ready League</p>
<h1 id="league-h">Fix it. Scan it. Climb the board.</h1>
<p class="lead">Every site that joins gets a rank, a division, XP and achievements. Gain points by fixing real findings, keep a weekly streak, and see who is the most agent-ready on the web.</p>
${scanForm({ browserAvailable, id: 'league-scan', tool: false })}
<p class="small">You scan first, then join from the report. Joining lists the host name, score, level and score history publicly. Rankings are community-submitted: anyone can add a public site from a scan this service ran, so a listing does not mean the site's owner took part, checked it or agrees with it. Owners can <a href="#removal">ask for removal</a>. <a href="#rules">How the game works</a>.</p>
</div>
<dl class="stats" aria-label="League stats">${statCells}</dl>
</section>
<section aria-labelledby="board-h">
<h2 id="board-h" class="sh">Leaderboard</h2>
${tabs}
<p class="small boardblurb">${esc(BOARDS[b].blurb)}</p>
${b === 'top' && pg === 1 ? podium(rows) : ''}
${slice.length ? boardTable(slice, b, (pg - 1) * PER_PAGE, now) : `<p class="empty">${esc(empty)}</p>`}
${nav}
</section>
<section class="band" aria-labelledby="crowns-h">
<h2 id="crowns-h" class="sh">Layer crowns</h2>
<p class="spot"><span class="chip-spot">Layer of the week</span> <b>${esc(spot.name)}</b>: ${esc(spot.summary)}. ${crowns.find((c) => c.layer === spot.id) ? `The crown is held by <a href="${hostUrl(crowns.find((c) => c.layer === spot.id).host)}">${esc(crowns.find((c) => c.layer === spot.id).host)}</a>.` : 'Nobody holds this crown yet.'}</p>
${crownCards ? `<ul class="crowns">${crownCards}</ul>` : '<p class="empty">Crowns appear when the first sites join.</p>'}
<p class="small">The best score in each layer wears its crown. Ties go to the higher overall score.</p>
</section>
${rulesHtml(removalUrl)}`;
  return shell({
    base, path: '/league', title: 'Agent-Ready League', mdPath: '/league.md',
    description: `The most agent-ready websites, ranked. ${stats.players} ${stats.players === 1 ? 'site has' : 'sites have'} joined. Scan yours, join, fix findings to climb, and win achievements.`,
    head: `<script type="module" src="/assets/league.js?v=${LEAGUE_ASSET_VERSION}"></script>\n`,
    body,
    jsonld: { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Agent-Ready League', itemListOrder: 'https://schema.org/ItemListOrderDescending', numberOfItems: rows.length, itemListElement: slice.slice(0, 10).map((r, i) => ({ '@type': 'ListItem', position: (pg - 1) * PER_PAGE + i + 1, name: r.host, url: `${String(base || '').replace(/\/+$/, '')}${hostUrl(r.host)}` })) },
  });
}

// ---- quests (used on the profile and on the report page) ---------------------------------------------------------

export function questsHtml(q, { reportHref = '' } = {}) {
  if (!q || !q.quests.length) return '<p class="empty">No fixable findings. Nothing left to quest for on this report.</p>';
  const items = q.quests.map((x) => `<li><span class="gain">+${esc(x.gain)}</span><span class="qt"><a href="${esc(reportHref)}#check-${esc(x.id)}">${esc(x.title)}</a><span class="small">${esc(layerName(x.layer))}, ${x.status === 'fail' ? 'failing' : 'warning'}${x.hint ? `. ${esc(x.hint)}` : ''}</span></span></li>`).join('');
  return `<ol class="quests">${items}</ol><p class="small">Points are what your 0-100 score would gain if that finding passed. The top three together are worth about ${esc(q.top3_gain)}, which would make it ${esc(q.projected_score)}.</p>`;
}

// ---- profile -----------------------------------------------------------------------------------------------------

function historyChart(history) {
  const h = history.slice(-30);
  if (h.length < 2) return '<p class="small">One scan so far. Re-scan after a fix to start a score history.</p>';
  const W = 640; const H = 200; const L = 34; const B = 24; const T = 18; const R = 8;
  const ph = H - B - T; const bw = (W - L - R) / h.length;
  const y = (v) => T + ph - (v / 100) * ph;
  const grid = [0, 50, 100].map((v) => `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="${v === 0 ? '#1e162b' : '#b6bfb8'}" stroke-width="1"${v === 0 ? '' : ' stroke-dasharray="3 3"'}/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#58635b">${v}</text>`).join('');
  const bars = h.map((p, i) => {
    const bh = Math.max(2, (p.score / 100) * ph);
    const fill = p.score >= 70 ? '#08872b' : p.score >= 40 ? '#7e6c07' : '#da0950';
    const showVal = h.length <= 12 || i === h.length - 1;
    return `<rect x="${(L + i * bw + 2).toFixed(1)}" y="${(T + ph - bh).toFixed(1)}" width="${Math.max(2, bw - 4).toFixed(1)}" height="${bh.toFixed(1)}" fill="${fill}"><title>${esc(p.at.slice(0, 10))}: ${esc(p.score)}</title></rect>${showVal ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${(T + ph - bh - 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e162b">${esc(p.score)}</text>` : ''}`;
  }).join('');
  const dates = `<text x="${L}" y="${H - 6}" font-size="11" fill="#58635b">${esc(h[0].at.slice(0, 10))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="#58635b">${esc(h[h.length - 1].at.slice(0, 10))}</text>`;
  const label = `Score history, oldest to newest: ${h.map((p) => p.score).join(', ')}`;
  const first = h[0].score; const last = h[h.length - 1].score; const best = Math.max(...h.map((p) => p.score));
  return `<figure class="histfig"><svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges">${grid}${bars}${dates}</svg><figcaption class="small">Score per scan, from ${esc(first)} to ${esc(last)} (${last >= first ? '+' : ''}${esc(last - first)}); best ${esc(best)}. ${esc(h.length)} scans.</figcaption></figure>`;
}

function eventLines(events) {
  const label = (e) => {
    switch (e.type) {
      case 'joined': return ['star', 'Welcome to the League'];
      case 'score_up': return ['up', `Score up ${e.points} point${e.points === 1 ? '' : 's'} above your best`];
      case 'score_down': return ['lockq', `Score down ${e.points} point${e.points === 1 ? '' : 's'} since last time. No XP lost.`];
      case 'rescan': return ['eye', 'Re-scanned, same score. Streak kept alive.'];
      case 'level_up': return ['step4', `Level up: L${e.from} to L${e.to}`];
      case 'streak': return ['flame', `${e.weeks}-week streak`];
      case 'achievement': return [ACHIEVEMENT_BY_ID[e.id]?.glyph || 'star', `Achievement unlocked: ${e.name}`];
      default: return ['star', e.type];
    }
  };
  return `<ul class="events">${events.map((e) => { const [g, t] = label(e); return `<li class="ev ev-${esc(e.type)}"><span class="tile">${glyph(g, 20)}</span><span>${esc(t)}</span>${e.xp ? `<b class="xpn">+${esc(e.xp)} XP</b>` : ''}</li>`; }).join('')}</ul>`;
}

/**
 * A site's profile page.
 * @param {{ base:string, st:object, quests?:object|null, report?:object|null, banner?:'joined'|'updated'|null, now:number }} o
 */
export function renderProfileHtml({ base, st, quests = null, banner = null, now = Date.now(), removalUrl = DEFAULT_REMOVAL_URL }) {
  const e = st.entry; const host = e.host;
  const pl = playerLevel(e.xp);
  const div = divisionOf(e.score); const nd = nextDivision(e.score);
  const active = st.active;
  const b = String(base || '').replace(/\/+$/, '');
  const share = `${b}${hostUrl(host)}`;
  const rankText = st.ranks.top ? `#${st.ranks.top} of ${st.total}` : 'unranked';
  const shareText = `${host} is ${rankText} on the Agent-Ready League: ${e.score}/100, ${div.name} division. Can your site beat it?`;
  const xShare = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(share)}`;
  const embed = `[![Agent-Ready League](${b}/league/badge/${host}.svg)](${share})`;
  const unlocked = ACHIEVEMENTS.filter((a) => e.achievements[a.id]);
  const grid = ACHIEVEMENTS.map((a) => (e.achievements[a.id]
    ? `<li class="ach on"><span class="tile">${glyph(a.glyph, 28)}</span><b>${esc(a.name)}</b><span class="small">${esc(a.how)}</span><span class="xpn">+${a.xp} XP, ${esc(e.achievements[a.id].slice(0, 10))}</span></li>`
    : `<li class="ach off"><span class="tile">${glyph('lockq', 28)}</span><b>${esc(a.name)}</b><span class="small">${esc(a.how)}</span><span class="xpn">+${a.xp} XP</span></li>`)).join('');
  const crowns = st.crowns.length ? `<p class="crownline">${glyph('crown', 18)} Holds the crown for <b>${st.crowns.map((c) => esc(layerName(c))).join(', ')}</b></p>` : '';
  const layerRows = Object.entries(e.layers || {}).sort((x, y) => y[1] - x[1]).map(([id, s]) => `<li><span>${esc(layerName(id))}</span>${blocks(10, Math.round(s / 10), s >= 70 ? 'good' : s >= 40 ? 'mid' : 'bad')}<b>${esc(s)}</b></li>`).join('');
  const rankCell = (id, label) => `<li><span class="small">${esc(label)}</span><b>${st.ranks[id] ? `#${st.ranks[id]}` : '-'}</b></li>`;
  const streakNow = e.streak_week != null && weekOf(now) - e.streak_week <= 1 ? e.streak : 0;
  const bannerHtml = banner ? `<section class="cele" data-celebrate role="status" aria-labelledby="cele-h"><h2 id="cele-h">${banner === 'joined' ? `${esc(host)} is on the board` : 'Standing updated'}</h2><p class="gainline"><span class="big">+<span data-count="${esc(e.last_gain || 0)}">${esc(e.last_gain || 0)}</span></span> XP</p>${eventLines(e.last_events || [])}</section>` : '';
  const stale = !active ? `<p class="notice">This standing is dormant: no re-scan for ${DORMANT_MS / 86_400_000} days, so it is off the boards. <a href="/scan?url=${esc(encodeURIComponent(host))}">Scan again</a> to come back.</p>` : '';
  const questBlock = quests
    ? `<section class="band" aria-labelledby="q-h"><h2 id="q-h" class="sh">Next quests</h2>${questsHtml(quests, { reportHref: `/r/${e.report_id}` })}</section>`
    : `<section class="band" aria-labelledby="q-h"><h2 id="q-h" class="sh">Next quests</h2><p>The report behind this score has expired (reports are kept 30 days). <a href="/scan?url=${esc(encodeURIComponent(host))}">Scan again</a> to see the fixes worth the most points.</p></section>`;
  const body = `${bannerHtml}${stale}
<section class="rhead" aria-labelledby="p-h">
<div class="console profile">
<div>
<h1 id="p-h"><span class="host">${esc(host)}</span></h1>
<p class="small">Joined ${esc(e.joined_at.slice(0, 10))} · last scan ${esc(ago(e.updated_at, now))}</p>
<div class="score band-${e.score >= 70 ? 'good' : e.score >= 40 ? 'mid' : 'bad'}" role="img" aria-label="Score ${esc(e.score)} out of 100"><span class="num">${esc(e.score)}</span><span class="of">/100</span></div>
<p class="grade">${divisionChip(div.id)} <span class="lvl dark" title="${esc(LEVEL_NAMES[e.level] || '')}">L${esc(e.level)} ${esc(LEVEL_NAMES[e.level] || '')}</span></p>
${nd ? `<p class="small">${esc(nd.points)} point${nd.points === 1 ? '' : 's'} to ${esc(nd.name)}. Best score so far: ${esc(e.best_score)}.</p>` : `<p class="small">Top division. Best score so far: ${esc(e.best_score)}.</p>`}
${crowns}
</div>
<div>
<h2>Player level ${esc(pl.level)}</h2>
<p class="xpline"><b data-count="${esc(e.xp)}">${fmt(e.xp)}</b> XP${blocks(20, Math.round(pl.pct / 5), 'xp')}<span class="small">${esc(pl.span - pl.into)} XP to level ${pl.level + 1}</span></p>
<ul class="ranks" aria-label="Ranks">${rankCell('top', 'Top')}${rankCell('climbers', 'Climbers')}${rankCell('grinders', 'Grinders')}${rankCell('fresh', 'Fresh')}<li><span class="small">Streak</span><b>${streakNow > 1 ? `${esc(streakNow)}w` : '-'}</b></li></ul>
<div class="actions"><a class="btn" href="/scan?url=${esc(encodeURIComponent(host))}">Re-scan and climb</a><a class="btn quiet" href="${esc(xShare)}" rel="noopener">Share on X</a></div>
</div>
</div>
</section>
<section class="band" aria-labelledby="hist-h"><h2 id="hist-h" class="sh">Score history</h2>${historyChart(e.history || [])}</section>
${questBlock}
<section class="band" aria-labelledby="ach-h"><h2 id="ach-h" class="sh">Achievements ${unlocked.length}/${ACHIEVEMENTS.length}</h2><ul class="achgrid">${grid}</ul></section>
<section class="band" aria-labelledby="ly-h"><h2 id="ly-h" class="sh">Layers</h2><ul class="layerbars">${layerRows}</ul></section>
<section class="band" aria-labelledby="emb-h"><h2 id="emb-h" class="sh">Show it off</h2>
<p><img src="/league/badge/${esc(encodeURIComponent(host))}.svg" alt="League badge for ${esc(host)}" width="${badgeW(st)}" height="20"></p>
${copyBlock('embed-md', 'Badge Markdown', embed)}
<p class="small">The badge updates as your rank changes. It never starts a scan.</p></section>
<p class="small">Community-submitted listing: anyone can add a public site, and the site's owner has not verified it. <a href="${esc(removalUrl)}">Ask for removal</a>.</p>`;
  return shell({
    base, path: hostUrl(host), title: `${host} on the Agent-Ready League`, mdPath: `${hostUrl(host)}?format=markdown`, noindex: !active,
    description: `${host} is ${rankText} on the Agent-Ready League with ${e.score}/100 (${div.name} division, level ${e.level}), ${fmt(e.xp)} XP and ${unlocked.length} achievements.`,
    head: `<script type="module" src="/assets/league.js?v=${LEAGUE_ASSET_VERSION}"></script>\n`, body,
  });
}

// ---- the panel on a report page ------------------------------------------------------------------------------------

/**
 * @param {{ report:object, ctx:{ entry:object|null, rank:object|null, projected:object, quests:object, teaser:string[], newer:boolean, older:boolean, total:number } }} o
 */
export function leaguePanel({ report, ctx }) {
  const { entry, quests: q } = ctx;
  const score = Math.round(report.score);
  const div = divisionOf(score);
  let head; let action; let note = '';
  if (!entry) {
    head = ctx.suppressed
      ? `<p class="lp-lead"><b>${esc(reportHost(report))}</b> was removed from the League.</p>`
      : ctx.joinProblem
        ? `<p class="lp-lead">This report cannot join the League.</p>`
        : `<p class="lp-lead">This score would put <b>${esc(reportHost(report))}</b> at <b>#${esc(ctx.projected.rank)}</b> of ${esc(ctx.projected.of)} in the ${divisionChip(div.id)} division.</p>`;
    const teaser = ctx.teaser.map((id) => `<li><span class="tile">${glyph(ACHIEVEMENT_BY_ID[id].glyph, 16)}</span>${esc(ACHIEVEMENT_BY_ID[id].name)} <span class="xpn">+${ACHIEVEMENT_BY_ID[id].xp}</span></li>`).join('');
    action = ctx.suppressed
      ? '<p class="small">This site cannot rejoin through a submission. <a href="/league#removal">Removal information</a>.</p>'
      : ctx.joinProblem
        ? `<p class="small">${esc(ctx.joinProblem)}</p>`
        : `<form class="join" method="post" action="/league/join"><input type="hidden" name="report_id" value="${esc(report.id)}"><button type="submit">Join the League</button></form>`;
    note = ctx.joinProblem || ctx.suppressed
      ? `<p class="small">League standings are community-submitted and are not verified by the site's owner. <a href="/league#removal">Removal information</a>.</p>`
      : `<p class="small">Joining earns ${XP.join} XP${ctx.teaser.length ? ` and unlocks ${ctx.teaser.length} achievement${ctx.teaser.length === 1 ? '' : 's'} right away` : ''}. It lists the host name, score, level and score history publicly, as a community-submitted ranking that the site's owner has not verified. <a href="/league#removal">Removal</a> and <a href="/league#rules">how the game works</a>.</p>${teaser ? `<ul class="teaser">${teaser}</ul>` : ''}`;
  } else if (entry.report_id === report.id) {
    head = `<p class="lp-lead">This is the report behind your standing: <b>#${esc(ctx.rank?.top ?? '-')}</b> of ${esc(ctx.total)}, ${divisionChip(divisionOf(entry.score).id)}, ${esc(entry.xp)} XP.</p>`;
    action = `<a class="btn" href="/league/${encodeURIComponent(entry.host)}">Open your profile</a>`;
    note = '<p class="small">Fix the quests below, scan again and submit the new report to climb. A re-scan every week builds a streak.</p>';
  } else if (ctx.newer) {
    const d = score - entry.score;
    head = `<p class="lp-lead">Your standing is ${esc(entry.score)}. This newer report scores <b>${esc(score)}</b>${d ? ` (${d > 0 ? '+' : ''}${esc(d)})` : ''}. Submit it to update the board.</p>`;
    action = ctx.joinProblem
      ? `<p class="small">${esc(ctx.joinProblem)}</p>`
      : `<form class="join" method="post" action="/league/join"><input type="hidden" name="report_id" value="${esc(report.id)}"><button type="submit">Update my standing</button></form>`;
    note = ctx.joinProblem ? '' : `<p class="small">${score > entry.best_score ? `Beats your best: +${XP.perPoint} XP for each point above ${esc(entry.best_score)}.` : 'No XP for points you already earned, but re-scanning keeps your streak alive.'}</p>`;
  } else {
    head = '<p class="lp-lead">A newer report for this site is already on the board.</p>';
    action = `<a class="btn" href="/league/${encodeURIComponent(entry.host)}">Open the profile</a>`;
  }
  return `<section class="band league-panel" id="league" aria-labelledby="lp-h">
<h2 id="lp-h" class="sh">Agent-Ready League</h2>
<div class="lp-grid">
<div class="lp-main">${head}${action}${note}</div>
<div class="lp-quests"><h3>Next quests</h3>${questsHtml(q, { reportHref: '' })}</div>
</div>
</section>`;
}

function badgeW(st) { return Math.max(150, 60 + `#${st.ranks.top ?? '-'} · ${divisionOf(st.entry.score).name}`.length * 7 + 60); }

// ---- badge ---------------------------------------------------------------------------------------------------------

const DIV_COLOR = { bronze: '#c05200', silver: '#58635b', gold: '#7e6c07', platinum: '#046ece', diamond: '#0d6731' };
const charW = (s) => Math.round([...String(s)].reduce((w, ch) => w + (/[il.,:|!']/.test(ch) ? 3.6 : /[mwMW@]/.test(ch) ? 9.5 : /[A-Z0-9#]/.test(ch) ? 7.4 : 6.4), 0)) + 12;

/** SVG badge: "agent-ready league | #7 · Gold". Square, flat, accessible. */
export function renderLeagueBadge({ rank = null, total = null, division = null, score = null } = {}) {
  const label = 'agent-ready league';
  const listed = rank != null && division;
  const value = listed ? `#${rank} · ${DIVISIONS.find((d) => d.id === division)?.name || division}${score != null ? ` · ${score}` : ''}` : 'not listed';
  const color = listed ? DIV_COLOR[division] || '#58635b' : '#6e7681';
  const lw = charW(label); const vw = charW(value); const w = lw + vw;
  const title = listed ? `${label}: rank ${rank}${total ? ` of ${total}` : ''}, ${division} division${score != null ? `, score ${score}` : ''}` : `${label}: not listed`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>`
    + `<g shape-rendering="crispEdges"><rect width="${lw}" height="20" fill="#1e162b"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/></g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

// ---- Markdown ------------------------------------------------------------------------------------------------------

const mdc = (s) => String(s ?? '').replace(/([\\`*_[\]<>|#])/g, '\\$1');

export function renderLeagueMarkdown({ base, board = 'top', rows, stats, crowns = [], removalUrl = DEFAULT_REMOVAL_URL }) {
  const b = String(base || '').replace(/\/+$/, '');
  const L = [`# Agent-Ready League`, '', `The most agent-ready websites, ranked. ${stats.players} ${stats.players === 1 ? 'site has' : 'sites have'} joined (average score ${stats.players ? stats.average : 'n/a'}).`, '',
    `Boards: ${BOARD_IDS.map((id) => (id === board ? `**${BOARDS[id].name}**` : `[${BOARDS[id].name}](${b}/league.md?board=${id})`)).join(' | ')}. ${BOARDS[board].blurb}`, ''];
  if (rows.length) {
    L.push('| Rank | Site | Division | Score | Gain 30d | Level | XP | Streak | Achievements |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows.slice(0, 100)) L.push(`| ${r.rank} | [${mdc(r.host)}](${b}${hostUrl(r.host)}?format=markdown) | ${divisionOf(r.score).name} | ${r.score} | ${r.gain > 0 ? `+${r.gain}` : r.gain} | L${r.level} | ${r.xp} | ${r.streak}w | ${r.achievements}/${ACHIEVEMENTS.length} |`);
  } else L.push('Nobody is on this board yet.');
  if (crowns.length) L.push('', '## Layer crowns', '', ...crowns.map((c) => `- ${layerName(c.layer)}: [${mdc(c.host)}](${b}${hostUrl(c.host)}?format=markdown), ${c.score}/100`));
  L.push('', '## Join', '', `Scan a site at ${b}/, then submit the stored report with \`POST ${b}/api/league {"report_id":"..."}\` or the Join button on the report page. XP: ${XP.join} for joining, ${XP.perPoint} per point above your best, ${XP.perLevel} per level above your best, plus streak bonuses and achievements. Data: \`GET ${b}/api/league\`.`, '', '## Community rankings', '', `Rankings are community-submitted: anyone can add a public site from a scan this service ran, so a listing does not mean the site's owner took part, checked it or agrees with it. To have a site removed, open an issue at ${removalUrl} with the host name.`, '');
  return L.join('\n');
}

export function renderProfileMarkdown({ base, st, now = Date.now(), removalUrl = DEFAULT_REMOVAL_URL }) {
  const b = String(base || '').replace(/\/+$/, ''); const e = st.entry;
  const pl = playerLevel(e.xp);
  const L = [`# ${mdc(e.host)} on the Agent-Ready League`, '',
    `- Score: ${e.score}/100 (best ${e.best_score}), ${divisionOf(e.score).name} division, isitagentready-compatible level ${e.level} (${LEVEL_NAMES[e.level]})`,
    `- Rank: Top ${st.ranks.top ? `#${st.ranks.top}` : 'unranked'} of ${st.total}, Climbers ${st.ranks.climbers ? `#${st.ranks.climbers}` : '-'}, Grinders ${st.ranks.grinders ? `#${st.ranks.grinders}` : '-'}`,
    `- XP: ${e.xp} (player level ${pl.level}), weekly streak ${e.streak_week != null && weekOf(now) - e.streak_week <= 1 ? e.streak : 0}`,
    `- Last scan: ${e.updated_at.slice(0, 10)}${isActive(e, now) ? '' : ' (dormant, off the boards)'}`, '',
    '## Achievements', '', ...ACHIEVEMENTS.map((a) => `- [${e.achievements[a.id] ? 'x' : ' '}] ${a.name}: ${a.how}`), ''];
  if (st.crowns.length) L.push(`Holds the layer crown for: ${st.crowns.map(layerName).join(', ')}.`, '');
  L.push(`Profile: ${b}${hostUrl(e.host)}`, '', '## Community rankings', '',
    `This listing is community-submitted and has not been verified by the site's owner. To request removal, [open an issue](${removalUrl}) with the host name.`, '');
  return L.join('\n');
}
