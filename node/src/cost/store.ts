/**
 * Append-only cost store (DAT-228).
 *
 * Rate revisions, postings, adjustments and FX quotes are immutable once
 * written: a redelivery of the same record with identical content is
 * deduplicated by its identity, and a redelivery that changes content is
 * refused instead of rewriting financial evidence. Every read runs inside the
 * caller's authenticated enterprise/workspace scope; asking for another
 * workspace is refused, not filtered into silence.
 *
 * Postings are priced against the revisions recorded at that moment and
 * snapshot their bound rate revisions, so recording a new rate later never
 * reprices anything already posted. Corrections arrive as linked adjustments
 * (`recordAdjustment`) that must target a recorded posting of the same scope —
 * the trail from posting to net amount is fully replayable.
 *
 * Durability contract (mirroring the usage ledger): every write appends to
 * the durable file before it returns; its return confirms persistence and its
 * throw confirms the record was NOT written. There is no deferred buffer and
 * no shutdown flush to forget.
 */
import fs from "node:fs";
import path from "node:path";

import { buildAdjustment, resolveRebindRevision, validateAdjustmentEntry } from "./adjustments.js";
import {
  CostAccessError,
  CostConflictError,
  CostValidationError,
  CostWriteError,
} from "./errors.js";
import { buildFxQuote, validateFxQuote } from "./fx.js";
import {
  computeInfrastructureCost,
  computeInvocationCost,
  validateCostPosting,
} from "./pricing.js";
import { buildRateCardRevision, rateRevisionKey, validateRateCardRevision } from "./rate-card.js";
import type {
  AdjustmentEntry,
  AdjustmentInput,
  CostCompleteness,
  CostLedgerEntry,
  CostPosting,
  CostableInvocation,
  FxQuote,
  FxQuoteInput,
  InfrastructureCostInput,
  RateCardRevision,
  RateCardRevisionInput,
} from "./types.js";

/** Authenticated caller context; reads are confined to this enterprise/workspace. */
export interface CostAccessScope {
  enterprise_id: string;
  workspace_id: string;
  /** Who is asking; kept for downstream audit of financial reads. */
  subject: string;
}

export interface CostPostingFilter {
  /** Refused when it disagrees with the authenticated scope. */
  enterprise_id?: string;
  /** Refused when it disagrees with the authenticated scope. */
  workspace_id?: string;
  kind?: "invocation" | "infrastructure";
  invocation_id?: string;
  attempt?: number;
  endpoint_id?: string;
  model_id?: string;
  completeness?: CostCompleteness;
  /** Inclusive RFC 3339 bounds on the posting's applicable_time. */
  since?: string;
  until?: string;
}

export interface CostStoreOptions {
  /** A private durable cost file. Omit for a process-local store in tests. */
  persistencePath?: string;
  /** Clock used for store stamps and validation defaults. */
  now?: () => Date;
}

type CostRecordType = "rate_revision" | "posting" | "adjustment" | "fx_quote";

interface StoredRecord {
  record_type: CostRecordType;
  payload: RateCardRevision | CostPosting | AdjustmentEntry | FxQuote;
  /** Writer-owned content; excludes the store-stamped time. */
  fingerprint: string;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function identityOf(record: StoredRecord): string {
  switch (record.record_type) {
    case "rate_revision":
      return `rate_revision:${(record.payload as RateCardRevision).revision_id}`;
    case "posting":
      return `posting:${(record.payload as CostPosting).posting_id}`;
    case "adjustment":
      return `adjustment:${(record.payload as AdjustmentEntry).adjustment_id}`;
    case "fx_quote":
      return `fx_quote:${(record.payload as FxQuote).quote_id}`;
  }
}

/** The store stamps one time field per record type; the fingerprint excludes it. */
function fingerprintOf(record_type: CostRecordType, payload: unknown): string {
  const value = payload as Record<string, unknown>;
  const stamped = record_type === "adjustment" ? "created_at" : "recorded_at";
  const { [stamped]: _stampedAt, ...writerFields } = value;
  return JSON.stringify(writerFields);
}

function parseStoredPayload(recordType: CostRecordType, payload: unknown): StoredRecord["payload"] {
  switch (recordType) {
    case "rate_revision":
      return validateRateCardRevision(payload);
    case "posting":
      return validateCostPosting(payload);
    case "adjustment":
      return validateAdjustmentEntry(payload);
    case "fx_quote":
      return validateFxQuote(payload);
  }
}

export class CostStore {
  /** Insertion order is arrival order. */
  private readonly records = new Map<string, StoredRecord>();
  private readonly persistencePath: string | undefined;
  private readonly now: () => Date;

