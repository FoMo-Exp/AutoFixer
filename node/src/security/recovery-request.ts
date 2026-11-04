/**
 * Request reconstruction, keyed identifiers, and the immutable final request
 * (DAT-212, ADR-0005 §5).
 *
 * Recovery never reuses a stored copy of the blocked request: the complete
 * request is rebuilt from approved sources, then rechecked in full. The
 * approval binds a *keyed* identifier of that complete request, and the
 * dispatch binds a keyed digest of the exact frozen request handed to the
 * adapter plus its destination.
 *
 * Digests are keyed HMACs, never plain hashes: a plain hash of a low-entropy
 * secret value is a confirmation oracle, while a keyed identifier is opaque
 * without the service key (ADR-0005 §6).
 */

import { createHmac } from "node:crypto";

import type { Context } from "@mariozechner/pi-ai";

import { collectRequestSegments } from "../gateway/scan.js";
import type { DataClass, SecretScanPolicy } from "../gateway/index.js";
import { SecurityError, requireNonEmpty } from "./types.js";
import type { ActiveRuleCorrection } from "./rules.js";
import type { RecoveryDestination, RecoveryScope } from "./recovery-authorization.js";

/** Minimum key length accepted for correlation identifiers (bytes). */
const MIN_KEY_BYTES = 16;

/** Validate the service correlation key at construction. */
export function requireCorrelationKey(key: unknown): Buffer {
  if (!Buffer.isBuffer(key) || key.length < MIN_KEY_BYTES) {
    throw new SecurityError(
      "RECOVERY_KEY_INVALID",
      `the recovery correlation key must be a Buffer of at least ${MIN_KEY_BYTES} bytes`,
    );
  }
  return key;
}

/**
 * Domain-separated keyed identifier. The purpose string keeps identifiers
 * from different uses incomparable even under the same key.
 */
export function keyedIdentifier(key: Buffer, purpose: string, canonical: string): string {
  const digest = createHmac("sha256", key)
    .update(purpose)
    .update("\u0000")
    .update(canonical)
    .digest("base64url");
  return `k1.${purpose}.${digest}`;
}

/**
 * Canonical, content-complete representation of a request: every scanned text
 * leaf with its location, data classes, and derivation provenance, in request
 * order. Two requests differ here exactly when they differ in what the
 * provider would receive.
 */
export interface RequestFingerprint {
  canonical: string;
  segments: number;
  dataClasses: DataClass[];
}

export function fingerprintRequest(context: Context): RequestFingerprint {
  let collected;
  try {
    collected = collectRequestSegments(context);
  } catch {
    throw new SecurityError(
      "RECOVERY_REQUEST_UNREADABLE",
      "the complete request could not be collected for reconstruction",
    );
  }
  const canonical = JSON.stringify(
    collected.segments.map((segment) => [
      segment.id,
      segment.path,
      segment.text,
      segment.dataClasses,
      segment.binary === true,
      segment.derived === undefined
        ? null
        : [segment.derived.sourceClassifications, segment.derived.sourceRefs ?? null],
    ]),
  );
  return {
    canonical,
    segments: collected.segments.length,
    dataClasses: [...new Set(collected.segments.flatMap((segment) => segment.dataClasses))].sort(),
  };
}

/** Keyed identifier of the complete reviewed request (the approval's binding). */
export function contextRevisionOf(context: Context, key: Buffer): string {
  return keyedIdentifier(key, "request-context", fingerprintRequest(context).canonical);
}

/**
 * Keyed digest of the exact final request bound to its destination. Computed
 * over the frozen copy that is dispatched — so a request mutated after the
 * recheck can never match its own scan evidence.
 */
export function requestDigestOf(
  context: Context,
  destination: RecoveryDestination,
  key: Buffer,
): string {
  const canonical = JSON.stringify({
    request: fingerprintRequest(context).canonical,
    destination: [
      destination.endpointId,
      destination.provider,
      destination.api,
      destination.modelId,
      destination.internal,
      destination.baseUrl,
    ],
  });
  return keyedIdentifier(key, "provider-request", canonical);
}

/**
 * Keyed identifier of the rule revisions in force for one scope. A reviewed
 * rule activation or rollback changes it, which invalidates every outstanding
 * approval bound to the old set.
 */
