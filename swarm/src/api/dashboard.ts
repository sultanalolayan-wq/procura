/**
 * api/dashboard.ts — the operations console: one self-contained page, no CDN,
 * no external fonts, no network calls except to this API.
 * Invariants: the JS is served from its OWN route (/dashboard.js) so the page
 * needs no inline-script exemption in the CSP — the only nonce is on the single
 * <style> block; every number rendered comes from /api/state and nothing is
 * computed from stale state; an unreachable API shows a loud banner, never a
 * blank screen. Callers: api/server.ts.
 */

/** Escape for HTML text/attribute context. The nonce is the only thing we inject. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Refresh cadence of the dashboard poll, in milliseconds. */
export const DASHBOARD_POLL_MS = 3000;

/**
 * The client script. Plain ES2020, no build step, no dependencies. Served as
 * application/javascript from /dashboard.js.
 */
export const DASHBOARD_JS = `'use strict';
var POLL_MS = ${DASHBOARD_POLL_MS};
var $ = function (id) { return document.getElementById(id); };
var fails = 0;

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(minor, cur) {
  if (typeof minor !== 'number' || !isFinite(minor)) return '—';
  var neg = minor < 0;
  var a = Math.abs(minor);
  var major = Math.floor(a / 100);
  var cents = String(a % 100).padStart(2, '0');
  var grouped = String(major).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  return (neg ? '-' : '') + (cur || '') + ' ' + grouped + '.' + cents;
}

function pct(n) { return (Math.round(n * 1000) / 10) + '%'; }

function setBanner(text, kind) {
  var b = $('banner');
  b.textContent = text;
  b.className = 'banner ' + kind;
}

function setError(msg) {
  var e = $('err');
  if (msg === null) { e.hidden = true; e.textContent = ''; return; }
  e.hidden = false;
  e.textContent = msg;
}

function statusClass(s) {
  if (s === 'active') return 'ok';
  if (s === 'probation') return 'warn';
  if (s === 'quarantined') return 'warn';
  if (s === 'terminated') return 'bad';
  return '';
}

function verdictClass(v) {
  if (v === 'PASS') return 'ok';
  if (v === 'PROBATION') return 'warn';
  if (v === 'TERMINATE') return 'bad';
  return 'muted';
}

function render(s) {
  var cur = (s.cash && s.cash.currency) || '';
  setBanner('MODE: ' + s.mode + ' — simulated funds only, no real orders are ever placed', 'paper');

  var ks = s.killSwitch || {};
  $('ks').textContent = ks.tripped ? 'HALTED' : 'LIVE';
  $('ks').className = 'big ' + (ks.tripped ? 'bad' : 'ok');
  $('ksreason').textContent = ks.tripped ? (ks.reason || 'no reason recorded') : 'kill switch armed, not tripped';

  var sup = s.supervisor || {};
  $('tick').textContent = String(sup.tick === undefined ? '—' : sup.tick);
  $('tickmeta').textContent =
    'executed ' + (sup.ticksExecuted || 0) + ' · skipped ' + (sup.ticksSkipped || 0) +
    ' · last ' + (sup.lastTickMs || 0) + 'ms · overruns ' + (sup.overruns || 0) +
    (sup.quarantined && sup.quarantined.length ? ' · quarantined ' + sup.quarantined.join(', ') : '');

  var c = s.cash || {};
  $('cash').textContent = money(c.onHandMinor, cur);
  $('cash').className = 'big ' + (c.onHandMinor >= c.startingMinor ? 'ok' : 'warn');
  $('cashmeta').textContent = 'starting ' + money(c.startingMinor, cur) +
    ' · cap ' + money(c.globalCapMinor, cur);

  var dd = c.drawdownMinor || 0;
  var lim = c.maxDrawdownMinor || 1;
  var ratio = Math.max(0, Math.min(1, dd / lim));
  $('dd').textContent = money(dd, cur) + ' / ' + money(lim, cur);
  $('dd').className = 'big ' + (ratio >= 1 ? 'bad' : ratio > 0.6 ? 'warn' : 'ok');
  $('ddbar').style.width = pct(ratio);
  $('ddbar').className = 'bar ' + (ratio >= 1 ? 'bad' : ratio > 0.6 ? 'warn' : 'ok');
  $('ddmeta').textContent = pct(ratio) + ' of the drawdown limit consumed';

  var led = s.ledger || {};
  $('ledgerhead').textContent = (led.size || 0) + ' entries · head ' + String(led.head || '').slice(0, 16);

  var rows = (s.agents || []).map(function (a) {
    return '<tr>' +
      '<td class="mono">' + esc(a.id) + '</td>' +
      '<td>' + esc(a.role) + '</td>' +
      '<td class="mono">' + esc(a.strategyId) + '</td>' +
      '<td class="' + statusClass(a.status) + '">' + esc(a.status) + '</td>' +
      '<td class="num ' + (a.netMinor < 0 ? 'bad' : 'ok') + '">' + esc(money(a.netMinor, cur)) + '</td>' +
      '<td class="' + verdictClass(a.verdict) + '">' + esc(a.verdict) + '</td>' +
      '<td class="num">' + esc(a.crashes) + '</td>' +
      '<td class="num">' + esc(a.holdings) + '</td>' +
      '</tr>';
  }).join('');
  $('agents').innerHTML = rows || '<tr><td colspan="8" class="muted">no agents registered</td></tr>';

  var bus = s.bus || {};
  var dr = bus.dropReasons || {};
  var drKeys = Object.keys(dr);
  $('bus').textContent = 'published ' + (bus.published || 0) + ' · delivered ' + (bus.delivered || 0) +
    ' · dropped ' + (bus.dropped || 0) + ' · depth ' + (bus.depth || 0) +
    ' · handler errors ' + (bus.handlerErrors || 0);
  $('drops').innerHTML = drKeys.length
    ? drKeys.map(function (k) { return '<li><span class="mono">' + esc(k) + '</span> <b>' + esc(dr[k]) + '</b></li>'; }).join('')
    : '<li class="muted">no messages dropped</li>';

  var pol = s.policy || {};
  var byRule = pol.denialsByRule || {};
  var ruleKeys = Object.keys(byRule);
  $('polstats').textContent = 'allowed ' + ((pol.stats && pol.stats.allowed) || 0) +
    ' · denied ' + ((pol.stats && pol.stats.denied) || 0) +
    ' (last ' + ((pol.stats && pol.stats.retained) || 0) + ' decisions retained)';
  $('denials').innerHTML = ruleKeys.length
    ? ruleKeys.map(function (k) { return '<li><span class="mono">' + esc(k) + '</span> <b>' + esc(byRule[k]) + '</b></li>'; }).join('')
    : '<li class="muted">no policy denials in the retained window</li>';

  $('channels').innerHTML = (s.channels || []).map(function (ch) {
    return '<li><span class="mono">' + esc(ch.name) + '</span> ' +
      (ch.canBuy ? '<span class="tag">buy</span>' : '') +
      (ch.canSell ? '<span class="tag">sell</span>' : '') +
      '<span class="muted"> ' + esc(ch.jurisdiction) + '</span></li>';
  }).join('') || '<li class="muted">no channels</li>';

  $('ledger').innerHTML = (s.recentLedger || []).slice().reverse().map(function (e) {
    var legs = (e.legs || []).map(function (l) {
      return '<span class="mono">' + esc(l.account) + ' ' + (l.amount >= 0 ? '+' : '') + esc(l.amount) + '</span>';
    }).join(' ');
    return '<tr><td class="num mono">' + esc(e.seq) + '</td><td class="num">' + esc(e.tick) + '</td>' +
      '<td class="mono">' + esc(e.type) + '</td><td class="mono">' + esc(e.agentId) + '</td>' +
      '<td>' + legs + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="muted">the ledger is empty</td></tr>';

  $('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
}

function poll() {
  fetch('/api/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (s) { fails = 0; setError(null); render(s); })
    .catch(function (e) {
      fails++;
      setError('API UNREACHABLE (' + fails + ' consecutive failures): ' + e.message +
        '. The figures below are stale. Check that the ARES process is still running.');
      setBanner('API UNREACHABLE — the numbers on this page are STALE', 'bad');
    });
}

$('halt').addEventListener('click', function () {
  var ok = window.confirm(
    'HALT THE SWARM?\\n\\n' +
    'This is IRREVERSIBLE for the life of this process: the kill switch is a one-way ' +
    'latch and nothing can un-trip it. Every agent stops trading immediately and the ' +
    'process must be restarted to resume.\\n\\nProceed?');
  if (!ok) return;
  var token = $('token').value;
  fetch('/api/halt', {
    method: 'POST',
    headers: token ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
                   : { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'halted from the dashboard' })
  })
    .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (o) {
      $('haltmsg').textContent = o.s === 200
        ? (o.j.message || 'halted')
        : 'refused (' + o.s + '): ' + (o.j.error || 'unknown');
      poll();
    })
    .catch(function (e) { $('haltmsg').textContent = 'request failed: ' + e.message; });
});

poll();
setInterval(poll, POLL_MS);
`;

