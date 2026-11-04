/**
 * Append-only budget authority journal (DAT-229).
 *
 * Every reservation, settlement, reconciliation and release is appended to a
 * durable journal *before* the in-memory projection changes, so a returned
 * transition is a durable one and a crash can only lose the transition it was
 * in the middle of — never silently keep a refund that was not written.
 *
 * State transitions are synchronous. That is the concurrency guarantee: two
 * dispatches cannot both observe the same "remaining" budget and both reserve
 * it, because check + append + commit happen in one uninterrupted call. The
 * journal is single-writer (the gateway authority); a second writer must use
 * another file.
 *
 * Replay runs the same validators as live operation. A truncated final line
 * is repaired to the last complete record boundary; a corrupt complete line
 * is refused loudly instead of being reinterpreted.
 */
import fs from "node:fs";

import {
  addAmounts,
  compareAmounts,
  formatAmount,
  normalizeCurrencyAmounts,
  parseAmount,
  type CurrencyAmount,
} from "./amount.js";
import {
  BudgetAccessError,
  BudgetConflictError,
  BudgetQuotaError,
  BudgetValidationError,
  BudgetWriteError,
} from "./errors.js";
import { validateBudgetLimits } from "./policy.js";
import type {
  BudgetAccessScope,
  BudgetCorrection,
  BudgetJournalEntry,
  BudgetJournalKind,
  BudgetLimits,
  BudgetMoneyAccount,
  BudgetReservation,
  BudgetReservationFilter,
  BudgetReservationStatus,
  BudgetScopeLevel,
  BudgetScopeUsage,
  BudgetSettlement,
  BudgetUsageObservation,
} from "./types.js";
import { BUDGET_SCOPE_LEVELS } from "./types.js";

export interface BudgetStoreOptions {
  /** Durable journal file; omit for a process-local store (tests). */
  persistencePath?: string;
  now?: () => Date;
}

/** What the authority asks the store to admit. */
export interface BudgetReserveInput {
  identity: BudgetReservation["identity"];
  policy_revision: string;
  limits: BudgetReservation["limits"];
  cost_ceilings: BudgetReservation["cost_ceilings"];
  token_bound: number;
  monetary_bound: CurrencyAmount[];
}

interface ScopeTotal {
  tokens: number;
  monetary: Map<string, bigint>;
}

function zeroTotal(): ScopeTotal {
  return { tokens: 0, monetary: new Map() };
}

function enterpriseKey(enterpriseId: string): string {
  return `enterprise:${enterpriseId}`;
}

function workspaceKey(enterpriseId: string, workspaceId: string): string {
  return `workspace:${enterpriseId}:${workspaceId}`;
}

function runKey(enterpriseId: string, workspaceId: string, runId: string): string {
  return `run:${enterpriseId}:${workspaceId}:${runId}`;
}

function scopeKeys(reservation: BudgetReservation): string[] {
  const {
    enterprise_id: enterpriseId,
    workspace_id: workspaceId,
    run_id: runId,
  } = reservation.identity;
  return [
    enterpriseKey(enterpriseId),
    workspaceKey(enterpriseId, workspaceId),
    runKey(enterpriseId, workspaceId, runId),
  ];
}

const RESERVATION_STATUSES: readonly BudgetReservationStatus[] = [
  "held",
  "settled",
  "reconciling",
  "released",
];

