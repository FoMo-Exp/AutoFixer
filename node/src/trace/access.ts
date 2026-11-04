/**
 * Separate authorization for content access and quarantine access (DAT-225).
 *
 * ADR-0008 keeps these apart: financial access does not imply prompt-content
 * access, and workspace access does not imply quarantine access. This module
 * carries that rule into code with two independent capability seams —
 * {@link ContentVault} holds captured (already redacted) content records and
 * only releases them under a content grant, while {@link QuarantineVault}
 * holds raw source material for security investigations (the ADR-0005
 * quarantine, the one place secret-bearing material may live) and only
 * releases it under a quarantine grant. Neither grant type is accepted by the
 * other vault, and grants only count when their own authorizer minted them
 * after a server-side policy check — callers assert identity, never
 * permission.
 */
import { redactSensitiveText } from "../errors/redact.js";
import { TraceConflictError } from "./errors.js";

import type { CapturedMaterial, MaterialKind } from "./content.js";

// ---------------------------------------------------------------------------
// Content access
// ---------------------------------------------------------------------------

/** Server-side role check for content reads, injected at service bootstrap. */
export interface ContentAccessPolicy {
  mayReadContent(subject: string): boolean;
}

/** Fail-closed default: nobody reads content until a policy says otherwise. */
export const DENY_ALL_CONTENT: ContentAccessPolicy = Object.freeze({
  mayReadContent: (_subject: string): boolean => false,
});

export class ContentAccessDenied extends Error {
  readonly code = "CONTENT_ACCESS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "ContentAccessDenied";
  }
}

/** Capability to read captured content; only valid when authorizer-minted. */
export class ContentGrant {
  readonly subject: string;

  constructor(subject: string) {
    this.subject = subject;
  }
}

// ---------------------------------------------------------------------------
// Quarantine access
// ---------------------------------------------------------------------------

/**
 * Server-side role check for ADR-0005 quarantine reads — access to the raw,
 * secret-bearing source material a security investigation requires.
 */
export interface QuarantineAccessPolicy {
  mayReadQuarantine(subject: string): boolean;
}

/** Fail-closed default: nobody reads quarantine material until a policy says so. */
export const DENY_ALL_QUARANTINE: QuarantineAccessPolicy = Object.freeze({
  mayReadQuarantine: (_subject: string): boolean => false,
});

export class QuarantineAccessDenied extends Error {
  readonly code = "QUARANTINE_ACCESS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "QuarantineAccessDenied";
  }
}

export class QuarantineConflictError extends Error {
  readonly code = "QUARANTINE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "QuarantineConflictError";
  }
}

/** Capability to read quarantine material; only valid when authorizer-minted. */
export class QuarantineGrant {
  readonly subject: string;

  constructor(subject: string) {
    this.subject = subject;
  }
}

// ---------------------------------------------------------------------------
// Authorizers: the only way to obtain a grant
// ---------------------------------------------------------------------------

const contentGrantIssuers = new WeakMap<ContentGrant, ContentAccessAuthorizer>();

export class ContentAccessAuthorizer {
  private readonly policy: ContentAccessPolicy;

  constructor(policy: ContentAccessPolicy = DENY_ALL_CONTENT) {
    this.policy = policy;
  }

  authorize(subject: string): ContentGrant {
    if (typeof subject !== "string" || subject.length === 0) {
      throw new ContentAccessDenied("an authenticated subject is required");
    }
    if (this.policy.mayReadContent(subject) !== true) {
      throw new ContentAccessDenied("the content access policy does not grant this subject access");
    }
    const grant = new ContentGrant(subject);
    contentGrantIssuers.set(grant, this);
    return grant;
  }

  owns(grant: ContentGrant | null | undefined): boolean {
    return grant != null && contentGrantIssuers.get(grant) === this;
  }
}

const quarantineGrantIssuers = new WeakMap<QuarantineGrant, QuarantineAccessAuthorizer>();

export class QuarantineAccessAuthorizer {
  private readonly policy: QuarantineAccessPolicy;

  constructor(policy: QuarantineAccessPolicy = DENY_ALL_QUARANTINE) {
    this.policy = policy;
  }

  authorize(subject: string): QuarantineGrant {
    if (typeof subject !== "string" || subject.length === 0) {
      throw new QuarantineAccessDenied("an authenticated subject is required");
    }
    if (this.policy.mayReadQuarantine(subject) !== true) {
      throw new QuarantineAccessDenied(
        "the quarantine access policy does not grant this subject access",
      );
    }
    const grant = new QuarantineGrant(subject);
    quarantineGrantIssuers.set(grant, this);
    return grant;
  }

