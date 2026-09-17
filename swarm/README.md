# ARES — Autonomous Revenue & Enforcement Swarm

A small, auditable multi-agent system that trades against a **simulated** market,
keeps double-entry books in a hash-chained append-only ledger, and terminates its
own agents when they fail to earn. It is a study in governance and auditability:
a kill switch, a budget governor, a compliance gate, a drawdown brake and a
survival rule, wired into a loop that is meant to survive weeks unattended.

## PAPER mode only — read this first

**ARES runs in PAPER mode and nothing else.** Every market, price, fill and fee
comes from a deterministic simulator in `src/channels/`. No real funds move, no
real order is ever placed, and no real exchange, marketplace or payment provider
is contacted. `ARES_MODE` accepts exactly one value, `PAPER`; any other value
makes the process refuse to start. LIVE execution is a *declared-but-refused*
path — see [What live execution would require](#what-live-execution-would-require).

The numbers on the dashboard and in `/api/report` are the output of a simulation.
They are **not evidence of profitability** and must not be presented as a track
record. A profitable run here means the simulator's parameters were favourable,
nothing more — and the parameters are chosen by us, in
[`src/channels/simulator.ts`](src/channels/simulator.ts), not observed anywhere.

Read [Can a channel actually lose money?](#can-a-channel-actually-lose-money)
before quoting any figure this system produces. A simulated market that omits a
real cost does not produce an optimistic result; it produces a meaningless one.

Zero runtime dependencies. Node 22+, TypeScript, `node:` builtins only.

---

## Quickstart

### Local

```sh
cd swarm
npm install          # typescript + @types/node, dev only
npm run build
npm test
cp .env.example .env

# Set an operator token, or the red HALT button on the dashboard answers 401.
# Skipping this is a valid choice — but then you MUST know the halt below.
echo "ARES_API_TOKEN=$(openssl rand -hex 32)" >> .env

npm start
```

Then open <http://127.0.0.1:8787/>.

**Halt it.** Two ways, and you should try the second one now rather than at 3am:

```sh
curl -X POST -H "Authorization: Bearer $ARES_API_TOKEN" http://127.0.0.1:8787/api/halt
touch ./var/HALT     # works with NO token at all; the watcher trips within a second
```

Both are **irreversible for the life of the process**. See [Halting](#halting).

A short, loud run you can watch:

```sh
ARES_TICK_MS=1000 ARES_LOG_LEVEL=info ARES_DATA_DIR=./var npm start
```

Stop it with Ctrl-C. It finishes the tick in flight, drains the bus, flushes
every memory store, verifies the ledger and exits 0. A second Ctrl-C forces the
process down immediately.

### Docker

```sh
cd swarm
cp .env.example .env
echo "ARES_API_TOKEN=$(openssl rand -hex 32)" >> .env   # REQUIRED under compose
docker compose up --build
```

The token is **not optional here**, and compose stops with an error naming it if
it is missing. Inside the container the process binds `0.0.0.0` — the `ports:`
mapping is what restricts access, and it publishes to host loopback only — and
ARES refuses to start an unauthenticated non-loopback API. `cp .env.example .env
&& docker compose up --build` used to build an image and then crash-loop on that
refusal forever; now it fails immediately, before anything starts, with the
reason.

Do **not** "fix" that by setting `ARES_API_HOST=127.0.0.1` in the container. That
binds the process to the *container's* loopback, which the published port cannot
reach: you get a running container with an unreachable dashboard. The healthcheck
probes the container's own routable address precisely so that this shows up as
`unhealthy` instead of green.

`restart: on-failure:5`, deliberately not `unless-stopped`: a corrupt ledger, a
bad config or a missing token is a permanent failure, and restarting forever
turns a loud crash into a silent loop nobody looks at.

The API is published to `127.0.0.1:8787` on the host only. State (ledger, memory
stores, snapshots) lives in the `ares-var` volume and survives restarts. The
container runs as the unprivileged `node` user with a read-only root filesystem,
all capabilities dropped and a 512 MB memory limit. Only `/app/var` is owned by
that user: `/app/dist` stays root-owned, so a file-write primitive cannot become
code execution on the next restart.

To halt a running container without a token:

```sh
docker compose exec ares sh -c 'touch /app/var/HALT'
```

---

## Configuration

Every variable, its default, and what it does. All of them are optional; the
defaults are what you get with no `.env` at all. Money is always an **integer
count of minor units** (halalas/cents): `100000` is SAR 1000.00.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARES_MODE` | `PAPER` | Operating mode. Any other value refuses to start. |
| `ARES_SEED` | `1337` | Seed for every random stream; the same seed replays the same run. |
| `ARES_BASE_CURRENCY` | `SAR` | `SAR` or `USD`. |
| `ARES_TICK_MS` | `5000` | Milliseconds between ticks (minimum 250). Drift-corrected. |
| `ARES_DATA_DIR` | `./var` | Ledger, memory stores, snapshots and the `HALT` file. |
| `ARES_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. JSON lines on stdout. |
| `ARES_SNAPSHOT_EVERY` | `20` | Ticks between state snapshots + memory flush. `0` disables. |
| `ARES_API_HOST` | `127.0.0.1` | API bind address. Non-loopback without a token **refuses to start**. |
| `ARES_API_PORT` | `8787` | API/dashboard port. |
| `ARES_API_TOKEN` | *(unset)* | Bearer token for mutating routes. Unset ⇒ they are refused outright. |
| `ARES_CASH_CAP` | `100000` | Hard ceiling on cash the swarm may hold. |
| `ARES_STARTING_CASH` | `100000` | Opening cash. Must not exceed `ARES_CASH_CAP`. |
| `ARES_MAX_DRAWDOWN` | `20000` | Loss from the opening balance that halts the swarm. |
| `ARES_AGENT_CASH_CAP` | `25000` | Cash headroom one agent may hold. |
| `ARES_TRADE_CAP` | `5000` | Ceiling on a single trade. Must not exceed the agent cap. |
| `ARES_TOKEN_CAP` | `2000000` | Swarm-wide token budget. |
| `ARES_AGENT_TOKEN_CAP` | `500000` | Per-agent token budget. Must not exceed the global cap. |
| `ARES_TOKEN_PRICE` | `1875` | Minor units charged per million tokens (the `compute` account). |
| `ARES_WINDOW_TICKS` | `20` | Ticks per survival evaluation window. |
| `ARES_GRACE_WINDOWS` | `2` | Windows of cold-start immunity before an agent can be judged. |
| `ARES_MIN_SAMPLES` | `8` | Outcomes required before a verdict is statistically meaningful. |
| `ARES_PROBATION_WINDOWS` | `1` | Consecutive failing mature windows before TERMINATE. |
| `ARES_MIN_NET` | `0` | Net cash flow an agent must clear in a window to PASS. |
| `ARES_MAX_ACTIONS` | `4` | Guarded actions per agent per tick. |
| `ARES_MAX_HOPS` | `6` | Causal hops before a bus message is dropped. |
| `ARES_MAX_QUEUE` | `1000` | Bus queue depth at which publishes are dropped. |
| `ARES_REPEAT_WINDOW` | `12` | Ticks the bus loop guard looks back over. |
| `ARES_REPEAT_THRESHOLD` | `4` | Identical messages in that window before the loop guard drops them. |
| `ARES_RATE_PER_MIN` | `120` | Rate limit on simulated channel calls, per agent, per minute. |
| `ARES_TICK_WATCHDOG_MS` | `20000` | A longer tick warns; **three consecutive** overruns halt the swarm. |
| `ARES_MAX_CRASHES` | `3` | Crashes before the supervisor quarantines an agent. |
| `ARES_CHANNELS` | `dataproducts,digitalassets,ksa_ecom` | Channel allow-list, still policy-gated at boot. |

### The zero-tolerance survival policy

The operator's rule is "an agent that does not make money dies". It is
implemented literally, and you can remove every guard around it:

```sh
ARES_GRACE_WINDOWS=0
ARES_MIN_SAMPLES=0
ARES_PROBATION_WINDOWS=0
```

The trade-off is evidence, not leniency. With zero grace and zero minimum
samples the very first window is judged on whatever happened to land in it, so an
agent whose strategy is sound but whose first sale settles one tick late is
terminated on noise before it has produced a single comparable data point. The
defaults (2 grace windows, 8 samples, 1 probation window) enforce exactly the
same rule, but only once the verdict is based on enough evidence to mean
anything.

### Channels are gated, and one of them is sell-only

`ksa_ecom` is a **SELL-ONLY** channel. Its assumed terms of service require a
human to approve every purchase, ARES has no human in the loop, and so the
adapter offers no automated buy path at all: it declares `canBuy: false`, and
`KsaEcomAdapter.buy()` throws `PolicyDenied` unconditionally — before the
init/ready check, and without reading its own capability flags, so the refusal
survives those flags being mutated. It is admitted at boot, and its sell path,
SAR pricing and VAT handling do run.

It did **not** used to. It declared `canBuy: true` *and*
`buyRequiresHumanApproval: true`, which the policy engine correctly read as an
internally inconsistent capability set and used to reject the whole adapter:

```json
{"level":"warn","msg":"boot.channel_rejected","meta":{"channel":"ksa_ecom","code":"POLICY_CHANNEL_APPROVAL_UNAVAILABLE"}}
```

The gate was right; the declaration was wrong. The cost of the wrong declaration
was that the headline Saudi capability — the VAT arithmetic, the SAR-only
pricing, the VAT-inclusive display convention — was unreachable dead code behind
an accurate-looking channel name, and the VAT code you would most want exercised
was the least exercised code in the repository. The gate itself is unchanged: an
adapter that genuinely claims `canBuy` while its own ToS note requires a human
per purchase is still refused, and the denial now names the remedy.

**A sell-only channel has no automated way to acquire stock.** In a default run
the swarm therefore has no inventory to list on `ksa_ecom` and it produces no
sales. That is the honest consequence of having no human in the loop, not a bug,
and it is not papered over by minting free physical inventory. The channel's
sell and VAT paths are exercised by `test/channels.test.ts` and
`test/simulator.test.ts` instead.

Booting with **no** usable channel left is a hard failure
(`BOOT_NO_USABLE_CHANNELS`) — an idle swarm that reports healthy is worse than
one that refuses to start.

### Can a channel actually lose money?

This is the only question that decides whether a reported profit means anything.

| Channel | Acquisition | Per-order costs | Can a listing lose money? |
| --- | --- | --- | --- |
| `dataproducts` | minted at zero cost | listing fee, delivery, payment fee, platform overhead | **Yes** |
| `digitalassets` | bought, commission both legs | listing fee, payment fee, platform overhead | **Yes** |
| `ksa_ecom` | none (sell-only) | listing fee, **fulfilment**, packaging, payment fee, platform overhead, **VAT** | **Yes** |

It has not always been yes. Until recently `dataproducts` minted at `unitCost 0`
with `listingFee 0` and `buyCommission 0`, so the seller's floor rule — *refuse
any listing that cannot clear cost of goods plus fees* — reduced to
`price >= 9% of price`, which is true for every price. A listing on that channel
was **structurally incapable of losing money**, and it was the channel that
produced essentially all of the swarm's reported profit.

What is charged now, in the fill path, itemised on every `SimFill`:

- **commission** on the gross;
- **fulfilment**, once per order — the shipping label;
- **packaging**, per unit;
- **payment processing**, bps of gross plus a flat per-order charge;
- **platform overhead**, accrued every tick the channel is registered whether or
  not anything sells, and collected at the next transaction;
- **VAT**, *deducted*, not merely displayed: `proceeds = gross − VAT −
  fees × (1 + VAT rate)`. The swarm used to book money owed to the tax authority
  as profit.

At `ksa_ecom`'s SAR 32–65 price band a single SAR 50.00 order carries SAR 29.50
of seller cost (59% of gross) and SAR 40.45 of total deductions including VAT
(81%). The break-even gross for an order with **zero** cost of goods is about
SAR 37 — inside the channel's own price band, so part of the assortment cannot be
sold at a profit at any margin.

Two more things stopped being free. Stock ages: a SKU's long-run value drifts
down every tick and can collapse permanently, so "wait for the mean to come
back" is no longer a strictly dominant strategy. And a dud is a dud: whether a
listing is dead is drawn **once per SKU** at registration, not per listing, so a
fixed slice of the assortment never sells however often it is relisted. The old
per-listing draw gave a 0.006% chance of six consecutive duds, which taught
"relist and it will sell" — the opposite of the real lesson.

Settlement was raised roughly tenfold (20–45 ticks). Real cash conversion is
90–150 days; the previous 2–5 ticks let a naive strategy recycle capital almost
instantly, which the simulator's own comment called "exactly the unrealistic
behaviour this simulator exists to deny".

**What this did to the reported result.** Same seed, same agents, 400 ticks,
`ARES_SEED=1337`: the swarm used to finish **+SAR 602.63** on SAR 1,000 of
starting capital, 96.6% of it from `dataproducts`. With the costs above it
finishes **−SAR 203.91** and is halted by the drawdown brake. Seeds 777, 20 and
4242 move the same way (+506.35 → −62.80, +600.85 → −168.85, +641.95 → −203.20).
Every profitable result this project produced before that change was an artefact
of costs the model did not charge.

---

## API

All routes are served by `node:http` with no framework. Every response carries
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store` and a restrictive
`Content-Security-Policy`. There are **no CORS headers** by design.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | The dashboard (HTML). |
| GET | `/dashboard.js` | The dashboard's script, served separately so the CSP needs no inline-script exemption. |
| GET | `/healthz` | Liveness. 200 while the process answers, halted or not. |
| GET | `/readyz` | Readiness. 503 when the loop is not running or the swarm is halted. |
| GET | `/metrics` | Prometheus text exposition (v0.0.4). |
| GET | `/api/state` | Everything the dashboard renders. |
| GET | `/api/agents` | Per-agent rows: status, net, verdict, crashes, holdings. |
| GET | `/api/ledger?limit=` | Recent ledger entries. Default 100, **hard maximum 1000**. |
| GET | `/api/report` | A digest: balances, verdicts, verification, with the PAPER disclaimer. |
| GET | `/api/policy` | Policy statistics, denials by rule, and the retained decision trail. |
| POST | `/api/halt` | Trip the kill switch. Requires `Authorization: Bearer <token>`. |

A wrong method returns **405** with an `Allow` header; an unknown route returns
**404** as JSON, identically whether or not you present a credential.

### Halting

`POST /api/halt` is **irreversible**. The kill switch is a one-way latch: nothing
un-trips it for the life of the process, every agent stops trading at the next
phase boundary, and the only way to resume is to restart.

```sh
curl -X POST -H "Authorization: Bearer $ARES_API_TOKEN" http://127.0.0.1:8787/api/halt
```

The token is compared with `crypto.timingSafeEqual` over SHA-256 digests, so
neither its value nor its length leaks through response timing. **When no token
is configured, mutating routes are refused outright — even on loopback.** The
out-of-band halt is then the file:

```sh
touch ./var/HALT      # the watcher trips the kill switch within a second
```

The dashboard prints the server's own explanation when a halt is refused,
including the sentence naming that file — so an operator who has not configured
a token is told what to do instead of reading `unauthorized` and concluding the
emergency control is broken.

### How do I find out WHEN it halted?

The halt time is on the dashboard, next to the kill-switch state, absolute and
relative: `HALTED at 17/09/2026, 04:12:33 (5h 18m ago)`. Four minutes and
eighteen hours are very different situations and the page now distinguishes
them. It is also in the API:

```sh
curl -s http://127.0.0.1:8787/api/state | grep -o '"killSwitch":{[^}]*}'
# {"killSwitch":{"tripped":true,"reason":"max drawdown breached: 20391 > 20000","trippedAt":1758...}}
```

`trippedAt` is epoch milliseconds from the injected clock. The footer's
"updated HH:MM:SS" is the **client's** clock at the last successful poll — it is
how fresh the page is, never when anything happened — and it now ages visibly
("updated 09:30:14 (4s ago)") and reddens once it is more than a few poll
intervals old.

The halt is also in the logs (`api.halted`, or the reason recorded by whichever
governor tripped it) and in the ledger, which keeps its own tick-stamped record
of everything that happened up to it.

---

## Reading the dashboard

The page polls `/api/state` every three seconds, and each poll is aborted after
2.5 seconds. It follows `prefers-color-scheme`, loads no CDN, no external font
and makes no request to anything but this API.

**On staleness.** A poll that fails *or hangs* dims every figure on the page,
appends `(STALE)` to the headline numbers, reddens the banner and changes the
browser tab title to `STALE — ARES`. It does this in the `<main>` body, not only
in a header banner an operator on a phone has already scrolled past. Only one
poll is ever in flight, and an older response can never overwrite a newer one.

This used to be less true than the sentence here claimed. `fetch()` had no
timeout, so a socket that accepted and never answered left the promise pending
forever: the failure handler never ran, the banner never reddened, requests
stacked every three seconds, and the page showed `LIVE` beside stale cash
indefinitely. A hung API is more dangerous than a dead one, because it looks
exactly like a healthy one.

**At phone width** the layout reflows to a single column and everything is
readable, but the Agents table is eight columns inside a horizontal scroller. The
columns you need — status, net, verdict — are ordered first so they are visible
without scrolling, and there is a one-line summary above it
(`4 agents · 3 active · 0 probation · 0 quarantined · 1 terminated`) so "did
anything get terminated?" never requires scrolling sideways at all.

- **PAPER banner** (top). If it ever says anything else, stop and investigate.
  On a halt this banner is replaced by the halt itself — reason and time — and
  the tab title becomes `HALTED — ARES`.
- **Kill switch** — `LIVE` or `HALTED`, with the halt reason.
- **Tick** — the current tick, plus ticks executed, **ticks skipped** (a tick
  that overran its interval; the loop resumes at the tick that is due now rather
  than firing a catch-up burst), the last tick's duration and the watchdog
  overrun count.
- **Cash on hand** against starting cash, and **drawdown against its limit** with
  a bar. When that bar fills, the Treasury halts the swarm.
- **Agents** — id, status (`active` / `probation` / `quarantined` /
  `terminated`), realised net cash flow, survival verdict, role, strategy, crash
  count and holdings. Hover or tap a verdict for the Treasury's reason.

  The verdicts are:

  | Verdict | Meaning |
  | --- | --- |
  | `PASS` | judged, and it cleared `ARES_MIN_NET` in the window |
  | `PROBATION` | judged, and it failed a mature window; one more and it is out |
  | `TERMINATE` | judged, and the Treasury has ended it |
  | `IMMATURE` | **too early**: the window has not closed, or there are fewer than `ARES_MIN_SAMPLES` outcomes |
  | `EXEMPT` | the Treasury does not judge itself |
  | `UNJUDGED` | **no verdict has been recorded at all** |

  `UNJUDGED` is the one to be careful with. It is shown before the first window
  closes — and it is shown *forever* if no Treasury is wired to do the judging.
  It does not mean "fine so far"; it means nobody has looked. If every agent
  reads `UNJUDGED` after several windows, check that a treasury agent is running
  before you read the run as healthy.
- **Bus** and its **drop counts by reason** (`max_hops`, `queue_full`,
  `loop_guard`, `closed`). Anything but zero here is worth reading the logs over.
- **Policy** — allowed/denied totals and denials by rule.
- **Recent ledger** — the newest entries with their legs, which always sum to
  zero. Leg amounts are shown in the same units as the Cash tile (`cash +SAR
  125.00`, not `cash +12500`): they used to be printed as raw minor units beside
  a Cash tile in riyals, a 100x misread in the exact panel used to reconstruct a
  loss.
- **Ledger balances** — the account totals `/api/state` already carries.

`quarantined` means the supervisor stopped ticking an agent after
`ARES_MAX_CRASHES` failures. It is **not** termination: liquidating inventory,
reallocating budget and spawning a successor remain the Treasury's decisions,
taken from the books rather than from a crash counter.

---

## Verifying the ledger

`${ARES_DATA_DIR}/ledger.jsonl` is append-only, hash-chained and double-entry.
Every entry's legs sum to zero and every entry's `prevHash` is its predecessor's
`hash`. The chain is verified when the ledger is opened, once per tick by the
Treasury agent, and once more during shutdown — a broken chain trips the kill
switch.

From the running process:

```sh
curl -s http://127.0.0.1:8787/api/report | grep -o '"verified":[a-z]*'
```

From a stopped one:

```sh
node --input-type=module -e "
import {Ledger} from './dist/src/core/ledger.js';
import {systemClock} from './dist/src/core/clock.js';
import {nullLogger} from './dist/src/core/logger.js';
const l = Ledger.open('./var', systemClock, nullLogger);
console.log('entries', l.size(), 'verify', JSON.stringify(l.verify()));
const b = l.balances();
console.log('balances', b, 'sum', Object.values(b).reduce((a,x)=>a+x,0));
l.close();"
```

`sum` must be `0`. If `Ledger.open` throws `LEDGER_CHAIN_BROKEN` or
`LEDGER_TRUNCATED`, the file was tampered with or the process died mid-append;
do not "repair" it — keep it as evidence and start a new data directory.

---

## What live execution would require

Live execution is **deliberately not implemented**. There is no code path to a
real broker, marketplace or payment rail, and adding one is not a matter of
flipping `ARES_MODE`. What stands between this and a system allowed to move real
money is not engineering effort but obligations this project does not discharge:

- **Legal and regulatory standing.** Placing orders for value is a regulated
  activity in essentially every jurisdiction ARES's channels name. Before any
  live path exists, someone must establish which licence or registration applies
  (in Saudi Arabia, that means the relevant CMA/SAMA determination for the
  activity in question), and hold it.
- **Terms of service, per venue, in writing.** The `ksa_ecom` adapter
  demonstrates the general case and also the limit of what this repository
  knows: its ToS note is an **unverified generalisation**. It names no platform,
  cites no clause and carries no date, and it is labelled as such in the code.
  Nor is the selling side unconditional — merchant APIs typically require an
  approved account and a named human operator, impose rate limits and
  listing-content rules, and some programmes prohibit automated repricing
  outright. Each venue needs an explicit, current, human-read authorisation for
  automated access — an API key is not permission.
- **KYC/AML and sanctions screening** on counterparties and on the funding
  source, with records an auditor can inspect.
- **Tax treatment** decided in advance: VAT on Saudi e-commerce sales, income and
  withholding treatment of the proceeds, and the invoicing (ZATCA e-invoicing)
  that goes with them. The VAT rate in `ksa_ecom` is a **configuration
  parameter** (`params.vatRateBps`) labelled in code as an assumption pending
  legal review. Nothing here asserts a statutory rate. The simulator does now
  *deduct* it in the fill path rather than merely display it, which is the
  arithmetic being right, not the rate being confirmed.
- **A human accountable for the money.** Every governance control here — the
  drawdown brake, the kill switch, the per-trade cap — is designed to make an
  autonomous process *fail safe*, not to make it *unsupervised*. A live system
  needs a named person who can be reached, who monitors it, and who is
  answerable for what it does.
- **Custody, settlement and reconciliation** against a real account, including
  what happens to open positions when the process dies mid-trade. ARES's ledger
  is internally consistent; it has never been reconciled against a bank.
- **Consumer-facing duties** if it ever sells to the public: refunds, disputes,
  warranties, data protection for buyer data.

None of that is in scope, none of it is stubbed, and the refusal is enforced in
code rather than left to discipline: `ARES_MODE` accepts only `PAPER`, the policy
engine denies by default, and every channel adapter is a simulator.

---

## Layout

```
src/core/       errors clock rng money ids hash logger config types ledger
src/bus/        protocol bus
src/governance/ budget killswitch circuit policy survival
src/memory/     store learning
src/agents/     base registry scout seller treasury
src/channels/   adapter simulator dataproducts digitalassets ksa_ecom
src/runtime/    supervisor orchestrator
src/api/        server dashboard
src/index.ts    entry point
var/            runtime state (gitignored): ledger.jsonl, memory/, snapshots/
```

The tick has three phases in a fixed order — **scouts, then sellers, then the
Treasury last**, so the auditor always sees the whole tick's activity. The kill
switch is re-read before every phase, not once per tick, so a halt raised by the
scouts stops the sellers and the Treasury in the same tick.