const COMPLETENESS_VALUES = ["known", "estimated", "unknown"] as const;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BudgetValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BudgetValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BudgetValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireCompleteness(value: unknown, label: string): "known" | "estimated" | "unknown" {
  if (typeof value !== "string" || !COMPLETENESS_VALUES.includes(value as never)) {
    throw new BudgetValidationError(`${label} must be known, estimated or unknown`);
  }
  return value as "known" | "estimated" | "unknown";
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new BudgetValidationError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function validateUsageObservation(value: unknown, label: string): BudgetUsageObservation {
  if (typeof value !== "object" || value === null) {
    throw new BudgetValidationError(`${label} must be an object`);
  }
  const entry = Object.fromEntries(Object.entries(value));
  const tokens = entry["tokens"];
  const completeness = requireCompleteness(entry["completeness"], `${label}.completeness`);
  if (tokens === null) {
    if (completeness !== "unknown") {
      throw new BudgetValidationError(`${label} reports no tokens and must be complete unknown`);
    }
    return { tokens: null, completeness };
  }
  const count = requireNonNegativeInteger(tokens, `${label}.tokens`);
  if (completeness === "unknown") {
    throw new BudgetValidationError(`${label} reports tokens and cannot be complete unknown`);
  }
  return { tokens: count, completeness };
}

function validateCostSettlement(
  value: unknown,
  label: string,
): NonNullable<BudgetSettlement["cost"]> {
  if (typeof value !== "object" || value === null) {
    throw new BudgetValidationError(`${label} must be an object`);
  }
  const entry = Object.fromEntries(Object.entries(value));
  if (!Array.isArray(entry["amounts"])) {
    throw new BudgetValidationError(`${label}.amounts must be an array`);
  }
  const amounts = normalizeCurrencyAmounts(
    entry["amounts"].map((amount, index) => {
      if (typeof amount !== "object" || amount === null) {
        throw new BudgetValidationError(`${label}.amounts[${index}] must be an object`);
      }
      const amountEntry = Object.fromEntries(Object.entries(amount));
      return {
        currency: requireString(amountEntry["currency"], `${label}.amounts[${index}].currency`),
        amount: requireString(amountEntry["amount"], `${label}.amounts[${index}].amount`),
      };
    }),
    `${label}.amounts`,
  );
  const source = entry["source"];
  if (source !== "bound_ceiling" && source !== "cost") {
    throw new BudgetValidationError(`${label}.source must be bound_ceiling or cost`);
  }
  const completeness = requireCompleteness(entry["completeness"], `${label}.completeness`);
  if (completeness === "unknown" && amounts.length > 0) {
    throw new BudgetValidationError(
      `${label} cannot report amounts while its completeness is unknown`,
    );
  }
  return { amounts, completeness, source };
}

function validateSettlement(value: unknown, label: string): BudgetSettlement {
  if (typeof value !== "object" || value === null) {
    throw new BudgetValidationError(`${label} must be an object`);
  }
  const entry = Object.fromEntries(Object.entries(value));
  const settlement: BudgetSettlement = {};
  if (entry["usage"] !== undefined) {
    settlement.usage = validateUsageObservation(entry["usage"], `${label}.usage`);
  }
  if (entry["cost"] !== undefined) {
    settlement.cost = validateCostSettlement(entry["cost"], `${label}.cost`);
  }
  if (settlement.usage === undefined && settlement.cost === undefined) {
    throw new BudgetValidationError(`${label} must settle usage, cost, or both`);
  }
  return settlement;
}

function validateCorrection(value: unknown, label: string): BudgetCorrection {
  if (typeof value !== "object" || value === null) {
    throw new BudgetValidationError(`${label} must be an object`);
  }
  const entry = Object.fromEntries(Object.entries(value));
  const settlement = validateSettlement(entry, label);
  return { ...settlement, reason: requireString(entry["reason"], `${label}.reason`) };
}

function validateCostCeilings(value: unknown): BudgetReservation["cost_ceilings"] {
  if (!Array.isArray(value)) {
    throw new BudgetValidationError("reservation cost_ceilings must be an array");
  }
  const seen = new Set<string>();
  return value.map((ceiling, index) => {
    if (typeof ceiling !== "object" || ceiling === null) {
      throw new BudgetValidationError(`reservation cost_ceilings[${index}] must be an object`);
    }
    const entry = Object.fromEntries(Object.entries(ceiling));
    const currency = requireString(
      entry["currency"],
      `reservation cost_ceilings[${index}].currency`,
    );
    if (seen.has(currency)) {
      throw new BudgetValidationError(`reservation cost_ceilings lists ${currency} twice`);
    }
    seen.add(currency);
    const rate = formatAmount(
      parseAmount(
        entry["amount_per_1000_tokens"],
        `reservation cost_ceilings[${index}].amount_per_1000_tokens`,
      ),
    );
    if (parseAmount(rate) <= 0n) {
      throw new BudgetValidationError(
        `reservation cost_ceilings[${index}].amount_per_1000_tokens must be positive`,
      );
    }
    return { currency, amount_per_1000_tokens: rate };
  });
}

function validateMoneyAccounts(
  value: unknown,
  costCeilings: BudgetReservation["cost_ceilings"],
): BudgetMoneyAccount[] {
  if (!Array.isArray(value)) {
    throw new BudgetValidationError("reservation money must be an array");
  }
  const accounts = value.map((account, index) => {
    if (typeof account !== "object" || account === null) {
      throw new BudgetValidationError(`reservation money[${index}] must be an object`);
    }
    const entry = Object.fromEntries(Object.entries(account));
    const currency = requireString(entry["currency"], `reservation money[${index}].currency`);
    const used = entry["used"];
    const source = entry["source"];
    const completeness =
      entry["completeness"] === null
        ? null
        : requireCompleteness(entry["completeness"], `reservation money[${index}].completeness`);
    if (source !== null && source !== "bound_ceiling" && source !== "cost") {
      throw new BudgetValidationError(
        `reservation money[${index}].source must be bound_ceiling, cost or null`,
      );
    }
    return {
      currency,
      bound: formatAmount(parseAmount(entry["bound"], `reservation money[${index}].bound`)),
      used:
        used === null ? null : formatAmount(parseAmount(used, `reservation money[${index}].used`)),
      completeness,
      source: source as BudgetMoneyAccount["source"],
    };
  });
  // The bound must correspond exactly to the snapshotted ceiling currencies:
  // a missing bound would silently leave a capped currency unreserved.
  const accountCurrencies = accounts.map((account) => account.currency).sort();
  const ceilingCurrencies = costCeilings.map((ceiling) => ceiling.currency).sort();
  if (JSON.stringify(accountCurrencies) !== JSON.stringify(ceilingCurrencies)) {
    throw new BudgetValidationError(
      "reservation monetary accounts must match the snapshotted cost ceiling currencies",
    );
  }
  return accounts;
}

function validateReservationIdentity(value: unknown): BudgetReservation["identity"] {
  if (typeof value !== "object" || value === null) {
    throw new BudgetValidationError("reservation identity must be an object");
  }
  const entry = Object.fromEntries(Object.entries(value));
  return {
    enterprise_id: requireString(entry["enterprise_id"], "reservation identity.enterprise_id"),
    workspace_id: requireString(entry["workspace_id"], "reservation identity.workspace_id"),
    issue_id: requireString(entry["issue_id"], "reservation identity.issue_id"),
    run_id: requireString(entry["run_id"], "reservation identity.run_id"),
    invocation_id: requireString(entry["invocation_id"], "reservation identity.invocation_id"),
    trace_id: requireString(entry["trace_id"], "reservation identity.trace_id"),
    attempt: requirePositiveInteger(entry["attempt"], "reservation identity.attempt"),
    endpoint_id: requireString(entry["endpoint_id"], "reservation identity.endpoint_id"),
    provider: requireString(entry["provider"], "reservation identity.provider"),
    model_id: requireString(entry["model_id"], "reservation identity.model_id"),
  };
}

function validateReservationLimits(value: unknown): BudgetReservation["limits"] {
  if (typeof value !== "object" || value === null) {
    throw new BudgetValidationError("reservation limits must be an object");
  }
  const entry = Object.fromEntries(Object.entries(value));
  const run = entry["run"];
  return {
    enterprise: validateBudgetLimits(entry["enterprise"], "reservation limits.enterprise"),
    workspace: validateBudgetLimits(entry["workspace"], "reservation limits.workspace"),
    run:
      run === null || run === undefined
        ? null
        : validateBudgetLimits(run, "reservation limits.run"),
  };
}

function validateReservation(value: unknown): BudgetReservation {
  if (typeof value !== "object" || value === null) {
    throw new BudgetValidationError("journal reservation must be an object");
  }
  const entry = Object.fromEntries(Object.entries(value));
  const identity = validateReservationIdentity(entry["identity"]);
  const limits = validateReservationLimits(entry["limits"]);
  const costCeilings = validateCostCeilings(entry["cost_ceilings"]);
  const money = validateMoneyAccounts(entry["money"], costCeilings);
  const tokensRaw = entry["tokens"];
  if (typeof tokensRaw !== "object" || tokensRaw === null) {
    throw new BudgetValidationError("reservation tokens must be an object");
  }
  const tokensEntry = Object.fromEntries(Object.entries(tokensRaw));
  const tokenCompleteness =
    tokensEntry["completeness"] === null
      ? null
      : requireCompleteness(tokensEntry["completeness"], "reservation tokens.completeness");
  const usedTokens =
    tokensEntry["used"] === null
      ? null
      : requireNonNegativeInteger(tokensEntry["used"], "reservation tokens.used");
  if ((usedTokens === null) !== (tokenCompleteness === null)) {
    throw new BudgetValidationError(
      "reservation token usage and completeness must be recorded together",
    );
  }
  if (usedTokens !== null && tokenCompleteness === "unknown") {
    throw new BudgetValidationError("reservation token usage cannot be complete unknown");
  }
  const status = entry["status"];
  if (typeof status !== "string" || !RESERVATION_STATUSES.includes(status as never)) {
    throw new BudgetValidationError("reservation status is not a known budget state");
  }
  const reservation: BudgetReservation = {
    reservation_id: requireString(entry["reservation_id"], "reservation.reservation_id"),
    identity,
    policy_revision: requireString(entry["policy_revision"], "reservation.policy_revision"),
    limits,
    cost_ceilings: costCeilings,
    tokens: {
      bound: requirePositiveInteger(tokensEntry["bound"], "reservation tokens.bound"),
      used: usedTokens,
      completeness: tokenCompleteness,
    },
    money,
    status: status as BudgetReservationStatus,
    created_at: requireIsoTimestamp(entry["created_at"], "reservation.created_at"),
    updated_at: requireIsoTimestamp(entry["updated_at"], "reservation.updated_at"),
  };
  return reservation;
}

/** Deterministic reservation identity: one per invocation attempt. */
export function budgetReservationId(invocationId: string, attempt: number): string {
  return `budget:${invocationId}:${attempt}`;
}

function committedOf(reservation: BudgetReservation): {
  tokens: number;
  monetary: Map<string, bigint>;
} {
  if (reservation.status === "released") {
    return { tokens: 0, monetary: new Map() };
  }
  const monetary = new Map<string, bigint>();
  for (const account of reservation.money) {
    monetary.set(
      account.currency,
      account.used === null ? parseAmount(account.bound) : parseAmount(account.used),
    );
  }
  return {
    tokens: reservation.tokens.used ?? reservation.tokens.bound,
    monetary,
  };
}

function deriveStatus(reservation: BudgetReservation): BudgetReservationStatus {
  if (reservation.status === "released") {
    return "released";
  }
  const tokensResolved =
    reservation.tokens.completeness === "known" || reservation.tokens.completeness === "estimated";
  const moneyResolved = reservation.money.every(
    (account) => account.completeness === "known" || account.completeness === "estimated",
  );
  return tokensResolved && moneyResolved ? "settled" : "reconciling";
}

function sameUsage(
  account: { used: number | null; completeness: string | null },
  observation: BudgetUsageObservation,
): boolean {
  return account.used === observation.tokens && account.completeness === observation.completeness;
}

function sameCost(
  account: BudgetMoneyAccount,
  settlement: { amounts: CurrencyAmount[]; completeness: string; source: string },
): boolean {
  const amount = settlement.amounts.find((entry) => entry.currency === account.currency);
  if (amount === undefined) {
    return account.used === null && account.completeness === "unknown";
  }
  return (
    account.used === formatAmount(parseAmount(amount.amount)) &&
    account.completeness === settlement.completeness &&
    account.source === settlement.source
  );
}

export class BudgetStore {
  private readonly reservationsById = new Map<string, BudgetReservation>();
  private readonly journal: BudgetJournalEntry[] = [];
  private readonly totals = new Map<string, ScopeTotal>();
  private readonly persistencePath: string | undefined;
  private readonly now: () => Date;
  private closedTailRepaired = false;

  constructor(options: BudgetStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /** Number of durable journal entries (for readiness and tests). */
  get entryCount(): number {
    return this.journal.length;
  }

  private load(): void {
    if (this.persistencePath === undefined || !fs.existsSync(this.persistencePath)) {
      return;
    }
    let content = fs.readFileSync(this.persistencePath, "utf8");
    if (content.length === 0) {
      return;
    }
    if (!content.endsWith("\n")) {
      // A torn final write never committed: repair the file to the last
      // complete record boundary instead of guessing at half a transition.
      const lastNewline = content.lastIndexOf("\n");
      const repaired = lastNewline === -1 ? "" : content.slice(0, lastNewline + 1);
      fs.writeFileSync(this.persistencePath, repaired, { mode: 0o600 });
      this.closedTailRepaired = true;
      content = repaired;
    }
    const lines = content.split("\n").filter((line) => line.length > 0);
    let expectedSequence = 1;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new BudgetValidationError(
          `budget journal ${this.persistencePath} contains a corrupt record at sequence ${expectedSequence}`,
        );
      }
      const entry = this.validateJournalEntry(parsed, expectedSequence);
      this.journal.push(entry);
      this.applyEntry(entry);
      expectedSequence += 1;
    }
  }

  private validateJournalEntry(value: unknown, expectedSequence: number): BudgetJournalEntry {
    if (typeof value !== "object" || value === null) {
      throw new BudgetValidationError("budget journal entry must be an object");
    }
    const entry = Object.fromEntries(Object.entries(value));
    const sequence = requirePositiveInteger(entry["sequence"], "journal entry.sequence");
    if (sequence !== expectedSequence) {
      throw new BudgetValidationError(
        `budget journal sequence ${sequence} is out of order (expected ${expectedSequence})`,
      );
    }
    const kind = entry["kind"];
    const kinds: readonly BudgetJournalKind[] = [
      "reserve",
      "settle",
      "reconcile",
      "reconciliation_required",
      "release",
    ];
    if (typeof kind !== "string" || !kinds.includes(kind as never)) {
      throw new BudgetValidationError("journal entry.kind is not a known budget transition");
    }
    const base: BudgetJournalEntry = {
      sequence,
      kind: kind as BudgetJournalKind,
      at: requireIsoTimestamp(entry["at"], "journal entry.at"),
      reservation_id: requireString(entry["reservation_id"], "journal entry.reservation_id"),
    };
    if (kind === "reconciliation_required" || kind === "release") {
      base.reason = requireString(entry["reason"], "journal entry.reason");
    } else if (entry["reason"] !== undefined) {
      base.reason = requireString(entry["reason"], "journal entry.reason");
    }
    if (kind === "reserve") {
      base.reservation = validateReservation(entry["reservation"]);
    }
    if (kind === "settle") {
      base.settlement = validateSettlement(entry["settlement"], "journal entry.settlement");
    }
    if (kind === "reconcile") {
      base.correction = validateCorrection(entry["correction"], "journal entry.correction");
    }
    return base;
  }

  /** Append durably first, then project. A throw means nothing changed. */
  private append(entry: BudgetJournalEntry): void {
    if (this.persistencePath !== undefined) {
      try {
        const fd = fs.openSync(this.persistencePath, "a", 0o600);
        try {
          fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        throw new BudgetWriteError(`budget journal write failed at sequence ${entry.sequence}`, {
          cause: error,
        });
      }
    }
    this.journal.push(entry);
    this.applyEntry(entry);
  }

  private nextSequence(): number {
    return this.journal.length + 1;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private applyEntry(entry: BudgetJournalEntry): void {
    switch (entry.kind) {
      case "reserve":
        this.applyReserve(entry);
        return;
      case "settle":
        this.applySettlement(entry);
        return;
      case "reconcile":
        this.applyCorrection(entry);
        return;
      case "reconciliation_required":
        this.applyReconciliationRequired(entry);
        return;
      case "release":
        this.applyRelease(entry);
        return;
    }
  }

  private applyReserve(entry: BudgetJournalEntry): void {
    const reservation = entry.reservation;
    if (reservation === undefined) {
      throw new BudgetValidationError("reserve entry is missing its reservation");
    }
    if (entry.reservation_id !== reservation.reservation_id) {
      throw new BudgetValidationError("reserve entry id does not match its reservation");
    }
    if (this.reservationsById.has(reservation.reservation_id)) {
      throw new BudgetConflictError(
        `reservation ${reservation.reservation_id} is already in the budget journal`,
      );
    }
    this.setReservation(reservation);
  }

  private applySettlement(entry: BudgetJournalEntry): BudgetReservation {
    const reservation = this.requireReservation(entry.reservation_id);
    const settlement = entry.settlement;
    if (settlement === undefined) {
      throw new BudgetValidationError("settle entry is missing its settlement");
    }
    if (reservation.status === "released") {
      throw new BudgetConflictError(
        `reservation ${reservation.reservation_id} was released and cannot be settled`,
      );
    }
    const updated: BudgetReservation = {
      ...reservation,
      tokens: { ...reservation.tokens },
      money: reservation.money.map((account) => ({ ...account })),
      updated_at: entry.at,
    };
    if (settlement.usage !== undefined) {
      if (reservation.tokens.completeness !== null) {
        throw new BudgetConflictError(
          `reservation ${reservation.reservation_id} usage is already settled; a correction must be reconciled`,
        );
      }
      updated.tokens.used = settlement.usage.tokens;
      updated.tokens.completeness = settlement.usage.completeness;
    }
    if (settlement.cost !== undefined) {
      const boundCurrencies = new Set(updated.money.map((account) => account.currency));
      for (const amount of settlement.cost.amounts) {
        if (!boundCurrencies.has(amount.currency)) {
          throw new BudgetValidationError(
            `settlement currency ${amount.currency} was never reserved for ${reservation.reservation_id}`,
          );
        }
      }
      for (const account of updated.money) {
        if (account.completeness !== null) {
          throw new BudgetConflictError(
            `reservation ${reservation.reservation_id} ${account.currency} cost is already settled; a correction must be reconciled`,
          );
        }
        const amount = settlement.cost.amounts.find(
          (candidate) => candidate.currency === account.currency,
        );
        if (amount === undefined) {
          // A capped currency with no settled amount stays unknown, never zero.
          account.completeness = "unknown";
          continue;
        }
        account.used = formatAmount(parseAmount(amount.amount));
        account.completeness = settlement.cost.completeness;
        account.source = settlement.cost.source;
      }
    }
    updated.status = deriveStatus(updated);
    this.setReservation(updated);
    return updated;
  }

  private applyCorrection(entry: BudgetJournalEntry): BudgetReservation {
    const reservation = this.requireReservation(entry.reservation_id);
    const correction = entry.correction;
    if (correction === undefined) {
      throw new BudgetValidationError("reconcile entry is missing its correction");
    }
    if (reservation.status === "released") {
      throw new BudgetConflictError(
        `reservation ${reservation.reservation_id} was released and cannot be reconciled`,
      );
    }
    if (reservation.status === "held") {
      throw new BudgetConflictError(
        `reservation ${reservation.reservation_id} has no settled dimension to reconcile`,
      );
    }
    const updated: BudgetReservation = {
      ...reservation,
      tokens: { ...reservation.tokens },
      money: reservation.money.map((account) => ({ ...account })),
      updated_at: entry.at,
    };
    if (correction.usage !== undefined) {
      updated.tokens.used = correction.usage.tokens;
      updated.tokens.completeness = correction.usage.completeness;
    }
    if (correction.cost !== undefined) {
      const boundCurrencies = new Set(updated.money.map((account) => account.currency));
      for (const amount of correction.cost.amounts) {
        if (!boundCurrencies.has(amount.currency)) {
          throw new BudgetValidationError(
            `correction currency ${amount.currency} was never reserved for ${reservation.reservation_id}`,
          );
        }
      }
      for (const account of updated.money) {
        const amount = correction.cost.amounts.find(
          (candidate) => candidate.currency === account.currency,
        );
        if (amount === undefined) {
          account.used = null;
          account.completeness = "unknown";
          account.source = null;
          continue;
        }
        account.used = formatAmount(parseAmount(amount.amount));
        account.completeness = correction.cost.completeness;
        account.source = correction.cost.source;
      }
    }
    updated.status = deriveStatus(updated);
    this.setReservation(updated);
    return updated;
  }

  private applyReconciliationRequired(entry: BudgetJournalEntry): BudgetReservation {
    const reservation = this.requireReservation(entry.reservation_id);
    if (reservation.status === "released" || reservation.status === "settled") {
      throw new BudgetConflictError(
        `reservation ${reservation.reservation_id} cannot require reconciliation from ${reservation.status}`,
      );
    }
    const updated: BudgetReservation = {
      ...reservation,
      tokens: { ...reservation.tokens },
      money: reservation.money.map((account) => ({ ...account })),
      updated_at: entry.at,
    };
    if (updated.tokens.completeness === null) {
      updated.tokens.completeness = "unknown";
    }
    for (const account of updated.money) {
      if (account.completeness === null) {
        account.completeness = "unknown";
      }
    }
    updated.status = "reconciling";
    this.setReservation(updated);
    return updated;
  }

  private applyRelease(entry: BudgetJournalEntry): BudgetReservation {
    const reservation = this.requireReservation(entry.reservation_id);
    if (reservation.status === "released") {
      return reservation;
    }
    if (reservation.status !== "held") {
      throw new BudgetConflictError(
        `reservation ${reservation.reservation_id} has observed usage and cannot be released`,
      );
    }
    const updated: BudgetReservation = {
      ...reservation,
      updated_at: entry.at,
      status: "released",
    };
    this.setReservation(updated);
    return updated;
  }

  private requireReservation(reservationId: string): BudgetReservation {
    const reservation = this.reservationsById.get(reservationId);
    if (reservation === undefined) {
      throw new BudgetValidationError(`unknown budget reservation ${reservationId}`);
    }
    return reservation;
  }

  private setReservation(reservation: BudgetReservation): void {
    const previous = this.reservationsById.get(reservation.reservation_id);
    if (previous !== undefined) {
      this.adjustTotals(previous, -1);
    }
    this.reservationsById.set(reservation.reservation_id, reservation);
    this.adjustTotals(reservation, 1);
  }

  private adjustTotals(reservation: BudgetReservation, direction: 1 | -1): void {
    const committed = committedOf(reservation);
    for (const key of scopeKeys(reservation)) {
      const total = this.totals.get(key) ?? zeroTotal();
      total.tokens += direction * committed.tokens;
      for (const [currency, amount] of committed.monetary) {
        const next = addAmounts(
          total.monetary.get(currency) ?? 0n,
          direction === 1 ? amount : -amount,
        );
        if (next === 0n) {
          total.monetary.delete(currency);
        } else {
          total.monetary.set(currency, next);
        }
      }
      this.totals.set(key, total);
    }
  }

  /**
   * Admit one attempt, or refuse it without changing committed budget.
   * `replayed` reports a redelivery of an already-admitted attempt.
   */
  reserve(input: BudgetReserveInput): { reservation: BudgetReservation; replayed: boolean } {
    const identity = validateReservationIdentity(input.identity);
    const limits = validateReservationLimits(input.limits);
    const costCeilings = validateCostCeilings(input.cost_ceilings);
    const tokenBound = requirePositiveInteger(input.token_bound, "reservation token_bound");
    const monetaryBound = normalizeCurrencyAmounts(input.monetary_bound, "monetary bound");
    const policyRevision = requireString(input.policy_revision, "reservation policy_revision");

    const reservationId = budgetReservationId(identity.invocation_id, identity.attempt);
    const existing = this.reservationsById.get(reservationId);
    if (existing !== undefined) {
      const sameAttempt =
        JSON.stringify(existing.identity) === JSON.stringify(identity) &&
        JSON.stringify(existing.limits) === JSON.stringify(limits) &&
        JSON.stringify(existing.cost_ceilings) === JSON.stringify(costCeilings) &&
        existing.tokens.bound === tokenBound &&
        JSON.stringify(existing.money.map((account) => [account.currency, account.bound])) ===
          JSON.stringify(monetaryBound.map((amount) => [amount.currency, amount.amount])) &&
        existing.policy_revision === policyRevision;
      if (!sameAttempt) {
        throw new BudgetConflictError(
          `reservation ${reservationId} is already recorded with a different budget request`,
        );
      }
      return { reservation: structuredClone(existing), replayed: true };
    }

    this.assertFits(identity, limits, tokenBound, monetaryBound);

    const at = this.stamp();
    const money: BudgetMoneyAccount[] = monetaryBound.map((amount) => ({
      currency: amount.currency,
      bound: amount.amount,
      used: null,
      completeness: null,
      source: null,
    }));
    const reservation: BudgetReservation = {
      reservation_id: reservationId,
      identity,
      policy_revision: policyRevision,
      limits,
      cost_ceilings: costCeilings,
      tokens: { bound: tokenBound, used: null, completeness: null },
      money,
      status: "held",
      created_at: at,
      updated_at: at,
    };
    this.append({
      sequence: this.nextSequence(),
      kind: "reserve",
      at,
      reservation_id: reservationId,
      reservation,
    });
    return { reservation: this.requireReservation(reservationId), replayed: false };
  }

  private assertFits(
    identity: BudgetReservation["identity"],
    limits: BudgetReservation["limits"],
    tokenBound: number,
    monetaryBound: readonly CurrencyAmount[],
  ): void {
    const levels: [BudgetScopeLevel, string, BudgetLimits][] = [
      ["enterprise", enterpriseKey(identity.enterprise_id), limits.enterprise],
      ["workspace", workspaceKey(identity.enterprise_id, identity.workspace_id), limits.workspace],
    ];
    if (limits.run !== null) {
      levels.push([
        "run",
        runKey(identity.enterprise_id, identity.workspace_id, identity.run_id),
        limits.run,
      ]);
    }
    for (const [level, key, cap] of levels) {
      const total = this.totals.get(key) ?? zeroTotal();
      if (cap.tokens !== null && total.tokens + tokenBound > cap.tokens) {
        throw new BudgetQuotaError(
          "BUDGET_LIMIT_EXCEEDED",
          level,
          `${level} token budget has no room for this invocation`,
        );
      }
      const capCurrencies = new Map(cap.monetary.map((amount) => [amount.currency, amount.amount]));
      // Every capped currency must carry a bound; a missing one would let an
      // invocation slip past that limit entirely.
      for (const currency of capCurrencies.keys()) {
        if (!monetaryBound.some((amount) => amount.currency === currency)) {
          throw new BudgetValidationError(
            `the reservation is missing a bound for capped currency ${currency}`,
          );
        }
      }
      for (const amount of monetaryBound) {
        const capAmount = capCurrencies.get(amount.currency);
        if (capAmount === undefined) {
          continue;
        }
        const committed = total.monetary.get(amount.currency) ?? 0n;
        if (
          compareAmounts(
            addAmounts(committed, parseAmount(amount.amount)),
            parseAmount(capAmount),
          ) > 0
        ) {
          throw new BudgetQuotaError(
            "BUDGET_LIMIT_EXCEEDED",
            level,
            `${level} ${amount.currency} budget has no room for this invocation`,
          );
        }
      }
    }
  }

  /**
   * Settle observed usage/cost. A re-settlement with identical content is a
   * no-op (redelivery); different content must use `reconcile` so history is
   * never rewritten.
   */
  settle(reservationId: string, settlement: BudgetSettlement): BudgetReservation {
    const reservation = this.requireReservation(reservationId);
    const validated = validateSettlement(settlement, "settlement");
    if (reservation.status === "released") {
      throw new BudgetConflictError(
        `reservation ${reservationId} was released and cannot be settled`,
      );
    }
    if (
      validated.usage !== undefined &&
      reservation.tokens.completeness !== null &&
      !sameUsage(reservation.tokens, validated.usage)
    ) {
      throw new BudgetConflictError(
        `reservation ${reservationId} usage is already settled; a correction must be reconciled`,
      );
    }
    if (validated.cost !== undefined) {
      for (const account of reservation.money) {
        if (account.completeness !== null && !sameCost(account, validated.cost)) {
          throw new BudgetConflictError(
            `reservation ${reservationId} ${account.currency} cost is already settled; a correction must be reconciled`,
          );
        }
      }
    }
    let identical = true;
    if (validated.usage !== undefined) {
      identical = identical && sameUsage(reservation.tokens, validated.usage);
    }
    if (validated.cost !== undefined) {
      identical =
        identical &&
        reservation.money.every((account) =>
          sameCost(account, validated.cost as NonNullable<BudgetSettlement["cost"]>),
        );
    }
    if (identical) {
      return reservation;
    }
    this.append({
      sequence: this.nextSequence(),
      kind: "settle",
      at: this.stamp(),
      reservation_id: reservationId,
      settlement: validated,
    });
    return this.requireReservation(reservationId);
  }

  /** Retain the reservation because the provider outcome is unknown. */
  requireReconciliation(reservationId: string, reason: string): BudgetReservation {
    const reservation = this.requireReservation(reservationId);
    const safeReason = requireString(reason, "reconciliation reason");
    if (reservation.status === "reconciling" && reservation.tokens.completeness === "unknown") {
      return reservation;
    }
    if (reservation.status === "released" || reservation.status === "settled") {
      throw new BudgetConflictError(
        `reservation ${reservationId} cannot require reconciliation from ${reservation.status}`,
      );
    }
    this.append({
      sequence: this.nextSequence(),
      kind: "reconciliation_required",
      at: this.stamp(),
      reservation_id: reservationId,
      reason: safeReason,
    });
    return this.requireReservation(reservationId);
  }

  /** Correct an already settled dimension; never rewrites the journal. */
  reconcile(reservationId: string, correction: BudgetCorrection): BudgetReservation {
    const reservation = this.requireReservation(reservationId);
    const validated = validateCorrection(correction, "correction");
    if (reservation.status === "released" || reservation.status === "held") {
      throw new BudgetConflictError(
        `reservation ${reservationId} has no settled dimension to reconcile`,
      );
    }
    for (const dimension of [validated.usage, validated.cost]) {
      if (dimension === undefined || !("amounts" in dimension)) continue;
      for (const amount of dimension.amounts) {
        if (!reservation.money.some((account) => account.currency === amount.currency)) {
          throw new BudgetValidationError(
            `correction currency ${amount.currency} was never reserved for ${reservationId}`,
          );
        }
      }
    }
    const fingerprint = JSON.stringify(validated);
    const already = this.journal.some(
      (entry) =>
        entry.kind === "reconcile" &&
        entry.reservation_id === reservationId &&
        JSON.stringify(entry.correction) === fingerprint,
    );
    if (already) {
      return this.requireReservation(reservationId);
    }
    this.append({
      sequence: this.nextSequence(),
      kind: "reconcile",
      at: this.stamp(),
      reservation_id: reservationId,
      correction: validated,
    });
    return this.requireReservation(reservationId);
  }

  /** Refund a reservation for an attempt that provably never left the gateway. */
  release(reservationId: string, reason: string): BudgetReservation {
    const reservation = this.requireReservation(reservationId);
    if (reservation.status === "released") {
      return reservation;
    }
    const safeReason = requireString(reason, "release reason");
    if (reservation.status !== "held") {
      throw new BudgetConflictError(
        `reservation ${reservationId} has observed usage and cannot be released`,
      );
    }
    this.append({
      sequence: this.nextSequence(),
      kind: "release",
      at: this.stamp(),
      reservation_id: reservationId,
      reason: safeReason,
    });
    return this.requireReservation(reservationId);
  }

  /**
   * Authority-internal read of one reservation by id. Callers outside the
   * authority must use the scoped {@link get}; this exists because settlement
   * is keyed by the reservation id the gateway already holds.
   */
  inspect(reservationId: string): BudgetReservation | undefined {
    const reservation = this.reservationsById.get(reservationId);
    return reservation === undefined ? undefined : structuredClone(reservation);
  }

  /** Scoped read of one reservation. */
  get(access: BudgetAccessScope, reservationId: string): BudgetReservation | undefined {
    this.assertScope(access);
    const reservation = this.reservationsById.get(reservationId);
    if (
      reservation !== undefined &&
      (reservation.identity.enterprise_id !== access.enterprise_id ||
        reservation.identity.workspace_id !== access.workspace_id)
    ) {
      throw new BudgetAccessError(
        `budget reservation ${reservationId} is outside the authenticated scope`,
      );
    }
    return reservation === undefined ? undefined : structuredClone(reservation);
  }

  /** Scoped, filtered read of reservations in arrival order. */
  list(access: BudgetAccessScope, filter: BudgetReservationFilter = {}): BudgetReservation[] {
    this.assertScope(access);
    if (filter.enterprise_id !== undefined && filter.enterprise_id !== access.enterprise_id) {
      throw new BudgetAccessError("filter enterprise_id does not match the authenticated scope");
    }
    if (filter.workspace_id !== undefined && filter.workspace_id !== access.workspace_id) {
      throw new BudgetAccessError("filter workspace_id does not match the authenticated scope");
    }
    return [...this.reservationsById.values()]
      .filter((reservation) => {
        if (reservation.identity.enterprise_id !== access.enterprise_id) return false;
        if (reservation.identity.workspace_id !== access.workspace_id) return false;
        if (filter.issue_id !== undefined && filter.issue_id !== reservation.identity.issue_id) {
          return false;
        }
        if (filter.run_id !== undefined && filter.run_id !== reservation.identity.run_id) {
          return false;
        }
        if (
          filter.invocation_id !== undefined &&
          filter.invocation_id !== reservation.identity.invocation_id
        ) {
          return false;
        }
        if (filter.trace_id !== undefined && filter.trace_id !== reservation.identity.trace_id) {
          return false;
        }
        if (filter.attempt !== undefined && filter.attempt !== reservation.identity.attempt) {
          return false;
        }
        if (filter.status !== undefined && filter.status !== reservation.status) {
          return false;
        }
        if (filter.needs_reconciliation === true && reservation.status !== "reconciling") {
          return false;
        }
        if (
          filter.since !== undefined &&
          Date.parse(reservation.created_at) < Date.parse(filter.since)
        ) {
          return false;
        }
        if (
          filter.until !== undefined &&
          Date.parse(reservation.created_at) > Date.parse(filter.until)
        ) {
          return false;
        }
        return true;
      })
      .map((reservation) => structuredClone(reservation));
  }

  /** Committed budget at one scope level. */
  scopeUsage(access: BudgetAccessScope, level: BudgetScopeLevel, runId?: string): BudgetScopeUsage {
    this.assertScope(access);
    if (!BUDGET_SCOPE_LEVELS.includes(level)) {
      throw new BudgetValidationError(`unknown budget scope level ${String(level)}`);
    }
    let key: string;
    if (level === "enterprise") {
      key = enterpriseKey(access.enterprise_id);
    } else if (level === "workspace") {
      key = workspaceKey(access.enterprise_id, access.workspace_id);
    } else {
      if (runId === undefined || runId === "") {
        throw new BudgetValidationError("run-level usage requires a run id");
      }
      key = runKey(access.enterprise_id, access.workspace_id, runId);
    }
    const total = this.totals.get(key) ?? zeroTotal();
    return {
      level,
      enterprise_id: access.enterprise_id,
      workspace_id: access.workspace_id,
      run_id: level === "run" ? (runId as string) : null,
      tokens: total.tokens,
      monetary: [...total.monetary.entries()]
        .map(([currency, amount]) => ({ currency, amount: formatAmount(amount) }))
        .sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    };
  }

  /** Scoped audit view of the journal entries for reservations in scope. */
  auditEntries(access: BudgetAccessScope): BudgetJournalEntry[] {
    this.assertScope(access);
    return this.journal
      .filter((entry) => {
        const reservation = this.reservationsById.get(entry.reservation_id);
        return (
          reservation !== undefined &&
          reservation.identity.enterprise_id === access.enterprise_id &&
          reservation.identity.workspace_id === access.workspace_id
        );
      })
      .map((entry) => structuredClone(entry));
  }

  /** True when a journal tail had to be repaired on load (tests/inspection). */
  get repairedTornTail(): boolean {
    return this.closedTailRepaired;
  }

  private assertScope(access: BudgetAccessScope): void {
    requireString(access.enterprise_id, "access.enterprise_id");
    requireString(access.workspace_id, "access.workspace_id");
    requireString(access.subject, "access.subject");
  }
}

/** Convenience constructor mirroring the other store modules. */
export function createBudgetStore(options: BudgetStoreOptions = {}): BudgetStore {
  return new BudgetStore(options);
}
