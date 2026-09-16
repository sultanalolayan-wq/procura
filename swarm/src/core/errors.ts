/**
 * core/errors.ts — the single error taxonomy for ARES.
 * Invariant: every thrown ARES error carries a stable machine-readable `code`
 * plus optional structured `meta`; nothing in the swarm throws bare Error.
 * Callers: every module. Governance/runtime branch on `instanceof` + `code`.
 */

export class AresError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    // Keeps `instanceof` working when compiled down and gives clean stacks.
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, meta: this.meta ?? null };
  }
}

/** A compliance/ToS gate said no. */
export class PolicyDenied extends AresError {}
/** A spend/token reservation was refused. */
export class BudgetDenied extends AresError {}
/** The kill switch is latched; the swarm refuses to act. */
export class HaltedError extends AresError {}
/** Ledger chain / accounting invariant violation. Always fatal. */
export class IntegrityError extends AresError {}
/** An external channel adapter failed or a circuit is open. */
export class AdapterError extends AresError {}
/** Environment configuration is invalid. */
export class ConfigError extends AresError {}
