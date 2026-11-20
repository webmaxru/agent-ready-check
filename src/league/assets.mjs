// Stylesheet and client script for the League pages. The CSS is appended to /assets/app.css (one stylesheet for the
// whole site, see docs/DESIGN.md); the script is /assets/league.js and only the League pages and the report page load it.
// Colour pairs are the ones already in the contrast table of docs/DESIGN.md. No inline styles anywhere (CSP).

export const LEAGUE_CSS = String.raw`
/* ---- Agent-Ready League ---- */
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lhero{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:calc(var(--u)*6);align-items:start}
.lhero h1{margin-bottom:calc(var(--u)*3)}
.lhero .kicker{display:flex;align-items:center;gap:8px}
.stats{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:var(--u);background:var(--ink);border:var(--b) solid var(--ink);box-shadow:8px 8px 0 var(--mint);padding:calc(var(--u)*2)}
.stats div{background:var(--ink-deep);border:var(--b) solid var(--plum);padding:calc(var(--u)*2)}
.stats dt{font-size:14px;color:var(--lavender)}
.stats dd{margin:4px 0 0;font-family:var(--font-pixel);font-size:32px;line-height:1;color:var(--mint)}
.tabs{display:flex;flex-wrap:wrap;gap:0;margin-bottom:var(--u);border-bottom:var(--b) solid var(--ink)}
.tabs a{font-family:var(--font-pixel);font-size:16px;color:var(--ink);text-decoration:none;padding:10px 16px;border:var(--b) solid transparent;border-bottom:0;margin-bottom:-2px}
.tabs a:hover{border-color:var(--ink);background:var(--panel)}
.tabs a[aria-current="page"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.boardblurb{margin-bottom:calc(var(--u)*3)}
.empty{background:var(--panel);border:var(--b) dashed var(--rule);padding:calc(var(--u)*3);color:var(--muted)}
.notice{background:var(--cream);border:var(--b) solid var(--ink);padding:calc(var(--u)*2);margin-bottom:calc(var(--u)*3)}
.pager{display:flex;align-items:center;gap:calc(var(--u)*2);margin-top:calc(var(--u)*3)}

/* podium */
.podium{list-style:none;margin:0 0 calc(var(--u)*4);padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--u);align-items:end}
.podium .slot{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;min-width:0}
.podium .who{font-family:var(--font-pixel);font-size:16px;overflow-wrap:anywhere;color:var(--ink)}
.podium .pts{font-family:var(--font-pixel);font-size:32px;line-height:1;color:var(--ink)}
.podium .step{width:100%;display:flex;justify-content:center;align-items:flex-start;padding-top:8px;background:var(--ink);border:var(--b) solid var(--ink);color:var(--ink)}
.podium .step .n{font-family:var(--font-pixel);font-size:32px;line-height:1}
.podium .p1 .step{height:128px;background:var(--olive)}
.podium .p2 .step{height:96px;background:var(--lavender)}
.podium .p3 .step{height:72px;background:var(--orange);color:#fff}

/* chips */
.div{display:inline-flex;align-items:center;font:700 13px/1 var(--font-body);text-transform:uppercase;letter-spacing:.04em;padding:4px 8px;border:var(--b) solid var(--ink);color:var(--ink);background:var(--rule-soft);white-space:nowrap}
.div-bronze{background:var(--orange);color:#fff}
.div-silver{background:var(--rule-soft)}
.div-gold{background:var(--olive)}
.div-platinum{background:var(--lavender)}
.div-diamond{background:var(--mint)}
.lvl{font-family:var(--font-pixel);font-size:14px;color:var(--ink);white-space:nowrap}
.lvl.dark{color:var(--paper);margin-left:8px}

/* leaderboard table */
table.league th.rk,table.league td.rk{width:64px;font-family:var(--font-pixel);font-size:18px;text-align:center;color:var(--ink);background:var(--rule-soft)}
table.league tr.top1 th.rk{background:var(--olive)}
table.league tr.top2 th.rk{background:var(--lavender)}
table.league tr.top3 th.rk{background:var(--orange);color:#fff}
table.league td.site{display:flex;flex-direction:column;gap:2px;min-width:12ch}
table.league td.site a{font-family:var(--font-mono);font-weight:700;overflow-wrap:anywhere}
table.league td.num,table.league th.num{text-align:right;white-space:nowrap}
table.league th.key{background:var(--ink-deep);color:var(--mint);box-shadow:inset 0 -3px 0 var(--mint)}
table.league td.key-on{background:var(--cream)}
table.league td.up{color:var(--pass-text);font-weight:700}
table.league tbody tr:hover{background:var(--rule-soft)}
.blocks{display:inline-grid;grid-auto-flow:column;grid-auto-columns:6px;gap:2px;height:10px;margin-left:8px;vertical-align:middle}
.blocks span{background:var(--rule-soft);border:1px solid var(--rule)}
.blocks.tiny{grid-auto-columns:5px;height:8px}
.blocks .on{background:var(--green);border-color:var(--green)}
.blocks.mid .on{background:var(--olive-text);border-color:var(--olive-text)}
.blocks.bad .on{background:var(--pink-text);border-color:var(--pink-text)}
.blocks.xp{grid-auto-columns:12px;height:14px;margin:8px 0;display:grid;grid-template-columns:repeat(20,12px)}
.blocks.xp span{background:var(--plum);border-color:var(--plum)}
.blocks.xp .on{background:var(--mint);border-color:var(--mint)}

/* layer crowns */
.spot{background:var(--panel);border:var(--b) solid var(--ink);padding:calc(var(--u)*2);margin-bottom:calc(var(--u)*3)}
.chip-spot{display:inline-block;font:700 13px/1 var(--font-body);text-transform:uppercase;letter-spacing:.04em;padding:4px 8px;background:var(--violet);color:#fff;margin-right:8px}
.crowns{list-style:none;margin:0 0 var(--u);padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--u)}
.crowns li{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"c l s" "c h s";gap:0 10px;align-items:center;background:var(--panel);border:var(--b) solid var(--ink);padding:10px 12px}
.crowns .crown{grid-area:c;color:var(--olive-text)}
.crowns .cl{grid-area:l;font-size:14px;color:var(--muted)}
.crowns a{grid-area:h;font-family:var(--font-mono);font-weight:700;overflow-wrap:anywhere}
.crowns .cs{grid-area:s;font-family:var(--font-pixel);font-size:20px;color:var(--ink)}

/* rules */
.rules h3{margin:calc(var(--u)*3) 0 var(--u)}
.rules h3:first-child{margin-top:0}
ul.plain{margin:0 0 var(--u);padding-left:20px}
ul.plain li{margin-bottom:4px}
.divs{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px 24px}
.divs li{display:inline-flex;align-items:center;gap:8px}
.achlist{list-style:none;margin:0;padding:0;border-top:var(--b) solid var(--ink)}
.achlist li{display:grid;grid-template-columns:36px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--rule);align-items:start}
.tile{display:inline-grid;place-items:center;width:36px;height:36px;background:var(--ink);color:var(--mint);border:var(--b) solid var(--ink);flex:none}
.achlist .tile{width:32px;height:32px}
.xpn{font-family:var(--font-pixel);font-size:13px;color:var(--violet);white-space:nowrap}

/* profile */
.console.profile{grid-template-columns:minmax(0,6fr) minmax(0,6fr)}
.console.profile .xpline{font-family:var(--font-pixel);color:var(--paper);margin-bottom:calc(var(--u)*2)}
.console.profile .xpline b{font-size:32px;color:var(--mint)}
.console.profile .xpline .small{display:block}
.ranks{list-style:none;margin:0 0 calc(var(--u)*3);padding:0;display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.ranks li{display:flex;flex-direction:column;gap:2px;background:var(--ink-deep);border:var(--b) solid var(--plum);padding:8px}
.ranks b{font-family:var(--font-pixel);font-size:20px;color:var(--paper)}
.console .div{border-color:var(--paper)}
.console .btn{color:var(--paper)}
.console .actions{display:flex;flex-wrap:wrap;gap:var(--u)}
.console .btn.quiet{background:var(--ink);color:var(--paper);border-color:var(--paper)}
.console .btn.quiet:hover{background:var(--paper);color:var(--ink)}
.crownline{color:var(--olive);margin-top:var(--u)}
.crownline svg{color:var(--olive);vertical-align:-4px;margin-right:8px}
svg.hist{display:block;background:var(--panel);border:var(--b) solid var(--ink);padding:8px;width:100%;max-width:760px;height:auto;font-family:var(--mono,monospace)}
.histfig{margin:0}.histfig figcaption{margin-top:8px}
.lhero .small{margin-top:calc(var(--u)*4)}
.achgrid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--u)}
.ach{display:flex;flex-direction:column;gap:6px;align-items:flex-start;background:var(--panel);border:var(--b) solid var(--ink);padding:calc(var(--u)*2)}
.ach .tile{background:var(--ink);color:var(--mint)}
.ach.off{border-style:dashed;border-color:var(--rule);color:var(--muted);background:transparent}
.ach.off .tile{background:var(--rule-soft);color:var(--muted);border-color:var(--rule)}
.ach.off b{color:var(--muted)}
.layerbars{list-style:none;margin:0;padding:0;columns:2;column-gap:calc(var(--u)*6);border-top:var(--b) solid var(--ink)}
.layerbars li{break-inside:avoid;display:grid;grid-template-columns:1fr auto 40px;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rule)}
.layerbars b{font-family:var(--font-pixel);text-align:right}

/* quests */
.quests{list-style:none;margin:0 0 var(--u);padding:0;border-top:var(--b) solid var(--ink)}
.quests li{display:grid;grid-template-columns:64px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--rule);align-items:start}
.quests .gain{font-family:var(--font-pixel);font-size:18px;color:var(--pass-text);text-align:center;background:var(--rule-soft);border:var(--b) solid var(--ink);padding:4px 0}
.quests .qt{display:flex;flex-direction:column;gap:2px;min-width:0}
.quests .qt a{font-weight:700;overflow-wrap:anywhere}

/* panel on the report page */
.league-panel .lp-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:calc(var(--u)*4);align-items:start}
.lp-main{background:var(--ink);color:var(--cream);border:var(--b) solid var(--ink);box-shadow:8px 8px 0 var(--mint);padding:calc(var(--u)*3);display:flex;flex-direction:column;gap:calc(var(--u)*2)}
.lp-main p{margin:0;color:var(--cream)}
.lp-main .small{color:var(--lavender)}
.lp-main a{color:var(--mint)}
.lp-main b{color:var(--paper)}
.lp-main .div{border-color:var(--paper)}
.lp-lead{font-size:19px;line-height:1.5}
.lp-main button{background:var(--mint);color:var(--ink);border-color:var(--paper);box-shadow:4px 4px 0 var(--violet)}
.lp-main button:hover{background:var(--paper);color:var(--ink)}
.lp-main .btn{background:var(--mint);color:var(--ink);border-color:var(--paper);box-shadow:4px 4px 0 var(--violet);align-self:flex-start;text-decoration:none}
.teaser{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.teaser li{display:inline-flex;align-items:center;gap:6px;background:var(--ink-deep);border:var(--b) solid var(--plum);padding:4px 8px;font-size:14px}
.teaser .tile{width:24px;height:24px;border-color:var(--plum)}
.teaser .xpn{color:var(--mint)}
.lp-quests h3{margin-bottom:var(--u)}

/* celebration */
.cele{background:var(--ink);color:var(--cream);border:var(--b) solid var(--ink);box-shadow:8px 8px 0 var(--pink);padding:calc(var(--u)*3);margin-bottom:calc(var(--u)*5)}
.cele h2{color:var(--paper)}
.cele .gainline{font-family:var(--font-pixel);color:var(--lavender);font-size:20px}
.cele .gainline .big{font-size:56px;color:var(--mint);line-height:1}
.events{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ev{display:flex;align-items:center;gap:12px;background:var(--ink-deep);border:var(--b) solid var(--plum);padding:8px 12px}
.ev .xpn{margin-left:auto;color:var(--mint)}
.ev-achievement{border-color:var(--mint)}
.ev .tile{border-color:var(--plum)}
canvas.confetti{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:20}

@media (max-width:900px){
  .lhero,.league-panel .lp-grid,.console.profile{grid-template-columns:1fr}
  .console.profile > div + div{border-left:0;border-top:var(--b) solid var(--plum)}
  .crowns{grid-template-columns:1fr 1fr}
  .layerbars{columns:1}
}
@media (max-width:640px){
  table.league .opt:not(.key){display:none}
  table.league th,table.league td{padding:6px 5px}
  table.league th.rk,table.league td.rk{width:36px;padding:6px 2px;font-size:11px;text-align:center}
  table.league .div{font-size:9px;padding:2px 4px;letter-spacing:0}
  table.league td.site a{font-size:13px}
  table.league .blocks,table.league .tiny{display:none}
  .crowns{grid-template-columns:1fr}
  .ranks{grid-template-columns:repeat(3,1fr)}
  .podium .pts{font-size:24px}
  .podium .who{font-size:11px}
}
@media (prefers-reduced-motion:reduce){canvas.confetti{display:none}}
@media print{canvas.confetti,.league-panel form{display:none}}
`;

