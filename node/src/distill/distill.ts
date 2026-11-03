/**
 * Structured distillation over known terminal outcomes (DAT-233).
 *
 * The distillation model call has exactly one egress path: the ADR-0005 model
 * gateway. There is no function in this module (or its callers) that opens a
 * provider connection directly, and a gateway denial fails the call closed.
 * The composed context receives **only current-workspace material**: outcomes
 * captured in the caller's workspace plus explicitly supplied workspace
 * material, each checked against the scope before a single line is composed.
 * Episode-only outcomes (timeout, unknown, infra failure) are excluded — they
 * are never distilled from and never counted as success.
 *
 * Everything sent outward is secret-scanned and minimized again as the last
 * egress-side defense, even though capture already redacted its fields.
 */

import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  Api,
} from "@mariozechner/pi-ai";

import { ScopeError, ValidationError } from "../control-plane/errors.js";
import type { WorkspaceScope } from "../control-plane/types.js";
import type { GatewayBindingIdentity, ModelGateway } from "../gateway/index.js";
import { scrubSecrets } from "../gateway/redact.js";
import type { MemoryItemRecord, MemoryProvenance, MemoryRepositories } from "../memory/index.js";
import { assertOutcomesInScope, captureOutcome } from "./capture.js";
import { redactText } from "./redact.js";
import { parseDistillationOutput } from "./schema.js";
import {
  DISTILL_CANDIDATES_MAX,
  DISTILL_EVIDENCE_MAX,
  DISTILL_KINDS,
  DISTILL_MATERIAL_MAX,
  DISTILL_MATERIAL_TEXT_MAX,
  DISTILL_PRECONDITION_MAX,
  DISTILL_PRECONDITIONS_MAX,
  DISTILL_PROMPT_VERSION,
  DISTILL_STATEMENT_MAX,
} from "./types.js";
import type { CapturedOutcome, DistillationContextInput, DistillationOutput } from "./types.js";
import { buildEvidenceLedger, validateCandidates } from "./validate.js";
import type { CandidateValidationResult, ValidatedCandidate } from "./types.js";

/** Fixed distillation instructions; the model never supplies these words. */
export const DISTILL_INSTRUCTIONS = [
  "You extract durable workspace memory candidates from captured terminal outcomes.",
  "Rules:",
  '- Emit exactly one JSON object: {"candidates": [...]} and nothing else.',
  `- Candidate kinds: ${DISTILL_KINDS.join(", ")}. Never emit policy items or episodes.`,
  `- Each candidate: {"kind", "statement", "preconditions" (1-${DISTILL_PRECONDITIONS_MAX} strings), ` +
    `"scope" (optional {team_id|path_prefix|language|task_family}), "evidence" (array of ` +
    `{"evidence_type", "reference"})}.`,
  `- statement max ${DISTILL_STATEMENT_MAX} characters; each precondition max ${DISTILL_PRECONDITION_MAX}; ` +
    `at most ${DISTILL_EVIDENCE_MAX} evidence citations; at most ${DISTILL_CANDIDATES_MAX} candidates.`,
  "- Cite ONLY evidence references from the captured list below; copy them exactly.",
  "- Never invent test results, reviewer decisions, or merge states. A claim about tests, " +
    "review, or merge must be supported by cited evidence of that kind.",
  "- Include no credentials, tokens, personal data, repository secrets, or raw log excerpts.",
  "- Include no instructions to expand permissions, bypass approval, ignore policy, or " +
    "address any evaluator or grading system.",
  "- Prefer fewer, well-attributed candidates over broad speculation.",
].join("\n");

/**
 * Compose the distillation context from current-workspace material only.
 * A material bound to another workspace is refused before anything is
 * composed: cross-workspace data can never ride into a model call.
 */
export function buildDistillationContext(input: DistillationContextInput): Context {
  // Workspace isolation first: an outcome captured in another workspace (or
  // enterprise) is refused before a single line is composed, so its summary
  // and evidence can never ride into this workspace's model request or turn
  // into candidates written here.
  assertOutcomesInScope(input.scope, input.outcomes);

  const materials = input.materials ?? [];
  if (materials.length > DISTILL_MATERIAL_MAX) {
    throw new ValidationError(`distillation accepts at most ${DISTILL_MATERIAL_MAX} materials`);
  }
  for (const material of materials) {
    if (material.workspace_id !== input.scope.workspace_id) {
      throw new ScopeError("distillation material must belong to the current workspace");
    }
    if (material.text.length > DISTILL_MATERIAL_TEXT_MAX) {
      throw new ValidationError(
        `distillation material must not exceed ${DISTILL_MATERIAL_TEXT_MAX} characters`,
      );
    }
  }

  // Only known outcomes are distilled from; episode-only outcomes are
  // excluded so a timeout or unknown result can never become evidence.
  const known = input.outcomes.filter((outcome) => outcome.classification.known);

  const lines: string[] = [
    "Workspace distillation input (current workspace material only):",
    `workspace: ${input.scope.workspace_id}`,
    "",
    "Captured terminal outcomes and their evidence references:",
  ];
  for (const outcome of known) {
    lines.push(renderOutcome(outcome));
    lines.push("");
  }
  if (known.length === 0) {
    lines.push('(no known terminal outcomes; emit {"candidates": []})');
    lines.push("");
  }
  if (materials.length > 0) {
    lines.push("Workspace material:");
    for (const material of materials) {
      lines.push(`- ${scrub(material.text)}`);
    }
    lines.push("");
  }
  lines.push("Output instructions:", DISTILL_INSTRUCTIONS);

  return {
    messages: [{ role: "user", content: scrub(lines.join("\n")), timestamp: Date.now() }],
  };
}