  constructor(options: CostStoreOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /**
   * Record one immutable rate revision. An identical redelivery of the same
   * revision id returns the recorded revision; a changed redelivery is
   * refused. Two DIFFERENT revisions with the same binding key and the same
   * effective start would make rate binding ambiguous, so the second is
   * refused — revisions are never rewritten or merged.
   */
  addRateRevision(input: RateCardRevisionInput): RateCardRevision {
    const revision = buildRateCardRevision(input, this.now().toISOString());
    const key = rateRevisionKey(revision);
    for (const record of this.records.values()) {
      if (record.record_type !== "rate_revision") {
        continue;
      }
      const existing = record.payload as RateCardRevision;
      if (existing.revision_id === revision.revision_id) {
        // Identity semantics belong to the write path: identical redelivery
        // deduplicates and returns the recorded revision, changed content
        // conflicts there.
        continue;
      }
      if (
        rateRevisionKey(existing) === key &&
        Date.parse(existing.effective_from) === Date.parse(revision.effective_from)
      ) {
        throw new CostConflictError(
          `rate revision for the same scope and effective start ${revision.effective_from} ` +
            "is already recorded under another revision id; overlapping identical starts " +
            "would make binding ambiguous",
        );
      }
    }
    return this.commit("rate_revision", revision, revision.revision_id);
  }

  /**
   * Price and record one invocation attempt against the revisions recorded in
   * its enterprise/workspace. A redelivery of identical content deduplicates;
   * a redelivery with different content is refused — the posting of an
   * attempt can never be silently repriced.
   */
  recordInvocationCost(invocation: CostableInvocation): CostPosting {
    const revisions = this.revisionsFor(invocation.enterprise_id, invocation.workspace_id);
    const posting = computeInvocationCost(invocation, revisions, this.now().toISOString());
    return this.commit("posting", posting, posting.posting_id);
  }

  /** Price and record one measured self-hosted infrastructure charge. */
  recordInfrastructureCost(input: InfrastructureCostInput): CostPosting {
    const revisions = this.revisionsFor(input.enterprise_id, input.workspace_id);
    const posting = computeInfrastructureCost(input, revisions, this.now().toISOString());
    return this.commit("posting", posting, posting.posting_id);
  }

  /**
   * Record a linked correction against a recorded posting. The target must
   * exist in the same enterprise/workspace and carry every corrected category
   * as a chargeable line — a correction always points at real financial
   * evidence and never rewrites it.
   */
  recordAdjustment(input: AdjustmentInput): AdjustmentEntry {
    const adjustment = buildAdjustment(input, this.now().toISOString());
    const target = this.findPosting(adjustment.target_posting_id);
    if (!target) {
      throw new CostValidationError(
        `adjustment ${adjustment.adjustment_id} targets posting ` +
          `${adjustment.target_posting_id}, which is not recorded`,
      );
    }
    if (
      target.enterprise_id !== adjustment.enterprise_id ||
      target.workspace_id !== adjustment.workspace_id
    ) {
      throw new CostAccessError(
        "adjustments are confined to the enterprise/workspace of their target posting",
      );
    }
    for (const correction of adjustment.components) {
      const component = target.components.find((line) => line.category === correction.category);
      if (!component) {
        throw new CostValidationError(
          `adjustment ${adjustment.adjustment_id} corrects category ${correction.category}, ` +
            "which the target posting does not carry",
        );
      }
      if (!component.chargeable) {
        throw new CostValidationError(
          `adjustment ${adjustment.adjustment_id} corrects category ${correction.category}, ` +
            "which the posting records as included and never charges",
        );
      }
      if (correction.corrected_rate_revision_id !== null) {
        // Persist only corrections whose rebind names a recorded, compatible
        // rate revision — a stored adjustment must always be replayable.
        resolveRebindRevision(
          correction,
          component,
          target,
          adjustment,
          this.revisionsFor(adjustment.enterprise_id, adjustment.workspace_id),
        );
      }
    }
    return this.commit("adjustment", adjustment, adjustment.adjustment_id);
  }

  /** Record one immutable FX quote; quote ids are unique, quotes are never rewritten. */
  addFxQuote(input: FxQuoteInput): FxQuote {
    const quote = buildFxQuote(input, this.now().toISOString());
    return this.commit("fx_quote", quote, quote.quote_id);
  }

  /** Recorded revisions of the scope, in recording order. */
  rateRevisions(scope: CostAccessScope): RateCardRevision[] {
    this.assertAuthenticated(scope);
    const out: RateCardRevision[] = [];
    for (const record of this.records.values()) {
      if (record.record_type !== "rate_revision") {
        continue;
      }
      const revision = record.payload as RateCardRevision;
      if (
        revision.enterprise_id === scope.enterprise_id &&
        revision.workspace_id === scope.workspace_id
      ) {
        out.push(structuredClone(revision));
      }
    }
    return out;
  }

  /** Recorded postings of the scope, in recording order, as defensive copies. */
  postings(scope: CostAccessScope, filter?: CostPostingFilter): CostPosting[] {
    this.assertAuthenticated(scope);
    this.assertReadPreconditions(scope, filter);
    const out: CostPosting[] = [];
    for (const record of this.records.values()) {
      if (record.record_type !== "posting") {
        continue;
      }
      const posting = record.payload as CostPosting;
      if (
        posting.enterprise_id !== scope.enterprise_id ||
        posting.workspace_id !== scope.workspace_id
      ) {
        continue;
      }
      if (matchesPostingFilter(filter, posting)) {
        out.push(structuredClone(posting));
      }
    }
    return out;
  }

  /** Adjustments of the scope, in recording order; optionally only those targeting one posting. */
  adjustments(scope: CostAccessScope, targetPostingId?: string): AdjustmentEntry[] {
    this.assertAuthenticated(scope);
    if (targetPostingId !== undefined) {
      const target = this.findPosting(targetPostingId);
      if (
        target &&
        (target.enterprise_id !== scope.enterprise_id || target.workspace_id !== scope.workspace_id)
      ) {
        throw new CostAccessError(
          "adjustment reads are scoped to the caller's workspace; refusing cross-workspace query",
        );
      }
    }
    const out: AdjustmentEntry[] = [];
    for (const record of this.records.values()) {
      if (record.record_type !== "adjustment") {
        continue;
      }
      const adjustment = record.payload as AdjustmentEntry;
      if (
        adjustment.enterprise_id !== scope.enterprise_id ||
        adjustment.workspace_id !== scope.workspace_id
      ) {
        continue;
      }
      if (targetPostingId === undefined || adjustment.target_posting_id === targetPostingId) {
        out.push(structuredClone(adjustment));
      }
    }
    return out;
  }

  /** FX quotes of the scope, in recording order. */
  fxQuotes(scope: CostAccessScope): FxQuote[] {
    this.assertAuthenticated(scope);
    const out: FxQuote[] = [];
    for (const record of this.records.values()) {
      if (record.record_type !== "fx_quote") {
        continue;
      }
      const quote = record.payload as FxQuote;
      if (
        quote.enterprise_id === scope.enterprise_id &&
        quote.workspace_id === scope.workspace_id
      ) {
        out.push(structuredClone(quote));
      }
    }
    return out;
  }

  /**
   * Postings with their adjustments attached in recording order — the input
   * shape of `summarizeCosts` and `netPosting`.
   */
  entries(scope: CostAccessScope, filter?: CostPostingFilter): CostLedgerEntry[] {
    return this.postings(scope, filter).map((posting) => ({
      posting,
      adjustments: this.adjustments(scope, posting.posting_id),
    }));
  }

  /** Recorded revisions of exactly one enterprise/workspace, for pricing paths. */
  private revisionsFor(enterpriseId: string, workspaceId: string): RateCardRevision[] {
    const out: RateCardRevision[] = [];
    for (const record of this.records.values()) {
      if (record.record_type !== "rate_revision") {
        continue;
      }
      const revision = record.payload as RateCardRevision;
      if (revision.enterprise_id === enterpriseId && revision.workspace_id === workspaceId) {
        out.push(revision);
      }
    }
    return out;
  }

  private findPosting(postingId: string): CostPosting | null {
    const record = this.records.get(`posting:${postingId}`);
    return record ? (record.payload as CostPosting) : null;
  }

  /**
   * The one write path: durable append first (its failure means the record is
   * recorded nowhere), then the in-memory index. A redelivery of identical
   * content deduplicates and returns the recorded record; different content
   * under the same identity is refused.
   */
  private commit<T extends StoredRecord["payload"]>(
    recordType: CostRecordType,
    payload: T,
    id: string,
  ): T {
    const identity = `${recordType}:${id}`;
    const fingerprint = fingerprintOf(recordType, payload);
    const existing = this.records.get(identity);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CostConflictError(
          `cost ${recordType} ${id} is already recorded with different content; ` +
            "financial evidence is immutable",
        );
      }
      return existing.payload as T;
    }
    if (this.persistencePath) {
      try {
        this.appendDurable({ record_type: recordType, payload, fingerprint });
      } catch (error) {
        throw new CostWriteError(`cost ${recordType} ${id} could not be persisted`, {
          cause: error,
        });
      }
    }
    this.records.set(identity, { record_type: recordType, payload, fingerprint });
    return payload;
  }

