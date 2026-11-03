/**
 * Sensitive diagnostics behind a separate access check (DAT-226).
 *
 * The error envelope is safe to show to agents and humans; the raw failure
 * detail behind it is not. Diagnostics are sealed at capture time (secret
 * redaction included) and can only be read with a {@link DiagnosticGrant}
 * minted by a {@link DiagnosticsAuthorizer} that consults a server-side
 * access policy first. The grant is capability-shaped: plain objects — or a
 * caller-constructed {@link DiagnosticGrant} — are never accepted, so no
 * caller can self-assert diagnostics access. The check runs before the
 * record lookup, so an unauthorized caller cannot probe which cases exist
 * either (ADR-0008: content, financial, and quarantine access stay separate).
 */
import { redactSensitiveText } from "./redact.js";

export interface SensitiveDiagnostics {
  /** Correlation reference shared with the envelope's `trace_ref.case_ref`. */
  readonly case_ref: string | null;
  /** Origin code (dsh, gateway, trace) before mapping into the catalog. */
  readonly origin_code: string | null;
  /** RFC 3339 capture time. */
  readonly captured_at: string;
  /** Raw-ish failure detail, already secret-redacted. Never in an envelope. */
  readonly detail: string;
}

/**
 * Server-side role check for diagnostics reads. The policy — injected at
 * service bootstrap, not supplied per call — decides whether an authenticated
 * subject may read sensitive diagnostics.
 */
export interface DiagnosticAccessPolicy {
  mayReadDiagnostics(subject: string): boolean;
}

/** Fail-closed default: nobody reads diagnostics until a policy says otherwise. */
export const DENY_ALL_DIAGNOSTICS: DiagnosticAccessPolicy = Object.freeze({
  mayReadDiagnostics: (_subject: string): boolean => false,
});

/** A read that lacks a valid, policy-authorized diagnostics grant. */
export class SensitiveDiagnosticsAccessDenied extends Error {
  readonly code = "SENSITIVE_DIAGNOSTICS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "SensitiveDiagnosticsAccessDenied";
  }
}

/**
 * A capability to read one vault's diagnostics.
 *
 * Instances only become valid when {@link DiagnosticsAuthorizer} mints them
 * after its policy check. A caller-constructed instance is just an object:
 * it is not registered here and is refused everywhere.
 */
export class DiagnosticGrant {
  readonly subject: string;

  constructor(subject: string) {
    this.subject = subject;
  }
}

const issuedGrants = new WeakSet<DiagnosticGrant>();
const grantIssuers = new WeakMap<DiagnosticGrant, DiagnosticsAuthorizer>();

/**
 * The trusted minting authority. It performs the server-side permission
 * check — the caller asserts an identity, never a permission — and only then
 * issues a grant. Grants are bound to the authorizer that minted them, so a
 * vault only accepts its own authorizer's grants.
 */
export class DiagnosticsAuthorizer {
  private readonly policy: DiagnosticAccessPolicy;

  constructor(policy: DiagnosticAccessPolicy = DENY_ALL_DIAGNOSTICS) {
    this.policy = policy;
  }

  authorize(subject: string): DiagnosticGrant {
    if (typeof subject !== "string" || subject.length === 0) {
      throw new SensitiveDiagnosticsAccessDenied("an authenticated subject is required");
    }
    if (this.policy.mayReadDiagnostics(subject) !== true) {
      throw new SensitiveDiagnosticsAccessDenied(
        "the diagnostics access policy does not grant this subject access",
      );
    }
    const grant = new DiagnosticGrant(subject);
    issuedGrants.add(grant);
    grantIssuers.set(grant, this);
    return grant;
  }

  /** Whether this authorizer minted the grant (vault binding check). */
  owns(grant: DiagnosticGrant | null | undefined): boolean {
    return grant != null && grantIssuers.get(grant) === this;
  }
}

function isIssuedGrant(grant: DiagnosticGrant | null | undefined): grant is DiagnosticGrant {
  return grant instanceof DiagnosticGrant && issuedGrants.has(grant);
}

export interface SealDiagnosticsInput {
  caseRef?: string | null;
  originCode?: string | null;
  detail: string;
  capturedAt?: string;
}

/**
 * Seal one diagnostic record: redact secret-shaped material now, so the
 * record is safe at rest and never needs a later scrub.
 */
export function sealDiagnostics(
  input: SealDiagnosticsInput,
  literalSecrets: readonly string[] = [],
): SensitiveDiagnostics {
  return {
    case_ref: input.caseRef ?? null,
    origin_code: input.originCode ?? null,
    captured_at: input.capturedAt ?? new Date().toISOString(),
    detail: redactSensitiveText(input.detail, literalSecrets),
  };
}

/**
 * Read one sealed record under the separate access check. Only an
 * authorizer-minted grant is accepted; the check runs before the lookup, so
 * an unauthorized caller cannot probe which cases exist.
 */
export function readSensitiveDiagnostics(
  record: SensitiveDiagnostics | undefined,
  grant: DiagnosticGrant | null | undefined,
): SensitiveDiagnostics {
  if (!isIssuedGrant(grant)) {
    throw new SensitiveDiagnosticsAccessDenied(
      "reading sensitive diagnostics requires a grant minted by the diagnostics authorizer",
    );
  }
  if (record === undefined) {
    throw new SensitiveDiagnosticsAccessDenied("no diagnostics recorded for this case");
  }
  return { ...record };
}

/**
 * Minimal holder that keeps sealed diagnostics out of every shared surface
 * (envelopes, task events, metric labels) and only releases them through
 * {@link readSensitiveDiagnostics} with a grant its own authorizer minted.
 */
export class DiagnosticsVault {
  private readonly records = new Map<string, SensitiveDiagnostics>();
  private readonly authorizer: DiagnosticsAuthorizer;

  constructor(authorizer: DiagnosticsAuthorizer) {
    this.authorizer = authorizer;
  }

  record(sealed: SensitiveDiagnostics): void {
    this.records.set(sealed.case_ref ?? "", sealed);
  }

  read(caseRef: string, grant: DiagnosticGrant | null | undefined): SensitiveDiagnostics {
    if (!this.authorizer.owns(grant)) {
      throw new SensitiveDiagnosticsAccessDenied(
        "the grant was not minted by this vault's diagnostics authorizer",
      );
    }
    return readSensitiveDiagnostics(this.records.get(caseRef), grant);
  }

  has(caseRef: string): boolean {
    return this.records.has(caseRef);
  }

  get size(): number {
    return this.records.size;
  }
}
