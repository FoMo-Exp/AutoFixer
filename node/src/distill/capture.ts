/**
 * Outcome capture into workspace memory (DAT-233).
 *
 * One captured outcome becomes exactly one L1 `episode` item plus the evidence
 * references that attribute it. Episodes are stored for **every** terminal
 * outcome — including timeout, unknown, and infrastructure failure — but only
 * known outcomes carry learnable evidence. The episode statement is composed
 * from bounded envelope fields by a fixed template; no narrative, no model
 * text, and every free-text field is secret-scanned and minimized first.
 *
 * The episode is always trust class `system`: it is a record of what the dsh
 * evidence chain and the delivery record say, never a model assertion.
 */

import type { WorkspaceScope } from "../control-plane/types.js";
import type { MemoryEvidenceType, MemoryRepositories, MemorySensitivity } from "../memory/index.js";
import { assertNoSecretOrPii, detectSecretOrPii, redactText, sensitivityFor } from "./redact.js";
import { classifyOutcome, parseOutcomeEnvelope } from "./outcome.js";
import type { CapturedOutcome, EvidenceLedgerEntry, OutcomeEnvelope } from "./types.js";

/**
 * Derive the ledger entries capture records for one envelope: the envelope's
 * own evidence references, the run/issue identities, the PR and head commit
 * identities from the delivery record, and one `test` entry per retained
 * validation attempt with its exit status — the only way a candidate can ever
 * claim "the tests passed".
 */
export function captureEvidence(envelope: OutcomeEnvelope): EvidenceLedgerEntry[] {
  const classification = classifyOutcome(envelope);
  const base = {
    outcome_class: classification.class,
    positive: classification.positive,
    known: classification.known,
    run_id: envelope.run_id,
    test_passed: null,
  };
  const entries: EvidenceLedgerEntry[] = [];

  const push = (
    evidence_type: MemoryEvidenceType,
    reference: string,
    test_passed: boolean | null,
  ): void => {
    entries.push({ evidence_type, reference, ...base, test_passed });
  };

  push("run", envelope.run_id, null);
  push("issue", envelope.issue_id, null);
  if (envelope.delivery.pr_id !== null) {
    push("pr", envelope.delivery.pr_id, null);
  }
  if (envelope.delivery.head_sha !== null) {
    push("commit", envelope.delivery.head_sha, null);
  }
  for (const attempt of envelope.delivery.validation) {
    push("test", attempt.event_reference, attempt.exit_status === 0);
  }
  for (const ref of envelope.evidence) {
    entries.push({
      evidence_type: ref.evidence_type,
      reference: ref.reference,
      ...base,
      test_passed: null,
    });
  }

  // De-duplicate by (type, reference); the first occurrence wins.
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.evidence_type}\u0000${entry.reference}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Fixed episode statement template over bounded envelope fields only. */
function episodeStatement(envelope: OutcomeEnvelope, outcomeClass: string): string {
  const parts = [
    `terminal outcome ${outcomeClass}`,
    `run ${envelope.run_id}`,
    `task ${envelope.task_id}`,
    `issue ${envelope.issue_id}`,
    `terminal state ${envelope.terminal_state}`,
    `delivery ${envelope.delivery.patch_status}`,
  ];
  if (envelope.delivery.pr_id !== null) parts.push(`pr ${envelope.delivery.pr_id}`);
  if (envelope.delivery.head_sha !== null) parts.push(`head ${envelope.delivery.head_sha}`);
  if (envelope.failure_cause !== null) parts.push(`cause ${envelope.failure_cause}`);
  if (envelope.reason !== null) parts.push(`reason ${envelope.reason}`);
  return parts.join("; ");
}

/**
 * Capture one outcome envelope into workspace memory.
 *
 * The envelope is parsed strictly, classified, and redacted before anything is
 * written. The returned {@link CapturedOutcome} carries the classification and
 * the ledger entries distillation may attribute claims to. A non-known
 * outcome — `timeout`, `unknown`, `infra_failure` — yields an episode only:
 * `classification.positive` is false and its evidence is never `known`.
 */
export function captureOutcome(
  repos: MemoryRepositories,
  scope: WorkspaceScope,
  raw: unknown,
): CapturedOutcome {
  const envelope = parseOutcomeEnvelope(raw);
  const classification = classifyOutcome(envelope);

  // Minimize every free-text field before it can reach an item.
  const reason = envelope.reason === null ? null : redactText(envelope.reason);
  const summary = redactText(envelope.delivery.change_summary);
  const validation = envelope.delivery.validation.map((attempt) => ({
    ...attempt,
    tool: redactText(attempt.tool).text,
  }));
  const redacted: OutcomeEnvelope = {
    ...envelope,
    reason: reason === null ? null : reason.text,
    delivery: { ...envelope.delivery, change_summary: summary.text, validation },
  };

  const kinds = [
    ...(reason?.kinds ?? []),
    ...summary.kinds,
    ...envelope.delivery.validation.flatMap((attempt) => detectSecretOrPii(attempt.tool)),
  ];
  const sensitivity: MemorySensitivity = sensitivityFor(kinds);

  const statement = episodeStatement(redacted, classification.class);
  assertNoSecretOrPii(statement, "episode statement");

  const episode = repos.items.create(scope, {
    kind: "episode",
    scope: {},
    statement,
    preconditions: [],
    provenance: { author_type: "system" },
    trust: "system",
    sensitivity,
    source_run_id: envelope.run_id,
  });

  const evidence = captureEvidence(redacted);
  for (const entry of evidence) {
    repos.evidence.add(scope, episode.item.id, {
      evidence_type: entry.evidence_type,
      reference: entry.reference,
    });
  }

  return {
    envelope: redacted,
    classification,
    evidence,
    episode,
  };
}
