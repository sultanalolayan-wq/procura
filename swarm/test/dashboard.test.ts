/**
 * test/dashboard.test.ts — the operations console is the only thing an operator
 * reads at 3am, so its failure modes are audited here rather than by eye.
 * Everything below is a property of the SHIPPED strings: the page and the client
 * script are static exports, so they can be asserted without a browser.
 * Callers: none. This file pins behaviour, it does not provide any.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_JS,
  DASHBOARD_POLL_MS,
  DASHBOARD_FETCH_TIMEOUT_MS,
  DASHBOARD_BACKOFF_AFTER,
  renderDashboardHtml,
} from '../src/api/dashboard.js';

const HTML = renderDashboardHtml('test-nonce');

/* ---------------------------------------------------------------- preserved */

test('PRESERVED: no inline script, no external reference, the nonce is on the style block only', () => {
  // The style.width write is CSSOM, not a style= attribute, so a nonce CSP is
  // enough and 'unsafe-inline' must never appear.
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(HTML), false, 'an inline <script> would need a CSP hole');
  assert.match(HTML, /<script src="\/dashboard\.js"><\/script>/);
  assert.equal(/https?:\/\//.test(HTML), false, 'no CDN, no external font, no outbound request');
  assert.equal(/https?:\/\//.test(DASHBOARD_JS), false);
  assert.equal(HTML.includes('unsafe-inline'), false);
  assert.equal(DASHBOARD_JS.includes('style="'), false, 'no style attribute: CSSOM only');
  assert.match(DASHBOARD_JS, /\.style\.width/);
  assert.match(HTML, /<style nonce="test-nonce">/);
});

test('PRESERVED: every state is TEXT, never colour alone', () => {
  for (const word of ['HALTED', 'LIVE', 'STOPPED (not halted)', 'STALE']) {
    assert.ok(DASHBOARD_JS.includes(word), `${word} must appear as text`);
  }
  // The agent summary prints the count AND the status name, not a coloured dot.
  assert.match(DASHBOARD_JS, /esc\(counts\[k\]\) \+ ' ' \+ esc\(k\)/);
});

test('PRESERVED: explicit empty states for every collection', () => {
  for (const empty of [
    'no agents registered',
    'no messages dropped',
    'no policy denials in the retained window',
    'no channels',
    'the ledger is empty',
  ]) {
    assert.ok(DASHBOARD_JS.includes(empty), `missing empty state: ${empty}`);
  }
});

test('PRESERVED: money() returns an em-dash for a non-number', () => {
  assert.match(DASHBOARD_JS, /if \(typeof minor !== 'number' \|\| !isFinite\(minor\)\) return '—';/);
});

test('PRESERVED: the halt confirmation keeps a real button, a real confirm and a plain-language consequence', () => {
  assert.match(HTML, /<button id="halt" type="button">/);
  assert.match(DASHBOARD_JS, /window\.confirm\(/);
  assert.match(DASHBOARD_JS, /IRREVERSIBLE/);
  assert.match(DASHBOARD_JS, /one-way/);
  assert.match(DASHBOARD_JS, /latch and nothing can un-trip it/);
  // Not made more tedious: one confirm, no typed phrase, no second dialog.
  assert.equal((DASHBOARD_JS.match(/window\.confirm\(/g) ?? []).length, 1);
  assert.equal(/window\.prompt\(/.test(DASHBOARD_JS), false, 'a typed confirmation would be the wrong friction');
});

/* --------------------------------------------------------------------- P0-1 */

test('P0-1 a poll cannot hang forever, cannot stack, and cannot be overtaken', () => {
  assert.ok(DASHBOARD_FETCH_TIMEOUT_MS > 0 && DASHBOARD_FETCH_TIMEOUT_MS < DASHBOARD_POLL_MS);
  assert.match(DASHBOARD_JS, /AbortSignal\.timeout\(TIMEOUT_MS\)/);
  assert.match(DASHBOARD_JS, /if \(inFlight\) \{ schedule\(\); return; \}/);
  assert.match(DASHBOARD_JS, /inFlight = true;/);
  assert.match(DASHBOARD_JS, /inFlight = false;/);
  // Response sequencing: an older response must never overwrite a newer one.
  assert.match(DASHBOARD_JS, /var mySeq = \+\+seq;/);
  assert.match(DASHBOARD_JS, /if \(mySeq <= renderedSeq\) return null;/);
  // And the page no longer claims something it cannot deliver.
  assert.match(HTML, /times out after/);
});

test('P1-7 a dead API is not hammered every 3s forever', () => {
  assert.ok(DASHBOARD_BACKOFF_AFTER >= 1);
  assert.match(DASHBOARD_JS, /fails >= BACKOFF_AFTER/);
  assert.match(DASHBOARD_JS, /Math\.min\(POLL_MS \* 10/);
  // The old unconditional setInterval(poll, POLL_MS) is gone.
  assert.equal(/setInterval\(poll,/.test(DASHBOARD_JS), false);
});

/* --------------------------------------------------------------------- P0-2 */

test('P0-2 a failed poll marks the BODY stale, not only a header banner', () => {
  assert.match(DASHBOARD_JS, /document\.body\.classList\.add\('stale'\)/);
  assert.match(DASHBOARD_JS, /document\.body\.classList\.remove\('stale'\)/);
  assert.match(DASHBOARD_JS, /document\.title = 'STALE — ARES'/);
  // The CSS has to actually do something with it, inside <main>.
  assert.match(HTML, /body\.stale \.big[^}]*opacity/);
  assert.match(HTML, /body\.stale \.big::after\{content:" \(STALE\)"/);
});

/* --------------------------------------------------------------------- P0-3 */

test('P0-3 the halt TIME is rendered, absolute and relative', () => {
  assert.match(DASHBOARD_JS, /ks\.trippedAt/);
  assert.match(DASHBOARD_JS, /function rel\(ms\)/);
  assert.match(DASHBOARD_JS, /function stamp\(ms\)/);
  assert.match(DASHBOARD_JS, /'HALTED at ' \+ when/);
  assert.match(DASHBOARD_JS, /ago/);
  assert.match(HTML, /id="kswhen"/);
  // rel() must degrade rather than print a bare millisecond count.
  assert.match(DASHBOARD_JS, /'d ' \+ \(h % 24\) \+ 'h'/);
});

/* --------------------------------------------------------------------- P0-4 */

test('P0-4 ledger legs are rendered as money, at the same scale as the Cash tile', () => {
  // esc(l.amount) printed halalas beside a Cash tile in riyals: a 100x misread
  // in the exact panel used to reconstruct a loss.
  assert.equal(/esc\(l\.amount\)/.test(DASHBOARD_JS), false, 'raw minor units must never be printed');
  assert.match(DASHBOARD_JS, /esc\(smoney\(l\.amount, cur\)\)/);
  // The explicit '+' on a credit survives.
  assert.match(DASHBOARD_JS, /\(minor >= 0 \? '\+' : ''\) \+ money\(minor, cur\)/);
});

/* --------------------------------------------------------------------- P0-5 */

test('P0-5 a halt is the loudest thing on the page, and the hierarchy is fixed', () => {
  assert.match(DASHBOARD_JS, /setBanner\('HALTED — ' \+ ks\.reason/);
  assert.match(DASHBOARD_JS, /document\.title = 'HALTED — ARES'/);
  // The PAPER banner is gated on the mode instead of being hardcoded (P3-16).
  assert.match(DASHBOARD_JS, /s\.mode === 'PAPER'/);
  assert.match(DASHBOARD_JS, /NOT PAPER\. Stop and investigate\./);
  // Section order: Kill switch, Drawdown, Cash, Tick.
  const order = ['Kill switch', 'Drawdown vs limit', 'Cash on hand', 'Tick'].map((h) => HTML.indexOf('<h2>' + h));
  for (const i of order) assert.ok(i > 0, 'every headline section must be present');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'drawdown must outrank cash and tick');
});

/* --------------------------------------------------------------------- P1-6 */

test('P1-6 a refused halt shows the server sentence that says how to halt out of band', () => {
  assert.match(DASHBOARD_JS, /o\.j\.message \|\| o\.j\.error \|\| 'unknown'/);
  // And a transport failure names the file, because that is the fallback.
  assert.match(DASHBOARD_JS, /touch \.\/var\/HALT/);
  assert.match(HTML, /touch \.\/var\/HALT/);
});

/* --------------------------------------------------------------------- P1-8 */

test('P1-8 the STALE banner and the HALT button do not fail contrast in dark mode', () => {
  assert.match(HTML, /--onbad:#ffffff;/);
  assert.match(HTML, /--onbad:#1a0906;/);
  assert.match(HTML, /\.banner\.bad\{background:var\(--bad\);color:var\(--onbad\)/);
  assert.match(HTML, /button\{background:var\(--bad\);color:var\(--onbad\)/);
  // No hardcoded white left on a --bad fill.
  assert.equal(/background:var\(--bad\);color:#fff/.test(HTML), false);
});

/* --------------------------------------------------------------------- P1-9 */

test('P1-9 a MISSING drawdown renders as unknown, never as a safe green zero', () => {
  assert.equal(/c\.drawdownMinor \|\| 0/.test(DASHBOARD_JS), false);
  assert.equal(/c\.maxDrawdownMinor \|\| 1/.test(DASHBOARD_JS), false);
  assert.match(DASHBOARD_JS, /drawdown unavailable — this figure is MISSING, not zero/);
  assert.match(DASHBOARD_JS, /\$\('ddtrack'\)\.hidden = true/);
  // The benign counters keep their `|| 0`: a missing bus counter is not a risk.
  assert.match(DASHBOARD_JS, /bus\.published \|\| 0/);
});

/* -------------------------------------------------------------------- P1-10 */

test('P1-10 "did anything get terminated" is answerable without scrolling sideways', () => {
  assert.match(HTML, /id="agentsummary"/);
  assert.match(DASHBOARD_JS, /agents\.length \+ ' agents'/);
  assert.match(DASHBOARD_JS, /counts\[st\]\+\+/);
  // status / net / verdict come before role / strategy in the table itself.
  const head = HTML.slice(HTML.indexOf('<table class="agents">'), HTML.indexOf('</thead>', HTML.indexOf('<table class="agents">')));
  const at = (c: string): number => head.indexOf(c);
  assert.ok(at('c-status') < at('c-role'), 'status must precede role');
  assert.ok(at('c-net') < at('c-role'));
  assert.ok(at('c-verdict') < at('c-strategy'));
  // verdictReason is sent by the API and must not be discarded.
  assert.match(DASHBOARD_JS, /a\.verdictReason/);
  assert.match(DASHBOARD_JS, /title="/);
});

/* ------------------------------------------------------------------- the P2s */

test('P2-11 quarantined, UNJUDGED and a cleanly stopped supervisor are all distinguishable', () => {
  assert.match(DASHBOARD_JS, /if \(s === 'quarantined'\) return 'quar';/);
  assert.match(HTML, /--quar:/);
  assert.match(DASHBOARD_JS, /no verdict has been recorded for this agent/);
  assert.match(DASHBOARD_JS, /too early: the survival window has not closed/);
  assert.match(DASHBOARD_JS, /sup\.running/);
  assert.match(DASHBOARD_JS, /sup\.shuttingDown/);
  assert.match(DASHBOARD_JS, /STOPPED \(not halted\)/);
});

test('P2-12 an unchanged table is not rewritten every three seconds', () => {
  assert.match(DASHBOARD_JS, /function setHtml\(id, html\) \{\s*if \(lastHtml\[id\] === html\) return;/);
  // Every value still goes through esc(): the escaping was never the problem.
  assert.ok((DASHBOARD_JS.match(/esc\(/g) ?? []).length > 20);
});

test('P2-13 the accessibility mechanics an operator relies on are present', () => {
  assert.match(HTML, /<label class="vh" for="token">/);
  assert.match(HTML, /id="err" role="alert"/);
  assert.match(HTML, /id="ks" class="big" aria-live="polite"/);
  assert.equal((HTML.match(/<th\b(?![^>]*scope=)/g) ?? []).length, 0, 'every <th> needs scope');
  assert.match(HTML, /:focus-visible\{outline:2px solid var\(--accent\)/);
});

test('P2-14 the halt button stops looking available once it has been used', () => {
  assert.match(DASHBOARD_JS, /btn\.disabled = ks\.tripped;/);
  assert.match(DASHBOARD_JS, /'ALREADY HALTED'/);
  assert.match(DASHBOARD_JS, /o\.j\.alreadyHalted \? 'Already halted\. '/);
  // The confirm names the state being halted.
  assert.match(DASHBOARD_JS, /'Current state: cash '/);
  assert.match(HTML, /button\[disabled\]/);
});

test('P2-15 the footer timestamp ages, and reddens once it is clearly stale', () => {
  assert.match(DASHBOARD_JS, /function tickFooter\(\)/);
  assert.match(DASHBOARD_JS, /setInterval\(tickFooter, 1000\)/);
  assert.match(DASHBOARD_JS, /age > POLL_MS \* 3 \? 'bad' : ''/);
  assert.match(DASHBOARD_JS, /s\.uptimeMs/);
});

test('P3-16 a 200 of the wrong shape is reported as a dashboard fault, not an unreachable API', () => {
  assert.match(DASHBOARD_JS, /This is a DASHBOARD fault, not an unreachable API/);
  // The dangling "head " label when the ledger is empty is gone.
  assert.match(DASHBOARD_JS, /\(head \? ' · head ' \+ head\.slice\(0, 16\) : ''\)/);
  // balances were serialised every 3s and never rendered. Now they are rendered.
  assert.match(DASHBOARD_JS, /s\.ledger\.balances/);
  assert.match(HTML, /Ledger balances/);
});

test('a sell-only channel is labelled as such in the channels panel', () => {
  assert.match(DASHBOARD_JS, /sell-only/);
});
