/**
 * governance/policy.ts — the compliance gate. DENY BY DEFAULT.
 * Invariants: nothing is permitted unless a named rule explicitly allows it;
 * EVERY decision (allow and deny) is appended to a bounded audit ring with the
 * tick, subject, rule id and human-readable reason; a marketplace whose terms
 * of service require a human to approve purchases can never be bought from
 * autonomously. Callers: orchestrator (checkChannel), scout, seller, api.
 */

import { PolicyDenied } from '../core/errors.js';
import { nullLogger, type Logger } from '../core/logger.js';
import type { AresConfig } from '../core/config.js';
import type { Money } from '../core/money.js';
import type { Offer, Opportunity } from '../core/types.js';
import type { ChannelAdapter } from '../channels/adapter.js';
import type { KillSwitch } from './killswitch.js';

export interface PolicyDecision {
  seq: number;
  tick: number;
  subject: string;
  rule: string;
  allowed: boolean;
  reason: string;
  meta: Record<string, unknown>;
}

export interface PolicyOptions {
  /**
   * The kill switch this engine consults. Without one the halt rules cannot be
   * evaluated, so the orchestrator MUST wire it (or call setKillSwitch()).
   */
  killSwitch?: KillSwitch;
  /**
   * Channel through which a human approves purchases. ARES has no human in the
   * loop, so this is null: an adapter that requires approval to buy is refused.
   */
  approvalChannel?: string | null;
  /** Audit ring capacity (a 24/7 process must not grow without limit). */
  maxDecisions?: number;
}

export const DEFAULT_MAX_DECISIONS = 500;

/** Every rule id the engine can cite. Dashboards and tests key off these. */
export const RULES = {
  MODE: 'mode.paper',
  CHANNEL_NAME: 'channel.name',
  CHANNEL_ALLOWED: 'channel.allowed',
  CHANNEL_CAPS: 'channel.capabilities',
  CHANNEL_USELESS: 'channel.no_capability',
  CHANNEL_APPROVAL: 'channel.approval_unavailable',
  CHANNEL_OK: 'channel.allow',
  BUY_KILLSWITCH: 'buy.killswitch',
  BUY_MODE: 'buy.mode',
  BUY_CHANNEL: 'buy.channel_allowed',
  BUY_CAPABILITY: 'buy.capability',
  BUY_HUMAN_APPROVAL: 'buy.human_approval',
  BUY_QTY: 'buy.qty',
  BUY_CURRENCY: 'buy.currency',
  BUY_TOTAL: 'buy.total_positive',
  BUY_TRADE_CAP: 'buy.trade_cap',
  BUY_OK: 'buy.allow',
  SELL_KILLSWITCH: 'sell.killswitch',
  SELL_MODE: 'sell.mode',
  SELL_CHANNEL: 'sell.channel_allowed',
  SELL_CAPABILITY: 'sell.capability',
  SELL_QTY: 'sell.qty',
  SELL_PRICE: 'sell.price',
  SELL_OK: 'sell.allow',
} as const;
export type RuleId = (typeof RULES)[keyof typeof RULES];

/** 'buy.human_approval' -> 'POLICY_BUY_HUMAN_APPROVAL'. */
function codeOf(rule: string): string {
  return `POLICY_${rule.replace(/[.\-]/g, '_').toUpperCase()}`;
}

export class PolicyEngine {
  private readonly ring: PolicyDecision[] = [];
  private readonly cap: number;
  private readonly approvalChannel: string | null;
  private killSwitch: KillSwitch | null;
  private seq = 0;
  private tick = 0;
  private allowedCount = 0;
  private deniedCount = 0;

  constructor(
    private readonly cfg: AresConfig,
    private readonly logger: Logger = nullLogger,
    opts: PolicyOptions = {},
  ) {
    this.cap = opts.maxDecisions !== undefined && opts.maxDecisions > 0 ? Math.floor(opts.maxDecisions) : DEFAULT_MAX_DECISIONS;
    this.approvalChannel = opts.approvalChannel ?? null;
    this.killSwitch = opts.killSwitch ?? null;
  }