  /** One durable append per record; synchronous, 0600, one JSONL line. */
  private appendDurable(record: StoredRecord): void {
    if (!this.persistencePath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      this.persistencePath,
      `${JSON.stringify({ record_type: record.record_type, payload: record.payload })}\n`,
      { mode: 0o600 },
    );
  }

  private assertAuthenticated(scope: CostAccessScope): void {
    for (const [name, value] of Object.entries({
      enterprise_id: scope.enterprise_id,
      workspace_id: scope.workspace_id,
      subject: scope.subject,
    })) {
      if (typeof value !== "string" || value.length === 0) {
        throw new CostValidationError(`access scope ${name} must be a non-empty string`);
      }
    }
  }

  private assertReadPreconditions(
    scope: CostAccessScope,
    filter: CostPostingFilter | undefined,
  ): void {
    if (!filter) {
      return;
    }
    if (filter.enterprise_id !== undefined && filter.enterprise_id !== scope.enterprise_id) {
      throw new CostAccessError(
        `cost reads are scoped to enterprise ${scope.enterprise_id}; refusing cross-enterprise query`,
      );
    }
    if (filter.workspace_id !== undefined && filter.workspace_id !== scope.workspace_id) {
      throw new CostAccessError(
        `cost reads are scoped to workspace ${scope.workspace_id}; refusing cross-workspace query`,
      );
    }
    // A malformed bound would silently match nothing; refuse it instead.
    if (filter.since !== undefined && !TIMESTAMP_PATTERN.test(filter.since)) {
      throw new CostValidationError('cost filter "since" must be an RFC 3339 timestamp');
    }
    if (filter.until !== undefined && !TIMESTAMP_PATTERN.test(filter.until)) {
      throw new CostValidationError('cost filter "until" must be an RFC 3339 timestamp');
    }
    if (filter.attempt !== undefined && (!Number.isInteger(filter.attempt) || filter.attempt < 1)) {
      throw new CostValidationError('cost filter "attempt" must be an integer starting at 1');
    }
  }

