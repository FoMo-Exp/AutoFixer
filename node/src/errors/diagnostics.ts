/**
 * Sensitive diagnostics behind a separate access check (DAT-226).
 *
 * The error envelope is safe to show to agents and humans; the raw failure
 * detail behind it is not. Diagnostics are sealed at capture time (secret
 * redaction included) and can only be read through an explicit, independent
 * access check — reading an envelope never implies reading diagnostics, and
 * a workspace/task role is not a diagnostics grant (ADR-0008: content,
 * financial, and quarantine access stay separate).
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

/** The only credential that unlocks diagnostics: an explicit access grant. */
export interface DiagnosticAccess {
  /** Authenticated subject the grant belongs to. */
  readonly subject: string;
  /** Whether this subject may read sensitive diagnostics at all. */
  readonly mayReadSensitiveDiagnostics: boolean;
}

/** A read that lacks the separate diagnostics grant. */
export class SensitiveDiagnosticsAccessDenied extends Error {
  readonly code = "SENSITIVE_DIAGNOSTICS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "SensitiveDiagnosticsAccessDenied";
  }
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

function hasDiagnosticsAccess(
  access: DiagnosticAccess | null | undefined,
): access is DiagnosticAccess {
  return (
    access != null &&
    typeof access.subject === "string" &&
    access.subject.length > 0 &&
    access.mayReadSensitiveDiagnostics === true
  );
}

/**
 * Read one sealed record under the separate access check. The check runs
 * before the lookup, so an unauthorized caller cannot probe which cases
 * exist either.
 */
export function readSensitiveDiagnostics(
  record: SensitiveDiagnostics | undefined,
  access: DiagnosticAccess | null | undefined,
): SensitiveDiagnostics {
  if (!hasDiagnosticsAccess(access)) {
    throw new SensitiveDiagnosticsAccessDenied(
      "reading sensitive diagnostics requires a dedicated diagnostics grant",
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
 * {@link readSensitiveDiagnostics}.
 */
export class DiagnosticsVault {
  private readonly records = new Map<string, SensitiveDiagnostics>();

  record(sealed: SensitiveDiagnostics): void {
    this.records.set(sealed.case_ref ?? "", sealed);
  }

  read(caseRef: string, access: DiagnosticAccess | null | undefined): SensitiveDiagnostics {
    return readSensitiveDiagnostics(this.records.get(caseRef), access);
  }

  has(caseRef: string): boolean {
    return this.records.has(caseRef);
  }

  get size(): number {
    return this.records.size;
  }
}