  setKillSwitch(ks: KillSwitch): void {
    this.killSwitch = ks;
  }

  /** The tick stamped on subsequent decisions (the supervisor sets it). */
  setTick(tick: number): void {
    if (Number.isSafeInteger(tick) && tick >= 0) this.tick = tick;
  }

  // ------------------------------------------------------------------ gates --

  /** PAPER or nothing. LIVE is a declared-but-refused path. */
  assertMode(tick?: number): void {
    const t = tick ?? this.tick;
    if (this.cfg.mode !== 'PAPER') {
      this.denyAt(t, 'mode', RULES.MODE, `mode ${String(this.cfg.mode)} is refused: ARES executes in PAPER mode only`, {
        mode: this.cfg.mode,
      });
    }
    this.allow(t, 'mode', RULES.MODE, 'PAPER mode confirmed', {});
  }

  /** Gate an adapter before it is ever wired into the swarm. */
  checkChannel(a: ChannelAdapter, tick?: number): void {
    const t = tick ?? this.tick;
    const name = a === null || typeof a !== 'object' ? '' : String(a.name ?? '');
    const subject = name === '' ? '<unnamed>' : name;

    if (name === '') {
      this.denyAt(t, subject, RULES.CHANNEL_NAME, 'adapter has no name', {});
    }
    if (!this.cfg.channels.includes(name)) {
      this.denyAt(t, subject, RULES.CHANNEL_ALLOWED, `channel ${name} is not in the configured channel allow-list`, {
        allowed: [...this.cfg.channels],
      });
    }
    const c = a.capabilities;
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof c.canBuy !== 'boolean' ||
      typeof c.canSell !== 'boolean' ||
      typeof c.buyRequiresHumanApproval !== 'boolean' ||
      typeof c.tosNote !== 'string' ||
      c.tosNote.length === 0 ||
      typeof c.jurisdiction !== 'string' ||
      c.jurisdiction.length === 0
    ) {
      this.denyAt(t, subject, RULES.CHANNEL_CAPS, `channel ${name} declares malformed capabilities (a channel must state canBuy/canSell/buyRequiresHumanApproval plus a ToS note and a jurisdiction)`, {
        capabilities: c as unknown,
      });
    }
    if (!c.canBuy && !c.canSell) {
      this.denyAt(t, subject, RULES.CHANNEL_USELESS, `channel ${name} can neither buy nor sell`, {});
    }
    // The rule is about an INTERNALLY INCONSISTENT capability set, not about the
    // channel as a whole. An adapter that declares canBuy while its own ToS note
    // says every purchase needs a human, with no approval channel wired, is
    // claiming a capability it cannot lawfully exercise — that is refused.
    //
    // An adapter that declares canBuy:FALSE and buyRequiresHumanApproval:true is
    // NOT inconsistent: it is an honest sell-only channel that is recording why
    // it has no buy path. Denying the whole adapter for that was the reason the
    // ksa_ecom sell path, its SAR pricing and its VAT handling never ran at all.
    if (c.canBuy && c.buyRequiresHumanApproval && this.approvalChannel === null) {
      this.denyAt(t, subject, RULES.CHANNEL_APPROVAL, `channel ${name} claims canBuy while its terms of service require human approval per purchase (${c.tosNote}), and no approval channel is configured — the capability set is internally inconsistent for an autonomous agent. An adapter with no automated buy path must declare canBuy:false; it is then admitted SELL-ONLY`, {
        tosNote: c.tosNote,
        jurisdiction: c.jurisdiction,
        remedy: 'declare canBuy:false to be admitted as a sell-only channel',
      });
    }
    const sellOnly = !c.canBuy && c.canSell;
    this.allow(
      t,
      subject,
      RULES.CHANNEL_OK,
      sellOnly ? `channel ${name} admitted SELL-ONLY (it declares no automated buy path)` : `channel ${name} admitted`,
      {
        canBuy: c.canBuy,
        canSell: c.canSell,
        sellOnly,
        // True on a sell-only channel means "this is why there is no buy path",
        // not "buying is pending an approval that might arrive".
        buyRequiresHumanApproval: c.buyRequiresHumanApproval,
        jurisdiction: c.jurisdiction,
      },
    );
  }

  /**
   * The buy gate, evaluated strictly in this order: halt, mode, channel
   * allow-list, canBuy, human-approval ToS, qty, currency, positive total,
   * per-trade cap.
   */
  checkBuy(a: ChannelAdapter, o: Opportunity, qty: number, total: Money, tick?: number): void {
    const t = tick ?? this.tick;
    const name = a === null || typeof a !== 'object' ? '' : String(a.name ?? '');
    const subject = `${name || '<unnamed>'}/${o === null || typeof o !== 'object' ? '<none>' : String(o.sku ?? '<none>')}`;

    if (this.killSwitch !== null && this.killSwitch.tripped) {
      this.denyAt(t, subject, RULES.BUY_KILLSWITCH, `buy refused: swarm halted (${this.killSwitch.reason ?? 'unknown'})`, {});
    }
    if (this.cfg.mode !== 'PAPER') {
      this.denyAt(t, subject, RULES.BUY_MODE, `buy refused: mode ${String(this.cfg.mode)} is not PAPER`, {});
    }
    if (!this.cfg.channels.includes(name)) {
      this.denyAt(t, subject, RULES.BUY_CHANNEL, `buy refused: channel ${name} is not in the configured channel allow-list`, {
        allowed: [...this.cfg.channels],
      });
    }
    const c = a.capabilities;
    if (c === null || typeof c !== 'object' || c.canBuy !== true) {
      this.denyAt(t, subject, RULES.BUY_CAPABILITY, `buy refused: channel ${name} does not support buying`, {});
    }
    if (c.buyRequiresHumanApproval === true) {
      this.denyAt(t, subject, RULES.BUY_HUMAN_APPROVAL, `buy refused: the terms of service of ${name} require a human to approve every purchase (${c.tosNote}); autonomous buying is prohibited, so ARES will not place this order`, {
        tosNote: c.tosNote,
        jurisdiction: c.jurisdiction,
        approvalChannel: this.approvalChannel,
      });
    }
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      this.denyAt(t, subject, RULES.BUY_QTY, `buy refused: qty must be a positive integer, got ${String(qty)}`, { qty });
    }
    if (total === null || typeof total !== 'object' || total.currency !== this.cfg.baseCurrency) {
      this.denyAt(t, subject, RULES.BUY_CURRENCY, `buy refused: total is ${String(total?.currency)}, base currency is ${this.cfg.baseCurrency}`, {
        currency: total?.currency,
      });
    }
    if (!Number.isSafeInteger(total.amount) || total.amount <= 0) {
      this.denyAt(t, subject, RULES.BUY_TOTAL, `buy refused: total must be a positive integer amount of minor units, got ${String(total.amount)}`, {
        total: total.amount,
      });
    }
    if (total.amount > this.cfg.budget.perTradeCapMinor) {
      this.denyAt(t, subject, RULES.BUY_TRADE_CAP, `buy refused: total ${total.amount} exceeds the per-trade cap ${this.cfg.budget.perTradeCapMinor}`, {
        total: total.amount,
        cap: this.cfg.budget.perTradeCapMinor,
      });
    }
    this.allow(t, subject, RULES.BUY_OK, `buy of ${qty} x ${o.sku} on ${name} for ${total.amount} permitted`, {
      qty,
      total: total.amount,
    });
  }

  /** The sell gate: halt, mode, channel allow-list, canSell, qty, price. */
  checkSell(a: ChannelAdapter, offer: Offer, tick?: number): void {
    const t = tick ?? this.tick;
    const name = a === null || typeof a !== 'object' ? '' : String(a.name ?? '');
    const subject = `${name || '<unnamed>'}/${offer === null || typeof offer !== 'object' ? '<none>' : String(offer.sku ?? '<none>')}`;

    if (this.killSwitch !== null && this.killSwitch.tripped) {
      this.denyAt(t, subject, RULES.SELL_KILLSWITCH, `sell refused: swarm halted (${this.killSwitch.reason ?? 'unknown'})`, {});
    }
    if (this.cfg.mode !== 'PAPER') {
      this.denyAt(t, subject, RULES.SELL_MODE, `sell refused: mode ${String(this.cfg.mode)} is not PAPER`, {});
    }
    if (!this.cfg.channels.includes(name)) {
      this.denyAt(t, subject, RULES.SELL_CHANNEL, `sell refused: channel ${name} is not in the configured channel allow-list`, {
        allowed: [...this.cfg.channels],
      });
    }
    const c = a.capabilities;
    if (c === null || typeof c !== 'object' || c.canSell !== true) {
      this.denyAt(t, subject, RULES.SELL_CAPABILITY, `sell refused: channel ${name} does not support selling`, {});
    }
    if (!Number.isSafeInteger(offer.qty) || offer.qty <= 0) {
      this.denyAt(t, subject, RULES.SELL_QTY, `sell refused: qty must be a positive integer, got ${String(offer.qty)}`, {
        qty: offer.qty,
      });
    }
    const p = offer.price;
    if (p === null || typeof p !== 'object' || p.currency !== this.cfg.baseCurrency) {
      this.denyAt(t, subject, RULES.SELL_PRICE, `sell refused: price is ${String(p?.currency)}, base currency is ${this.cfg.baseCurrency}`, {
        currency: p?.currency,
      });
    }
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) {
      this.denyAt(t, subject, RULES.SELL_PRICE, `sell refused: price must be positive, got ${String(p.amount)}`, {
        price: p.amount,
      });
    }
    this.allow(t, subject, RULES.SELL_OK, `sale of ${offer.qty} x ${offer.sku} on ${name} at ${p.amount} permitted`, {
      qty: offer.qty,
      price: p.amount,
    });
  }

  // ------------------------------------------------------------------ audit --

  /** Newest-last audit trail (bounded ring). `limit` returns the most recent N. */
  decisions(limit?: number): PolicyDecision[] {
    const all = this.ring.map((d) => ({ ...d, meta: { ...d.meta } }));
    if (limit === undefined || limit < 0 || limit >= all.length) return all;
    return all.slice(all.length - limit);
  }

  stats(): { allowed: number; denied: number; retained: number; capacity: number } {
    return { allowed: this.allowedCount, denied: this.deniedCount, retained: this.ring.length, capacity: this.cap };
  }

  private record(d: PolicyDecision): void {
    this.ring.push(d);
    while (this.ring.length > this.cap) this.ring.shift();
  }

  private allow(tick: number, subject: string, rule: RuleId, reason: string, meta: Record<string, unknown>): void {
    this.seq++;
    this.allowedCount++;
    this.record({ seq: this.seq, tick, subject, rule, allowed: true, reason, meta });
    this.logger.debug('policy.allow', { tick, subject, rule, reason });
  }

  /** Records the denial, then throws. Never returns. */
  private denyAt(tick: number, subject: string, rule: RuleId, reason: string, meta: Record<string, unknown>): never {
    this.seq++;
    this.deniedCount++;
    this.record({ seq: this.seq, tick, subject, rule, allowed: false, reason, meta });
    this.logger.warn('policy.deny', { tick, subject, rule, reason, ...meta });
    throw new PolicyDenied(codeOf(rule), reason, { rule, subject, tick, ...meta });
  }
}