  /**
   * Load the durable cost file: one record per line (JSONL), each line
   * validated exactly like a fresh write.
   *
   * Every newline-terminated line is a complete write and must parse AND
   * validate — either failure is corruption and refuses startup, never a torn
   * append. Only the unterminated tail can hold an interrupted append, and it
   * is tolerated only when its bytes are a confirmed-incomplete JSON prefix
   * (the debris of an append whose write already failed loudly when it
   * happened); complete-but-invalid JSON there is corruption too. Recovery
   * rewrites the file to the accepted record boundary so later appends can
   * never run into dropped debris.
   */
  private load(): void {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) {
      return;
    }
    const segments = fs.readFileSync(this.persistencePath, "utf8").split("\n");
    const tail = segments[segments.length - 1] ?? "";
    const lines = segments.slice(0, -1);
    const acceptedLines: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line === "") {
        continue;
      }
      this.insertLoaded(line, index + 1);
      acceptedLines.push(line);
    }
    let tailLine: string | null = tail;
    if (tail !== "") {
      try {
        this.insertLoaded(tail, segments.length);
        acceptedLines.push(tail);
      } catch (error) {
        if (error instanceof CostValidationError && scanJsonPrefix(tail) === "incomplete") {
          // Confirmed incomplete: dropped at the record boundary, visible
          // instead of silent.
          tailLine = null;
          console.error(
            "cost store: dropping interrupted trailing append (its write failed when it happened)",
          );
        } else {
          throw error;
        }
      }
    }
    // Repair the durable file to the accepted record boundary.
    this.rewriteDurable(
      acceptedLines.map((line) => `${line}\n`).join("") +
        (tailLine !== null ? `${tailLine}\n` : ""),
    );
  }

  private insertLoaded(line: string, lineNumber: number): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch (error) {
      throw new CostValidationError(
        `cost record on line ${lineNumber} is corrupt; refusing to drop history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const wrapper = envelope as Record<string, unknown>;
    const recordType = wrapper["record_type"];
    if (
      recordType !== "rate_revision" &&
      recordType !== "posting" &&
      recordType !== "adjustment" &&
      recordType !== "fx_quote"
    ) {
      throw new CostValidationError(
        `cost record on line ${lineNumber} has unknown record_type; refusing to drop history`,
      );
    }
    const payload = parseStoredPayload(recordType, wrapper["payload"]);
    const identity = identityOf({ record_type: recordType, payload, fingerprint: "" });
    const fingerprint = fingerprintOf(recordType, payload);
    const existing = this.records.get(identity);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CostConflictError(
          `persisted cost record ${identity} appears twice with different content`,
        );
      }
      return;
    }
    this.records.set(identity, { record_type: recordType, payload, fingerprint });
  }

  /** Atomically rewrite the durable file to a known record boundary. */
  private rewriteDurable(canonical: string): void {
    if (!this.persistencePath) {
      return;
    }
    const temporary = `${this.persistencePath}.${process.pid}.repair.tmp`;
    fs.writeFileSync(temporary, canonical, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.persistencePath);
  }
}

function matchesPostingFilter(
  filter: CostPostingFilter | undefined,
  posting: CostPosting,
): boolean {
  if (!filter) {
    return true;
  }
  const exact: Array<[string | undefined, string | null]> = [
    [filter.invocation_id, posting.invocation_id],
    [filter.endpoint_id, posting.endpoint_id],
    [filter.model_id, posting.model_id],
  ];
  for (const [wanted, actual] of exact) {
    if (wanted !== undefined && wanted !== actual) {
      return false;
    }
  }
  if (filter.kind !== undefined && filter.kind !== posting.kind) {
    return false;
  }
  if (filter.attempt !== undefined && filter.attempt !== posting.attempt) {
    return false;
  }
  if (filter.completeness !== undefined && filter.completeness !== posting.completeness) {
    return false;
  }
  if (
    filter.since !== undefined &&
    Date.parse(posting.applicable_time) < Date.parse(filter.since)
  ) {
    return false;
  }
  if (
    filter.until !== undefined &&
    Date.parse(posting.applicable_time) > Date.parse(filter.until)
  ) {
    return false;
  }
  return true;
}

type JsonScan = "complete" | "incomplete" | "invalid";

/**
 * Classify a JSON text as a complete value, a confirmed-incomplete prefix
 * (every byte so far can still continue into valid JSON, but the value is
 * unfinished — the signature of an append interrupted mid-write), or invalid
 * bytes. Only "incomplete" qualifies for torn-tail tolerance; anything else
 * is corruption.
 */
function scanJsonPrefix(text: string): JsonScan {
  let index = 0;

  const peek = (): string | null => (index < text.length ? (text[index] as string) : null);

  const skipWhitespace = (): void => {
    while (index < text.length && " \t\r\n".includes(text[index] as string)) {
      index += 1;
    }
  };

  const scanLiteral = (word: string): JsonScan | "ok" => {
    for (const char of word) {
      if (index >= text.length) {
        return "incomplete";
      }
      if (text[index] !== char) {
        return "invalid";
      }
      index += 1;
    }
    return "ok";
  };

  const scanNumber = (): JsonScan | "ok" => {
    if (peek() === "-") {
      index += 1;
    }
    if (peek() === "0") {
      index += 1;
    } else if (peek() !== null && (peek() as string) >= "1" && (peek() as string) <= "9") {
      while (peek() !== null && (peek() as string) >= "0" && (peek() as string) <= "9") {
        index += 1;
      }
    } else {
      return peek() === null ? "incomplete" : "invalid";
    }
    if (peek() === ".") {
      index += 1;
      const first = peek();
      if (first === null) {
        return "incomplete";
      }
      if (first < "0" || first > "9") {
        return "invalid";
      }
      while (peek() !== null && (peek() as string) >= "0" && (peek() as string) <= "9") {
        index += 1;
      }
    }
    if (peek() === "e" || peek() === "E") {
      index += 1;
      if (peek() === "+" || peek() === "-") {
        index += 1;
      }
      const first = peek();
      if (first === null) {
        return "incomplete";
      }
      if (first < "0" || first > "9") {
        return "invalid";
      }
      while (peek() !== null && (peek() as string) >= "0" && (peek() as string) <= "9") {
        index += 1;
      }
    }
    return "ok";
  };

  const scanString = (): JsonScan | "ok" => {
    // The opening quote is consumed by the caller.
    for (;;) {
      if (index >= text.length) {
        return "incomplete";
      }
      const char = text[index] as string;
      index += 1;
      if (char === "\\") {
        if (index >= text.length) {
          return "incomplete";
        }
        index += 1;
        continue;
      }
      if (char === '"') {
        return "ok";
      }
      if (char < " ") {
        return "invalid";
      }
    }
  };

  const scanValue = (): JsonScan | "ok" => {
    skipWhitespace();
    const char = peek();
    if (char === null) {
      return "incomplete";
    }
    if (char === "{") {
      index += 1;
      return scanObject();
    }
    if (char === "[") {
      index += 1;
      return scanArray();
    }
    if (char === '"') {
      index += 1;
      return scanString();
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      return scanNumber();
    }
    if (char === "t") {
      return scanLiteral("true");
    }
    if (char === "f") {
      return scanLiteral("false");
    }
    if (char === "n") {
      return scanLiteral("null");
    }
    return "invalid";
  };

  const scanObject = (): JsonScan | "ok" => {
    skipWhitespace();
    if (peek() === null) {
      return "incomplete";
    }
    if (peek() === "}") {
      index += 1;
      return "ok";
    }
    for (;;) {
      skipWhitespace();
      const char = peek();
      if (char === null) {
        return "incomplete";
      }
      if (char !== '"') {
        return "invalid";
      }
      index += 1;
      const key = scanString();
      if (key !== "ok") {
        return key;
      }
      skipWhitespace();
      const colon = peek();
      if (colon === null) {
        return "incomplete";
      }
      if (colon !== ":") {
        return "invalid";
      }
      index += 1;
      const value = scanValue();
      if (value !== "ok") {
        return value;
      }
      skipWhitespace();
      const next = peek();
      if (next === null) {
        return "incomplete";
      }
      if (next === ",") {
        index += 1;
        continue;
      }
      if (next === "}") {
        index += 1;
        return "ok";
      }
      return "invalid";
    }
  };

  const scanArray = (): JsonScan | "ok" => {
    skipWhitespace();
    if (peek() === null) {
      return "incomplete";
    }
    if (peek() === "]") {
      index += 1;
      return "ok";
    }
    for (;;) {
      const value = scanValue();
      if (value !== "ok") {
        return value;
      }
      skipWhitespace();
      const next = peek();
      if (next === null) {
        return "incomplete";
      }
      if (next === ",") {
        index += 1;
        continue;
      }
      if (next === "]") {
        index += 1;
        return "ok";
      }
      return "invalid";
    }
  };

  const scanned = scanValue();
  if (scanned === "invalid") {
    return "invalid";
  }
  if (scanned === "incomplete") {
    return "incomplete";
  }
  skipWhitespace();
  return index >= text.length ? "complete" : "invalid";
}