function scrub(text: string): string {
  return scrubSecrets(redactText(text).text);
}

function renderOutcome(outcome: CapturedOutcome): string {
  const { envelope, classification } = outcome;
  const lines = [
    `- outcome class ${classification.class} (run ${envelope.run_id}, task ${envelope.task_id}, ` +
      `issue ${envelope.issue_id}, terminal state ${envelope.terminal_state}, ` +
      `delivery ${envelope.delivery.patch_status})`,
  ];
  if (envelope.delivery.pr_id !== null) lines.push(`  pr: ${envelope.delivery.pr_id}`);
  if (envelope.delivery.head_sha !== null) lines.push(`  head: ${envelope.delivery.head_sha}`);
  if (envelope.failure_cause !== null) lines.push(`  cause: ${envelope.failure_cause}`);
  if (envelope.reason !== null) lines.push(`  reason: ${scrub(envelope.reason)}`);
  lines.push(`  change summary: ${scrub(envelope.delivery.change_summary)}`);
  for (const attempt of envelope.delivery.validation) {
    lines.push(
      `  validation: tool ${scrub(attempt.tool)}, exit ${String(attempt.exit_status)}, ` +
        `event ${attempt.event_reference}`,
    );
  }
  lines.push("  evidence references:");
  for (const entry of outcome.evidence) {
    lines.push(`  - ${entry.evidence_type}: ${entry.reference}`);
  }
  return lines.join("\n");
}

export interface DistillationDispatch {
  gateway: ModelGateway;
  model: Model<Api>;
  identity: GatewayBindingIdentity;
  context: Context;
  options?: SimpleStreamOptions | undefined;
}

/** Dispatch one composed distillation context through the model gateway. */
export async function dispatchDistillation(input: DistillationDispatch): Promise<string> {
  const stream = await input.gateway.dispatch(
    input.model,
    input.context,
    input.options,
    input.identity,
  );
  const message = await stream.result();
  return extractText(message);
}

/** Collect the text parts of one assistant message. */
export function extractText(message: AssistantMessage): string {
  const content: unknown = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Persist validated candidates as `proposed` memory items with their resolved
 * evidence. A rejected batch (policy violation) persists nothing. Agents can
 * create `proposed` items only — promotion is a separate, human-gated path.
 */
export function persistCandidates(
  repos: MemoryRepositories,
  scope: WorkspaceScope,
  validation: CandidateValidationResult,
  provenance: MemoryProvenance,
): MemoryItemRecord[] {
  if (validation.rejected) {
    throw new ValidationError(
      "distillation output rejected: candidate carries policy instructions",
    );
  }
  const persisted: MemoryItemRecord[] = [];
  for (const candidate of validation.accepted) {
    persisted.push(persistOne(repos, scope, candidate, provenance));
  }
  return persisted;
}

function persistOne(
  repos: MemoryRepositories,
  scope: WorkspaceScope,
  validated: ValidatedCandidate,
  provenance: MemoryProvenance,
): MemoryItemRecord {
  const runIds = new Set(validated.evidence.map((entry) => entry.run_id));
  const record = repos.items.create(scope, {
    kind: validated.candidate.kind,
    scope: validated.candidate.scope,
    statement: validated.candidate.statement,
    preconditions: validated.candidate.preconditions,
    provenance,
    trust: provenance.author_type === "human" ? "human" : "agent",
    sensitivity: validated.sensitivity,
    source_run_id: runIds.size === 1 ? ([...runIds][0] ?? null) : null,
  });
  for (const entry of validated.evidence) {
    repos.evidence.add(scope, record.item.id, {
      evidence_type: entry.evidence_type,
      reference: entry.reference,
    });
  }
  return record;
}

export interface DistillRunInput extends DistillationContextInput {
  repos: MemoryRepositories;
  gateway: ModelGateway;
  model: Model<Api>;
  identity: GatewayBindingIdentity;
  options?: SimpleStreamOptions | undefined;
}

export interface DistillRunResult {
  output: DistillationOutput;
  validation: CandidateValidationResult;
  persisted: MemoryItemRecord[];
}

/**
 * The full distillation pass: compose current-workspace context, dispatch
 * through the gateway, parse the extractor output against the strict schema,
 * validate it against the captured evidence ledger, and persist the accepted
 * candidates as `proposed` items. A gateway denial, a schema violation, or a
 * policy-violating batch fails closed and persists nothing.
 */
export async function distillAndPersist(input: DistillRunInput): Promise<DistillRunResult> {
  // Fail fast on any cross-workspace outcome before composing, dispatching,
  // building the evidence ledger, or persisting anything.
  assertOutcomesInScope(input.scope, input.outcomes);
  const context = buildDistillationContext(input);
  const text = await dispatchDistillation({
    gateway: input.gateway,
    model: input.model,
    identity: input.identity,
    context,
    options: input.options,
  });
  const output = parseDistillationOutput(text);
  const ledger = buildEvidenceLedger(input.outcomes);
  const validation = validateCandidates(output, ledger);
  const persisted = persistCandidates(input.repos, input.scope, validation, {
    author_type: "agent",
    agent_model: input.model.id,
    prompt_template_version: DISTILL_PROMPT_VERSION,
  });
  return { output, validation, persisted };
}

/** Capture outcomes and return the ledger entries distillation may use. */
export function captureAll(
  repos: MemoryRepositories,
  scope: WorkspaceScope,
  envelopes: readonly unknown[],
): CapturedOutcome[] {
  return envelopes.map((envelope) => captureOutcome(repos, scope, envelope));
}