export const LEAGUE_JS = String.raw`// Agent-Ready League: progressive enhancement only. Every League page works without this script.
// - a burst of pixel confetti and a count-up when you have just joined or levelled up (skipped for reduced motion)
const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function countUp(el) {
  const target = Number(el.dataset.count);
  if (reduce || !Number.isFinite(target) || target <= 0) return;
  const started = performance.now(); const ms = 900;
  const fmt = (n) => (el.dataset.group === 'no' ? String(n) : n.toLocaleString('en-US'));
  const tick = (t) => {
    const k = Math.min(1, (t - started) / ms);
    el.textContent = fmt(Math.round(target * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  el.textContent = fmt(0);
  requestAnimationFrame(tick);
}

function confetti() {
  if (reduce) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const colors = ['#5fed83', '#583af7', '#f73678', '#bba00a', '#ae85ff', '#168ffb'];
  const bits = Array.from({ length: 140 }, (_, i) => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 240, y: canvas.height * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 12 - 4, s: 6 + Math.floor(Math.random() * 3) * 2,
    c: colors[i % colors.length],
  }));
  const end = performance.now() + 2600;
  (function frame(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const b of bits) {
      b.vy += 0.38; b.x += b.vx; b.y += b.vy; b.vx *= 0.99;
      ctx.fillStyle = b.c; ctx.fillRect(Math.round(b.x), Math.round(b.y), b.s, b.s);
    }
    if (t < end) requestAnimationFrame(frame); else canvas.remove();
  })(performance.now());
}

const cele = document.querySelector('[data-celebrate]');
if (cele) {
  for (const el of cele.querySelectorAll('[data-count]')) countUp(el);
  confetti();
  // Drop the one-time query parameter so a reload or a shared link does not replay the party.
  const url = new URL(location.href);
  if (url.searchParams.has('joined') || url.searchParams.has('updated')) { url.searchParams.delete('joined'); url.searchParams.delete('updated'); history.replaceState(null, '', url); }
}
for (const el of document.querySelectorAll('[data-count]')) if (!el.closest('[data-celebrate]')) countUp(el);
`;