  owns(grant: QuarantineGrant | null | undefined): boolean {
    return grant != null && quarantineGrantIssuers.get(grant) === this;
  }
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

/**
 * Holds captured content records — the redacted output of the DAT-225
 * capture gate. Deposits are re-scanned with the shared blunt pass as
 * defense in depth, so a misrouted raw string still cannot rest here
 * unredacted. Reads need a content grant minted by this vault's authorizer.
 */
export class ContentVault {
  private readonly records = new Map<string, CapturedMaterial>();
  private readonly authorizer: ContentAccessAuthorizer;

  constructor(authorizer: ContentAccessAuthorizer) {
    this.authorizer = authorizer;
  }

  deposit(captured: CapturedMaterial): void {
    if (this.records.has(captured.record_id)) {
      throw new TraceConflictError(
        `captured content ${captured.record_id} is already deposited; records are never rewritten`,
      );
    }
    const text = captured.text;
    this.records.set(captured.record_id, {
      ...captured,
      data_classes: [...captured.data_classes],
      text: text === null ? null : redactSensitiveText(text),
    });
  }

  read(recordId: string, grant: ContentGrant | null | undefined): CapturedMaterial {
    if (!this.authorizer.owns(grant)) {
      throw new ContentAccessDenied(
        "reading captured content requires a content grant minted by this vault's authorizer",
      );
    }
    const record = this.records.get(recordId);
    if (record === undefined) {
      throw new ContentAccessDenied("no captured content recorded for this record id");
    }
    return {
      ...record,
      data_classes: [...record.data_classes],
      scan: {
        ...record.scan,
        findings: { ...record.scan.findings },
        detectors: [...record.scan.detectors],
      },
    };
  }

  has(recordId: string): boolean {
    return this.records.has(recordId);
  }

  get size(): number {
    return this.records.size;
  }
}

/** One sealed raw source record: the ADR-0005 security-investigation material. */
export interface QuarantinedSourceMaterial {
  readonly case_ref: string;
  readonly captured_at: string;
  readonly deposited_by: string;
  readonly reason: string;
  readonly kind: MaterialKind;
  /**
   * Raw source material exactly as captured. This vault is the one place it
   * may live; it is never redacted here (redaction would destroy the
   * evidence), never exported, and only readable under a quarantine grant.
   */
  readonly text: string;
}

export interface QuarantineDeposit {
  case_ref: string;
  kind: MaterialKind;
  text: string;
  deposited_by: string;
  reason: string;
  captured_at?: string;
}

/**
 * Holds raw secret-bearing source material for security investigations.
 * Deposits record provenance; reads need a quarantine grant minted by this
 * vault's authorizer, checked before the lookup so an unauthorized caller
 * cannot probe which cases exist.
 */
export class QuarantineVault {
  private readonly cases = new Map<string, QuarantinedSourceMaterial>();
  private readonly authorizer: QuarantineAccessAuthorizer;
  private readonly now: () => Date;

  constructor(authorizer: QuarantineAccessAuthorizer, options: { now?: () => Date } = {}) {
    this.authorizer = authorizer;
    this.now = options.now ?? (() => new Date());
  }

  deposit(input: QuarantineDeposit): QuarantinedSourceMaterial {
    if (typeof input.case_ref !== "string" || input.case_ref.length === 0) {
      throw new QuarantineConflictError("a quarantine case_ref is required");
    }
    if (typeof input.text !== "string" || typeof input.reason !== "string") {
      throw new QuarantineConflictError("quarantine deposits need text and a reason");
    }
    if (this.cases.has(input.case_ref)) {
      throw new QuarantineConflictError(
        `quarantine case ${input.case_ref} already holds source material`,
      );
    }
    const sealed: QuarantinedSourceMaterial = {
      case_ref: input.case_ref,
      captured_at: input.captured_at ?? this.now().toISOString(),
      deposited_by: input.deposited_by,
      reason: input.reason,
      kind: input.kind,
      text: input.text,
    };
    this.cases.set(sealed.case_ref, sealed);
    return { ...sealed };
  }

  read(caseRef: string, grant: QuarantineGrant | null | undefined): QuarantinedSourceMaterial {
    if (!this.authorizer.owns(grant)) {
      throw new QuarantineAccessDenied(
        "reading quarantine material requires a quarantine grant minted by this vault's authorizer",
      );
    }
    const record = this.cases.get(caseRef);
    if (record === undefined) {
      throw new QuarantineAccessDenied("no quarantine source material recorded for this case");
    }
    return { ...record };
  }

  has(caseRef: string): boolean {
    return this.cases.has(caseRef);
  }

  get size(): number {
    return this.cases.size;
  }
}
