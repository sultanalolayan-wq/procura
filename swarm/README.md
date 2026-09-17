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
nothing more.

Zero runtime dependencies. Node 22+, TypeScript, `node:` builtins only.

---

## Quickstart

### Local

```sh
cd swarm
npm install          # typescript + @types/node, dev only
npm run build
npm test             # 348 tests
cp .env.example .env # then edit
npm start
```

Then open <http://127.0.0.1:8787/>.

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
docker compose up --build
```

The API is published to `127.0.0.1:8787` on the host only. State (ledger, memory
stores, snapshots) lives in the `ares-var` volume and survives restarts. The
container runs as the unprivileged `node` user with a read-only root filesystem,
all capabilities dropped and a 512 MB memory limit.

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

### Channels are gated, and one of them is rejected on purpose

`ksa_ecom` declares that its terms of service require human approval for every
purchase. ARES has no human in the loop, so the policy engine refuses it at boot
and logs the rejection:

```json
{"level":"warn","msg":"boot.channel_rejected","meta":{"channel":"ksa_ecom","code":"POLICY_CHANNEL_APPROVAL_UNAVAILABLE"}}
```

That is the system working, not a misconfiguration. Booting with **no** usable
channel left is a hard failure (`BOOT_NO_USABLE_CHANNELS`) — an idle swarm that
reports healthy is worse than one that refuses to start.

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

---

## Reading the dashboard

The page polls `/api/state` every three seconds. It follows
`prefers-color-scheme`, works at phone width, loads no CDN, no external font and
makes no request to anything but this API. If the API stops answering it turns
the banner red and says so — it never silently shows stale numbers as if they
were fresh.

- **PAPER banner** (top). If it ever says anything else, stop and investigate.
- **Kill switch** — `LIVE` or `HALTED`, with the halt reason.
- **Tick** — the current tick, plus ticks executed, **ticks skipped** (a tick
  that overran its interval; the loop resumes at the tick that is due now rather
  than firing a catch-up burst), the last tick's duration and the watchdog
  overrun count.
- **Cash on hand** against starting cash, and **drawdown against its limit** with
  a bar. When that bar fills, the Treasury halts the swarm.
- **Agents** — id, role, strategy, status (`active` / `probation` /
  `quarantined` / `terminated`), realised net cash flow, survival verdict
  (`PASS` / `PROBATION` / `TERMINATE` / `IMMATURE`, or `EXEMPT` for the
  Treasury), crash count and holdings.
- **Bus** and its **drop counts by reason** (`max_hops`, `queue_full`,
  `loop_guard`, `closed`). Anything but zero here is worth reading the logs over.
- **Policy** — allowed/denied totals and denials by rule.
- **Recent ledger** — the newest entries with their legs, which always sum to zero.

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
- **Terms of service, per venue, in writing.** The `ksa_ecom` adapter already
  demonstrates the general case: a venue whose terms require human approval for
  each purchase cannot be traded by an autonomous agent, whatever the code can
  do. Each venue needs an explicit, current, human-read authorisation for
  automated access — an API key is not permission.
- **KYC/AML and sanctions screening** on counterparties and on the funding
  source, with records an auditor can inspect.
- **Tax treatment** decided in advance: VAT on Saudi e-commerce sales, income and
  withholding treatment of the proceeds, and the invoicing (ZATCA e-invoicing)
  that goes with them.
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