export function rulesRevisionOf(
  corrections: readonly ActiveRuleCorrection[],
  scope: { enterpriseId: string; workspaceId: string },
  key: Buffer,
): string {
  const entries = corrections
    .filter(
      (correction) =>
        correction.scope.enterpriseId === scope.enterpriseId &&
        correction.scope.workspaceId === scope.workspaceId,
    )
    .map((correction) => `${correction.lineage}@${correction.version}`)
    .sort();
  return keyedIdentifier(key, "rule-revisions", JSON.stringify(entries));
}

/**
 * Keyed identifier of the scan policy (minimization and derived-classification
 * authorization) in force. A changed policy is a changed recheck.
 */
export function scanPolicyRevisionOf(
  scanPolicy: SecretScanPolicy | undefined,
  key: Buffer,
): string {
  const canonical = JSON.stringify({
    minimization: scanPolicy?.minimization
      ? [
          scanPolicy.minimization.id,
          scanPolicy.minimization.version,
          scanPolicy.minimization.authorized,
          scanPolicy.minimization.appliesTo.detectors,
          scanPolicy.minimization.appliesTo.dataClasses ?? null,
        ]
      : null,
    derivedClassification: scanPolicy?.derivedClassification
      ? [
          scanPolicy.derivedClassification.id,
          scanPolicy.derivedClassification.version,
          scanPolicy.derivedClassification.authorized,
        ]
      : null,
  });
  return keyedIdentifier(key, "scan-policy", canonical);
}

/**
 * Deep-freeze a request copy so nothing — adapter, SDK, or a stray caller
 * holding the reference — can add unchecked content after the scan. The
 * gateway already hands the adapter a minimized copy; freezing makes that
 * copy immutable.
 */
export function deepFreezeRequest<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node as Record<string, unknown>)) {
      freeze((node as Record<string, unknown>)[key]);
    }
    Object.freeze(node);
  };
  freeze(value);
  return value;
}

/**
 * One complete request rebuilt from approved sources. `sourceIds` are
 * non-secret identifiers of the authoritative records the request was
 * reconstructed from (task history, repository snapshot, tool results);
 * quarantine content is never a rebuild source.
 */
export interface RebuiltRequest {
  context: Context;
  sourceIds: readonly string[];
}

export interface RecoveryRebuildInput {
  caseId: string;
  scope: RecoveryScope;
}

/** ADR-0005 §5 seam: rebuild the complete request from approved sources. */
export interface RecoveryRequestSource {
  rebuild(input: RecoveryRebuildInput): RebuiltRequest | Promise<RebuiltRequest>;
}

/**
 * Read and validate one rebuild. A source that throws, returns no request, or
 * cannot name its provenance is uncertain — and uncertainty blocks.
 */
export async function rebuildCompleteRequest(
  source: RecoveryRequestSource,
  input: RecoveryRebuildInput,
): Promise<RebuiltRequest> {
  requireNonEmpty(input.caseId, "rebuild.caseId");
  let rebuilt: RebuiltRequest;
  try {
    rebuilt = await source.rebuild(input);
  } catch {
    // Deliberately not chained: a source error message may quote content.
    throw new SecurityError(
      "RECOVERY_REQUEST_UNAVAILABLE",
      "the complete request could not be rebuilt from approved sources",
      { caseId: input.caseId },
    );
  }
  if (!rebuilt || typeof rebuilt !== "object" || rebuilt.context === null) {
    throw new SecurityError(
      "RECOVERY_REQUEST_UNAVAILABLE",
      "the request source returned no complete request",
      { caseId: input.caseId },
    );
  }
  const messages = rebuilt.context.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new SecurityError(
      "RECOVERY_REQUEST_UNAVAILABLE",
      "the rebuilt request carries no messages; nothing can be rechecked",
      { caseId: input.caseId },
    );
  }
  if (!Array.isArray(rebuilt.sourceIds) || rebuilt.sourceIds.length === 0) {
    throw new SecurityError(
      "RECOVERY_REQUEST_UNAVAILABLE",
      "the rebuilt request names no approved sources; provenance is unestablished",
      { caseId: input.caseId },
    );
  }
  return rebuilt;
}
