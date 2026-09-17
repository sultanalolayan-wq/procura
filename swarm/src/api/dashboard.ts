/**
 * api/dashboard.ts — the operations console: one self-contained page, no CDN,
 * no external fonts, no network calls except to this API.
 * Invariants: the JS is served from its OWN route (/dashboard.js) so the page
 * needs no inline-script exemption in the CSP — the only nonce is on the single
 * <style> block; every number rendered comes from /api/state; a poll that fails
 * OR HANGS marks the whole page stale, in the <main> body and in the tab title,
 * not only in a header banner the operator may have scrolled past.
 * Callers: api/server.ts.
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
 * How long a single poll may take before it is ABORTED. Without this a socket
 * that accepts and never answers leaves the promise pending forever: .catch()
 * never runs, the banner never reddens and the page shows LIVE with stale cash
 * indefinitely. A hung API is more dangerous than a dead one, because it looks
 * exactly like a healthy one.
 */
export const DASHBOARD_FETCH_TIMEOUT_MS = 2500;

/** Consecutive failures after which the poll interval widens (stop hammering). */
export const DASHBOARD_BACKOFF_AFTER = 3;

/**
 * The client script. Plain ES2020, no build step, no dependencies. Served as
 * application/javascript from /dashboard.js.
 */
export const DASHBOARD_JS = `'use strict';
var POLL_MS = ${DASHBOARD_POLL_MS};
var TIMEOUT_MS = ${DASHBOARD_FETCH_TIMEOUT_MS};
var BACKOFF_AFTER = ${DASHBOARD_BACKOFF_AFTER};
var fails = 0;
/* Only one poll may be in flight. A hung request must not stack a new one every
   3 seconds until the browser runs out of sockets. */
var inFlight = false;
/* Monotonic sequence: a slow response that returns AFTER a newer one is thrown
   away, so cash can never visibly regress to an older figure. */
var seq = 0;
var renderedSeq = -1;
var timer = null;
var lastOkAt = 0;
var lastState = null;
var lastHtml = {};

var $ = function (id) { return document.getElementById(id); };

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

/** Signed money, with an explicit '+' so a credit never reads as a debit. */
function smoney(minor, cur) {
  if (typeof minor !== 'number' || !isFinite(minor)) return '—';
  return (minor >= 0 ? '+' : '') + money(minor, cur);
}

function pct(n) { return (Math.round(n * 1000) / 10) + '%'; }

/** Coarse human duration. "4m 12s", "5h 18m", "3d 4h" — never a bare number. */
function rel(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

/** Absolute local time, or '' when the timestamp is absent/unusable. */
function stamp(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
  try { return new Date(ms).toLocaleString(); } catch (e) { return ''; }
}

/** innerHTML is expensive AND destroys selection + the screen-reader cursor. */
function setHtml(id, html) {
  if (lastHtml[id] === html) return;
  lastHtml[id] = html;
  $(id).innerHTML = html;
}

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

/**
 * Mark or clear the WHOLE PAGE as stale. The banner lives in <header>; on a
 * phone the operator is usually scrolled past it, reading confident green
 * numbers inside <main>. The numbers themselves have to say so, and so does the
 * tab title, which is all a backgrounded tab shows.
 */
function setStale(on) {
  if (on) {
    document.body.classList.add('stale');
    document.title = 'STALE — ARES';
  } else {
    document.body.classList.remove('stale');
  }
}

function statusClass(s) {
  if (s === 'active') return 'ok';
  if (s === 'probation') return 'warn';
  /* quarantined is NOT probation: one is a crash count, the other an economic
     verdict. Sharing an amber made two unrelated states look like one. */
  if (s === 'quarantined') return 'quar';
  if (s === 'terminated') return 'bad';
  return '';
}

function verdictClass(v) {
  if (v === 'PASS') return 'ok';
  if (v === 'PROBATION') return 'warn';
  if (v === 'TERMINATE') return 'bad';
  return 'muted';
}

/** Why a verdict is not a verdict yet — or never will be. */
function verdictHint(v, a) {
  if (v === 'IMMATURE') return 'too early: the survival window has not closed, or there are not enough samples yet';
  if (v === 'UNJUDGED') {
    return 'no verdict has been recorded for this agent. Either the first window has not closed yet, ' +
      'or no Treasury is wired to judge it — check that a treasury agent is running before reading this as "fine".';
  }
  if (v === 'EXEMPT') return 'the Treasury does not judge itself';
  return String((a && a.verdictReason) || '');
}

function renderKillSwitch(s) {
  var ks = s.killSwitch || {};
  var now = typeof s.ts === 'number' ? s.ts : Date.now();
  var sup = s.supervisor || {};
  var when = '';
  if (ks.tripped) {
    var abs = stamp(ks.trippedAt);
    var ago = typeof ks.trippedAt === 'number' ? rel(now - ks.trippedAt) : '';
    when = abs ? (abs + (ago ? ' (' + ago + ' ago)' : '')) : 'halt time not recorded';
  }
  /* Three distinct states, in TEXT: HALTED, LIVE, and a supervisor that has
     stopped cleanly while the API keeps answering — which used to render as a
     confident LIVE with a tick that never moves again. */
  var running = sup.running !== false && sup.shuttingDown !== true;
  var label = ks.tripped ? 'HALTED' : running ? 'LIVE' : 'STOPPED (not halted)';
  $('ks').textContent = label;
  $('ks').className = 'big ' + (ks.tripped ? 'bad' : running ? 'ok' : 'warn');
  $('ksreason').textContent = ks.tripped
    ? (ks.reason || 'no reason recorded') + ' — halted at ' + when
    : running
      ? 'kill switch armed, not tripped'
      : 'the supervisor is not running. The swarm is not trading, and this is NOT a halt: ' +
        'the kill switch is still armed and untripped.';
  $('kswhen').textContent = ks.tripped ? 'HALTED at ' + when : '';
  return { tripped: !!ks.tripped, when: when, reason: ks.reason || 'no reason recorded' };
}

function render(s) {
  var cur = (s.cash && s.cash.currency) || '';
  var ks = renderKillSwitch(s);

  /* The loudest thing on the page must be the thing that changed. The PAPER
     banner never changes, so on a halt the banner becomes the halt. */
  if (ks.tripped) {
    setBanner('HALTED — ' + ks.reason + ' — ' + ks.when, 'bad');
    document.title = 'HALTED — ARES';
  } else if (s.mode === 'PAPER') {
    setBanner('MODE: PAPER — simulated funds only, no real orders are ever placed', 'paper');
    document.title = 'ARES — operations console (PAPER)';
  } else {
    setBanner('MODE: ' + String(s.mode) + ' — NOT PAPER. Stop and investigate.', 'bad');
    document.title = String(s.mode) + ' — ARES';
  }

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

  /* A MISSING drawdown is not a zero drawdown. \`|| 0\` rendered "unknown" as a
     confident, green, perfectly-safe SAR 0.00 on the one number that predicts
     the halt; and maxDrawdown 0 became 1, giving a full red bar against
     "SAR 0.00". Both now degrade to the em-dash money() already returns. */
  var ddOk = typeof c.drawdownMinor === 'number' && isFinite(c.drawdownMinor);
  var limOk = typeof c.maxDrawdownMinor === 'number' && isFinite(c.maxDrawdownMinor) && c.maxDrawdownMinor > 0;
  if (!ddOk || !limOk) {
    $('dd').textContent = money(ddOk ? c.drawdownMinor : null, cur) + ' / ' + money(limOk ? c.maxDrawdownMinor : null, cur);
    $('dd').className = 'big warn';
    $('ddbar').style.width = '0%';
    $('ddbar').className = 'bar';
    $('ddtrack').hidden = true;
    $('ddmeta').textContent = !ddOk
      ? 'drawdown unavailable — this figure is MISSING, not zero'
      : 'drawdown limit unavailable or zero — the bar cannot be drawn';
  } else {
    var ratio = Math.max(0, Math.min(1, c.drawdownMinor / c.maxDrawdownMinor));
    $('dd').textContent = money(c.drawdownMinor, cur) + ' / ' + money(c.maxDrawdownMinor, cur);
    $('dd').className = 'big ' + (ratio >= 1 ? 'bad' : ratio > 0.6 ? 'warn' : 'ok');
    $('ddtrack').hidden = false;
    $('ddbar').style.width = pct(ratio);
    $('ddbar').className = 'bar ' + (ratio >= 1 ? 'bad' : ratio > 0.6 ? 'warn' : 'ok');
    $('ddmeta').textContent = pct(ratio) + ' of the drawdown limit consumed';
  }

  var led = s.ledger || {};
  var head = String(led.head || '');
  $('ledgerhead').textContent = (led.size || 0) + ' entries' + (head ? ' · head ' + head.slice(0, 16) : '');

  var agents = s.agents || [];
  var counts = { active: 0, probation: 0, quarantined: 0, terminated: 0 };
  for (var i = 0; i < agents.length; i++) {
    var st = agents[i].status;
    if (counts[st] === undefined) counts[st] = 0;
    counts[st]++;
  }
  /* "Did anything get terminated?" must be answerable WITHOUT scrolling a
     nested 8-column table sideways on a 360px phone. */
  var parts = [agents.length + ' agents'];
  for (var k in counts) {
    if (!Object.prototype.hasOwnProperty.call(counts, k)) continue;
    var concerning = k !== 'active' && counts[k] > 0;
    parts.push('<span class="' + (concerning ? statusClass(k) : 'muted') + '">' +
      esc(counts[k]) + ' ' + esc(k) + '</span>');
  }
  setHtml('agentsummary', parts.join(' · '));

  setHtml('agents', agents.map(function (a) {
    var hint = verdictHint(a.verdict, a);
    return '<tr>' +
      '<td class="mono">' + esc(a.id) + '</td>' +
      '<td class="c-status ' + statusClass(a.status) + '">' + esc(a.status) + '</td>' +
      '<td class="num c-net ' + (a.netMinor < 0 ? 'bad' : 'ok') + '">' + esc(money(a.netMinor, cur)) + '</td>' +
      '<td class="c-verdict ' + verdictClass(a.verdict) + '"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>' +
        esc(a.verdict) + (a.verdict === 'UNJUDGED' ? ' <span class="muted">(?)</span>' : '') + '</td>' +
      '<td class="c-role">' + esc(a.role) + '</td>' +
      '<td class="mono c-strategy">' + esc(a.strategyId) + '</td>' +
      '<td class="num">' + esc(a.crashes) + '</td>' +
      '<td class="num">' + esc(a.holdings) + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="8" class="muted">no agents registered</td></tr>');

  var bus = s.bus || {};
  var dr = bus.dropReasons || {};
  var drKeys = Object.keys(dr);
  $('bus').textContent = 'published ' + (bus.published || 0) + ' · delivered ' + (bus.delivered || 0) +
    ' · dropped ' + (bus.dropped || 0) + ' · depth ' + (bus.depth || 0) +
    ' · handler errors ' + (bus.handlerErrors || 0);
  setHtml('drops', drKeys.length
    ? drKeys.map(function (k) { return '<li><span class="mono">' + esc(k) + '</span> <b>' + esc(dr[k]) + '</b></li>'; }).join('')
    : '<li class="muted">no messages dropped</li>');

  var pol = s.policy || {};
  var byRule = pol.denialsByRule || {};
  var ruleKeys = Object.keys(byRule);
  $('polstats').textContent = 'allowed ' + ((pol.stats && pol.stats.allowed) || 0) +
    ' · denied ' + ((pol.stats && pol.stats.denied) || 0) +
    ' (last ' + ((pol.stats && pol.stats.retained) || 0) + ' decisions retained)';
  setHtml('denials', ruleKeys.length
    ? ruleKeys.map(function (k) { return '<li><span class="mono">' + esc(k) + '</span> <b>' + esc(byRule[k]) + '</b></li>'; }).join('')
    : '<li class="muted">no policy denials in the retained window</li>');

  setHtml('channels', (s.channels || []).map(function (ch) {
    return '<li><span class="mono">' + esc(ch.name) + '</span> ' +
      (ch.canBuy ? '<span class="tag">buy</span>' : '') +
      (ch.canSell ? '<span class="tag">sell</span>' : '') +
      (!ch.canBuy && ch.canSell ? '<span class="tag">sell-only</span>' : '') +
      '<span class="muted"> ' + esc(ch.jurisdiction) + '</span></li>';
  }).join('') || '<li class="muted">no channels</li>');

  /* Minor units printed raw next to a Cash tile in riyals is a 100x misread in
     the exact panel an operator uses to reconstruct a loss. Same scale, always. */
  setHtml('ledger', (s.recentLedger || []).slice().reverse().map(function (e) {
    var legs = (e.legs || []).map(function (l) {
      return '<span class="mono">' + esc(l.account) + ' ' + esc(smoney(l.amount, cur)) + '</span>';
    }).join(' ');
    return '<tr><td class="num mono">' + esc(e.seq) + '</td><td class="num">' + esc(e.tick) + '</td>' +
      '<td class="mono">' + esc(e.type) + '</td><td class="mono">' + esc(e.agentId) + '</td>' +
      '<td>' + legs + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="muted">the ledger is empty</td></tr>');

  var balances = (s.ledger && s.ledger.balances) || null;
  setHtml('balances', balances
    ? Object.keys(balances).map(function (k) {
        return '<li><span class="mono">' + esc(k) + '</span> <b>' + esc(money(balances[k], cur)) + '</b></li>';
      }).join('')
    : '<li class="muted">no balances reported</li>');

  /* The halt button must not look like an available action once it has been
     used: tapping it again answers alreadyHalted:true and printed a message
     that read as though YOU had just halted the swarm. */
  var btn = $('halt');
  btn.disabled = ks.tripped;
  btn.textContent = ks.tripped ? 'ALREADY HALTED' : 'HALT THE SWARM';

  lastState = s;
  markUpdated(s);
}

function markUpdated(s) {
  var now = Date.now();
  lastOkAt = now;
  var srv = typeof s.ts === 'number' ? s.ts : now;
  var up = typeof s.uptimeMs === 'number' ? ' · up ' + rel(s.uptimeMs) : '';
  $('updated').textContent = 'updated ' + stamp(srv) + ' (0s ago)' + up;
  $('updated').className = '';
}

/* The footer clock is the CLIENT's, and a time-of-day alone is read as "last
   activity". Age it continuously so an 18-hour-old page cannot read as fresh. */
function tickFooter() {
  if (lastOkAt === 0) return;
  var age = Date.now() - lastOkAt;
  var s = lastState || {};
  var srv = typeof s.ts === 'number' ? s.ts : lastOkAt;
  var up = typeof s.uptimeMs === 'number' ? ' · up ' + rel(s.uptimeMs + age) : '';
  $('updated').textContent = 'updated ' + stamp(srv) + ' (' + rel(age) + ' ago)' + up;
  $('updated').className = age > POLL_MS * 3 ? 'bad' : '';
}

function schedule() {
  if (timer !== null) clearTimeout(timer);
  /* Widen the interval once the API is clearly down: a dead endpoint must not
     be hammered every 3s forever. Capped so recovery is still noticed fast. */
  var wait = fails >= BACKOFF_AFTER ? Math.min(POLL_MS * 10, POLL_MS * (fails - BACKOFF_AFTER + 2)) : POLL_MS;
  timer = setTimeout(poll, wait);
}

function poll() {
  if (inFlight) { schedule(); return; }
  inFlight = true;
  var mySeq = ++seq;
  var opts = { headers: { accept: 'application/json' }, cache: 'no-store' };
  /* AbortSignal.timeout is what turns a HUNG socket into a visible failure. */
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(TIMEOUT_MS);
  }
  fetch('/api/state', opts)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (s) {
      if (mySeq <= renderedSeq) return null; // a newer response already landed
      renderedSeq = mySeq;
      return s;
    })
    .catch(function (e) {
      if (mySeq <= renderedSeq) return null;
      fails++;
      setError('API UNREACHABLE (' + fails + ' consecutive failures): ' + (e && e.message ? e.message : String(e)) +
        '. The figures below are STALE. Check that the ARES process is still running.');
      setBanner('API UNREACHABLE — the numbers on this page are STALE', 'bad');
      setStale(true);
      return null;
    })
    .then(function (s) {
      inFlight = false;
      schedule();
      if (s === null || s === undefined) return;
      fails = 0;
      setError(null);
      setStale(false);
      /* render() is called OUTSIDE the fetch chain's error handling on purpose:
         a 200 of an unexpected shape used to throw inside .then and be reported
         as "API UNREACHABLE" after the tiles had already been half-updated. */
      try {
        render(s);
      } catch (err) {
        setError('The API answered, but the dashboard could not render it: ' +
          (err && err.message ? err.message : String(err)) +
          '. The figures below may be incomplete. This is a DASHBOARD fault, not an unreachable API.');
        setStale(true);
      }
    });
}

$('halt').addEventListener('click', function () {
  var s = lastState || {};
  var c = s.cash || {};
  var sup = s.supervisor || {};
  var cur = c.currency || '';
  var ddTxt = (typeof c.drawdownMinor === 'number' && typeof c.maxDrawdownMinor === 'number' && c.maxDrawdownMinor > 0)
    ? money(c.drawdownMinor, cur) + ' of ' + money(c.maxDrawdownMinor, cur)
    : 'unknown';
  var ok = window.confirm(
    'HALT THE SWARM?\\n\\n' +
    'Current state: cash ' + money(c.onHandMinor, cur) + ' · drawdown ' + ddTxt +
    ' · tick ' + String(sup.tick === undefined ? '—' : sup.tick) + '\\n\\n' +
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
    .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j || {} }; }); })
    .then(function (o) {
      /* The server's \`message\` is the one sentence that tells an operator how to
         halt OUT OF BAND when the token is missing. Printing only \`error\`
         ("unauthorized") made them conclude the emergency control was broken. */
      $('haltmsg').textContent = o.s === 200
        ? (o.j.alreadyHalted ? 'Already halted. ' : '') + (o.j.message || 'halted')
        : 'refused (' + o.s + '): ' + (o.j.message || o.j.error || 'unknown');
      poll();
    })
    .catch(function (e) {
      $('haltmsg').textContent = 'request failed: ' + (e && e.message ? e.message : String(e)) +
        '. Halt out of band instead: create the HALT file in the data directory (touch ./var/HALT).';
    });
});

setInterval(tickFooter, 1000);
poll();
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
  --ok:#0a7a3d; --warn:#9a6400; --bad:#b3261e; --quar:#6f3bb5; --accent:#1a4fa0;
  --paper:#7a4d00; --paperbg:#ffe9b8;
  /* Text ON a --bad fill. White on the DARK-mode --bad is ~2.8:1 — below AA for
     13px bold — and the two elements painted that way are the STALE banner and
     the emergency HALT button: the least readable things in the scheme a phone
     uses at 3am. This token fixes both without touching light mode (~6:1). */
  --onbad:#ffffff;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0e1013; --panel:#171a1f; --line:#2b3138; --fg:#e6e9ed; --muted:#98a2ad;
    --ok:#4ec77f; --warn:#e0a83a; --bad:#ff6b5e; --quar:#c9a0ff; --accent:#7aa7ff;
    --paper:#ffd479; --paperbg:#3a2c08;
    --onbad:#1a0906; /* ~9:1 on #ff6b5e */
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace}
header{padding:10px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
h1{font-size:14px;margin:0 0 6px;letter-spacing:.06em}
.banner{padding:6px 10px;border-radius:4px;font-weight:700;letter-spacing:.04em}
.banner.paper{background:var(--paperbg);color:var(--paper);border:1px solid var(--paper)}
.banner.bad{background:var(--bad);color:var(--onbad);border:1px solid var(--bad)}
#err{margin:8px 12px 0;padding:8px 10px;border:1px solid var(--bad);color:var(--bad);border-radius:4px}
main{padding:12px;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;min-width:0}
section.wide{grid-column:1/-1}
h2{font-size:11px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.big{font-size:20px;font-weight:700;overflow-wrap:anywhere}
.meta,.muted{color:var(--muted)}
.ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .quar{color:var(--quar)}
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
.summary{margin:0 0 6px;font-size:12px}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
input,button{font:inherit;border-radius:4px;border:1px solid var(--line);
  background:var(--bg);color:var(--fg);padding:5px 8px}
button{background:var(--bad);color:var(--onbad);border-color:var(--bad);cursor:pointer;font-weight:700}
button[disabled]{background:var(--line);color:var(--muted);border-color:var(--line);cursor:not-allowed}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
footer{padding:10px 12px;color:var(--muted);border-top:1px solid var(--line)}
footer .bad{color:var(--bad);font-weight:700}
/* A failed OR HUNG poll dims every figure and appends "(STALE)" to the headline
   numbers, so a body scrolled past the header banner still says so. */
body.stale .big,body.stale table,body.stale .meta{opacity:.45}
body.stale .big::after{content:" (STALE)";font-size:11px;letter-spacing:.08em}
@media (max-width:520px){
  main{padding:8px;gap:8px} .big{font-size:17px}
  /* At 360px only the first few columns are visible without scrolling, so the
     COLUMN ORDER itself puts status/net/verdict there (see <thead>); the tail
     columns shrink rather than pushing them further right. */
  .agents th,.agents td{padding:4px 3px}
  .agents .c-role,.agents .c-strategy{font-size:10px}
}
</style>
</head>
<body>
<header>
  <h1>ARES — AUTONOMOUS REVENUE &amp; ENFORCEMENT SWARM</h1>
  <div id="banner" class="banner paper">MODE: PAPER — simulated funds only</div>
</header>
<div id="err" role="alert" hidden></div>
<main>
  <section>
    <h2>Kill switch</h2>
    <div id="ks" class="big" aria-live="polite">…</div>
    <div id="kswhen" class="meta"></div>
    <div id="ksreason" class="meta">waiting for /api/state</div>
  </section>
  <section>
    <h2>Drawdown vs limit</h2>
    <div id="dd" class="big">…</div>
    <div id="ddtrack" class="track"><div id="ddbar" class="bar"></div></div>
    <div id="ddmeta" class="meta"></div>
  </section>
  <section>
    <h2>Cash on hand</h2>
    <div id="cash" class="big">…</div>
    <div id="cashmeta" class="meta"></div>
  </section>
  <section>
    <h2>Tick</h2>
    <div id="tick" class="big">…</div>
    <div id="tickmeta" class="meta"></div>
  </section>

  <section class="wide">
    <h2>Agents</h2>
    <p id="agentsummary" class="summary muted">…</p>
    <div class="scroll">
      <table class="agents">
        <thead><tr><th scope="col">id</th><th scope="col" class="c-status">status</th>
          <th scope="col" class="num c-net">net</th><th scope="col" class="c-verdict">verdict</th>
          <th scope="col" class="c-role">role</th><th scope="col" class="c-strategy">strategy</th>
          <th scope="col" class="num">crashes</th><th scope="col" class="num">holdings</th></tr></thead>
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
  <section>
    <h2>Ledger balances</h2>
    <ul id="balances"></ul>
  </section>

  <section class="wide">
    <h2>Recent ledger <span id="ledgerhead" class="meta"></span></h2>
    <div class="scroll">
      <table>
        <thead><tr><th scope="col" class="num">seq</th><th scope="col" class="num">tick</th>
          <th scope="col">type</th><th scope="col">agent</th><th scope="col">legs</th></tr></thead>
        <tbody id="ledger"><tr><td colspan="5" class="muted">…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="wide">
    <h2>Halt — irreversible</h2>
    <p class="meta">Tripping the kill switch is IRREVERSIBLE: it is a ONE-WAY latch and cannot be
    undone while this process lives. Every agent stops trading at once and the process must be restarted to resume.
    Requires the operator token when one is configured. With no token configured, halt out of band
    instead by creating the HALT file in the data directory: <span class="mono">touch ./var/HALT</span>.</p>
    <p><label class="vh" for="token">Operator token</label>
    <input id="token" type="password" placeholder="operator token" autocomplete="off" size="28">
    <button id="halt" type="button">HALT THE SWARM</button></p>
    <p id="haltmsg" class="meta" role="status"></p>
  </section>
</main>
<footer><span id="updated">loading…</span> · polls /api/state every ${String(DASHBOARD_POLL_MS / 1000)}s
 · each poll times out after ${String(DASHBOARD_FETCH_TIMEOUT_MS / 1000)}s · no external requests</footer>
<script src="/dashboard.js"></script>
</body>
</html>
`;
}