/** The page. `nonce` authorises the single <style> block and nothing else. */
export function renderDashboardHtml(nonce: string): string {
  const n = esc(nonce);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARES — operations console (PAPER)</title>
<style nonce="${n}">
:root{
  --bg:#f6f7f9; --panel:#ffffff; --line:#d7dbe0; --fg:#14171a; --muted:#5b6570;
  --ok:#0a7a3d; --warn:#9a6400; --bad:#b3261e; --accent:#1a4fa0; --paper:#7a4d00; --paperbg:#ffe9b8;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0e1013; --panel:#171a1f; --line:#2b3138; --fg:#e6e9ed; --muted:#98a2ad;
    --ok:#4ec77f; --warn:#e0a83a; --bad:#ff6b5e; --accent:#7aa7ff; --paper:#ffd479; --paperbg:#3a2c08;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace}
header{padding:10px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:14px;margin:0 0 6px;letter-spacing:.06em}
.banner{padding:6px 10px;border-radius:4px;font-weight:700;letter-spacing:.04em}
.banner.paper{background:var(--paperbg);color:var(--paper);border:1px solid var(--paper)}
.banner.bad{background:var(--bad);color:#fff;border:1px solid var(--bad)}
#err{margin:8px 12px 0;padding:8px 10px;border:1px solid var(--bad);color:var(--bad);border-radius:4px}
main{padding:12px;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;min-width:0}
section.wide{grid-column:1/-1}
h2{font-size:11px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.big{font-size:20px;font-weight:700;overflow-wrap:anywhere}
.meta,.muted{color:var(--muted)}
.ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)}
.track{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin:8px 0 4px}
.bar{height:6px;width:0;background:var(--ok);transition:width .3s}
.bar.warn{background:var(--warn)} .bar.bad{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.08em}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:inherit}
ul{list-style:none;margin:0;padding:0}
li{padding:2px 0;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}
.tag{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:0 4px;margin-left:4px;font-size:10px}
.scroll{overflow-x:auto}
input,button{font:inherit;border-radius:4px;border:1px solid var(--line);
  background:var(--bg);color:var(--fg);padding:5px 8px}
button{background:var(--bad);color:#fff;border-color:var(--bad);cursor:pointer;font-weight:700}
footer{padding:10px 12px;color:var(--muted);border-top:1px solid var(--line)}
@media (max-width:520px){ main{padding:8px;gap:8px} .big{font-size:17px} }
</style>
</head>
<body>
<header>
  <h1>ARES — AUTONOMOUS REVENUE &amp; ENFORCEMENT SWARM</h1>
  <div id="banner" class="banner paper">MODE: PAPER — simulated funds only</div>
</header>
<div id="err" hidden></div>
<main>
  <section>
    <h2>Kill switch</h2>
    <div id="ks" class="big">…</div>
    <div id="ksreason" class="meta">waiting for /api/state</div>
  </section>
  <section>
    <h2>Tick</h2>
    <div id="tick" class="big">…</div>
    <div id="tickmeta" class="meta"></div>
  </section>
  <section>
    <h2>Cash on hand</h2>
    <div id="cash" class="big">…</div>
    <div id="cashmeta" class="meta"></div>
  </section>
  <section>
    <h2>Drawdown vs limit</h2>
    <div id="dd" class="big">…</div>
    <div class="track"><div id="ddbar" class="bar"></div></div>
    <div id="ddmeta" class="meta"></div>
  </section>

  <section class="wide">
    <h2>Agents</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>id</th><th>role</th><th>strategy</th><th>status</th>
          <th class="num">net</th><th>verdict</th><th class="num">crashes</th><th class="num">holdings</th></tr></thead>
        <tbody id="agents"><tr><td colspan="8" class="muted">…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Bus</h2>
    <div id="bus" class="meta"></div>
    <ul id="drops"></ul>
  </section>
  <section>
    <h2>Policy</h2>
    <div id="polstats" class="meta"></div>
    <ul id="denials"></ul>
  </section>
  <section>
    <h2>Channels</h2>
    <ul id="channels"></ul>
  </section>

  <section class="wide">
    <h2>Recent ledger <span id="ledgerhead" class="meta"></span></h2>
    <div class="scroll">
      <table>
        <thead><tr><th class="num">seq</th><th class="num">tick</th><th>type</th><th>agent</th><th>legs</th></tr></thead>
        <tbody id="ledger"><tr><td colspan="5" class="muted">…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="wide">
    <h2>Halt — irreversible</h2>
    <p class="meta">Tripping the kill switch is IRREVERSIBLE: it is a ONE-WAY latch and cannot be
    undone while this process lives. Every agent stops trading at once and the process must be restarted to resume.
    Requires the operator token when one is configured.</p>
    <p><input id="token" type="password" placeholder="operator token" autocomplete="off" size="28">
    <button id="halt" type="button">HALT THE SWARM</button></p>
    <p id="haltmsg" class="meta"></p>
  </section>
</main>
<footer><span id="updated">loading…</span> · polls /api/state every ${String(DASHBOARD_POLL_MS / 1000)}s · no external requests</footer>
<script src="/dashboard.js"></script>
</body>
</html>
`;
}
