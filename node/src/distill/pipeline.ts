/**
 * Recoverable distillation of captured outcomes into `proposed` memory
 * (DAT-265).
 *
 * This is the write path between DAT-264's capture outbox and the DAT-233/234
 * distillation + admission machinery. A captured snapshot is distilled at
 * most once per pass, through the ADR-0005 gateway only, and every accepted
 * candidate is persisted as a `proposed` item with its resolved evidence.
 *
 * Invariants:
 *
 * - Nothing is distilled that capture did not record. The job carries the
 *   workspace from the server-side capture row, and re-reads that row's exact
 *   envelope; a snapshot whose digest does not match is refused.
 * - Episode-only outcomes (`timeout`, `unknown`, `infra_failure`) never reach a
 *   model call. They only get a row if a snapshot was tampered with, and that
 *   row is skipped rather than distilled.
 * - Dedupe, contradiction, and poisoning checks run in the admission gate
 *   (DAT-234), not here: an exact/near duplicate merges its evidence into the
 *   existing item, a contradicting candidate keeps a `contradicts` link, and a
 *   poisoned candidate is discarded with its reason code recorded.
 * - Nothing is promoted. Accepted candidates stay `proposed`; reaching
 *   `candidate`/`active` is the human-gated lifecycle path (DAT-235).
 * - A failed gateway call, schema violation, or a crash between the model call
 *   and persistence leaves the row retryable; re-running is idempotent because
 *   admission keys on the canonical candidate hash.
 */

import { createHash } from "node:crypto";

import type { Api, Model } from "@mariozechner/pi-ai";

import type { ControlPlaneDb } from "../control-plane/db.js";
import { ValidationError } from "../control-plane/errors.js";
import type { WorkspaceScope } from "../control-plane/types.js";
import type { GatewayBindingIdentity, ModelGateway } from "../gateway/index.js";
import type {
  AdmissionCandidate,
  EvidenceResolution,
  MemoryAdmissionRepository,
  MemoryProvenance,
  MemoryRepositories,
} from "../memory/index.js";
import { admitCandidate, ledgerEvidenceResolver } from "../memory/index.js";
import { captureEvidence } from "./capture.js";
import { createCaptureJobStore } from "./capture-store.js";
import { buildDistillationContext, dispatchDistillation } from "./distill.js";
import { createDistillationJobStore } from "./distillation-store.js";
import type { DistillationJob, DistillationJobStore } from "./distillation-store.js";
import { classifyOutcome, parseOutcomeEnvelope } from "./outcome.js";
import { parseDistillationOutput } from "./schema.js";
import type { CapturedOutcome, ValidatedCandidate } from "./types.js";
import { DISTILL_PROMPT_VERSION } from "./types.js";
import { buildEvidenceLedger, validateCandidates } from "./validate.js";

/** Default claim lease: long enough for one gateway dispatch, short enough to recover. */
export const DEFAULT_DISTILL_LEASE_MS = 120_000;
/** Default retry backoff after a failed attempt. */
export const DEFAULT_DISTILL_RETRY_MS = 60_000;
/** Attempt budget per captured snapshot before it is marked failed. */
export const DEFAULT_DISTILL_MAX_ATTEMPTS = 5;
/** Default recovery/retry cadence for pending rows. */
export const DEFAULT_DISTILL_INTERVAL_MS = 120_000;
/** Bound on one drain pass so a large backlog cannot starve the process. */
export const DEFAULT_DISTILL_BATCH = 25;

/**
 * One stable failure of a distillation attempt. The code is what the outbox
 * persists — never an error message, which can carry provider text.
 */
export class DistillationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DistillationError";
    this.code = code;
  }
}

export interface DistillationPassReport {
  job_id: string;
  run_id: string;
  outcome_class: string;
  state: "distilled" | "skipped";
  item_ids: string[];
  accepted: number;
  dropped: number;
  /** Set when the pass ended without candidates, with its stable reason. */
  skipped_reason: string | null;
  model_id: string | null;
}

export interface DistillDrainReport {
  /** Rows derived from newly captured learnable snapshots this pass. */
  derived: number;
  claimed: number;
  distilled: number;
  skipped: number;
  retried: number;
  failed: number;
}

export interface MemoryDistillationRunnerOptions {
  db: ControlPlaneDb;
  memory: MemoryRepositories;
  admission: MemoryAdmissionRepository;
  gateway: ModelGateway;
  /** Distillation model; unset leaves every claimed row retryable and visible. */
  model?: Model<Api> | undefined;
  /** Actor recorded on the memory rows this pass writes (the deployment operator). */
  actorId: string;
  now?: () => Date;
  leaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  intervalMs?: number;
  batchSize?: number;
  /** One completed pass, for operator logs. */
  onDistilled?: (job: DistillationJob, report: DistillationPassReport) => void;
  /** A failed attempt or a failed drain pass; the schedule survives either. */
  onError?: (error: unknown) => void;
}

export interface MemoryDistillationRunner {
  /** Derive pending jobs from captured learnable snapshots. */
  sync(): number;
  /** Derive, then process every due job in bounded batches. */
  drain(): Promise<DistillDrainReport>;
  /** Start the retry/recovery cadence; idempotent. */
  start(): void;
  /** Stop the cadence; idempotent, pending rows stay durable. */
  stop(): void;
  /** The outbox, for operator surface and tests. */
  jobs: DistillationJobStore;
}

function emptyReport(): DistillDrainReport {
  return { derived: 0, claimed: 0, distilled: 0, skipped: 0, retried: 0, failed: 0 };
}

/** Stable error token for one failed attempt; never the raw message. */
function attemptErrorCode(error: unknown): string {
  if (error instanceof DistillationError) {
    return error.code;
  }
  if (error instanceof ValidationError) {
    // The extractor's schema or batch policy rejected the response. Retryable
    // within the attempt budget: a retry can produce a conforming response.
    return "INVALID_DISTILLATION_OUTPUT";
  }
  return "DISTILLATION_FAILED";
}

function parseSnapshot(job: DistillationJob, envelopeJson: string): CapturedOutcome["envelope"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch {
    throw new DistillationError(
      "INVALID_OUTCOME_SNAPSHOT",
      `captured envelope for run ${job.run_id} is not valid JSON`,
    );
  }
  try {
    return parseOutcomeEnvelope(parsed);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new DistillationError(
        "INVALID_OUTCOME_SNAPSHOT",
        `captured envelope for run ${job.run_id} violates the outcome contract`,
      );
    }
    throw error;
  }
}

/**
 * Convert one validated candidate into the admission gate's input shape. The
 * provenance is the pipeline's, never the extractor's: a model cannot claim a
 * trust class, a model, or a prompt version.
 */
function admissionCandidateFor(
  validated: ValidatedCandidate,
  provenance: MemoryProvenance,
  runId: string,
): AdmissionCandidate {
  return {
    kind: validated.candidate.kind,
    scope: validated.candidate.scope,
    statement: validated.candidate.statement,
    preconditions: validated.candidate.preconditions,
    provenance,
    trust: "agent",
    sensitivity: validated.sensitivity,
    source_run_id: runId,
    evidence: validated.candidate.evidence.map((ref) => ({
      evidence_type: ref.evidence_type,
      reference: ref.reference,
    })),
  };
}

export function createMemoryDistillationRunner(
  options: MemoryDistillationRunnerOptions,
): MemoryDistillationRunner {
  const jobs = createDistillationJobStore(options.db, DISTILL_PROMPT_VERSION);
  const captureJobs = createCaptureJobStore(options.db);
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DEFAULT_DISTILL_LEASE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_DISTILL_RETRY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_DISTILL_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_DISTILL_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_DISTILL_BATCH;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<DistillDrainReport> | undefined;

  const scopeFor = (job: DistillationJob): WorkspaceScope => ({
    // The persisted row is the only workspace authority: never the envelope,
    // never the model, never the capture payload.
    enterprise_id: job.enterprise_id,
    workspace_id: job.workspace_id,
    actor_id: options.actorId,
  });

  const loadSnapshot = (job: DistillationJob): { envelopeJson: string; digest: string } => {
    const capture = captureJobs.get(job.capture_job_id);
    if (
      capture === undefined ||
      capture.state !== "captured" ||
      capture.envelope === null ||
      capture.envelope_digest === null
    ) {
      throw new DistillationError(
        "CAPTURE_SNAPSHOT_MISSING",
        `capture snapshot ${job.capture_job_id} is not available`,
      );
    }
    if (capture.workspace_id !== job.workspace_id || capture.enterprise_id !== job.enterprise_id) {
      throw new DistillationError(
        "SCOPE_DENIED",
        `capture snapshot ${job.capture_job_id} belongs to another workspace`,
      );
    }
    const digest = createHash("sha256").update(capture.envelope).digest("hex");
    if (digest !== capture.envelope_digest) {
      throw new DistillationError(
        "ENVELOPE_DIGEST_MISMATCH",
        `capture snapshot ${job.capture_job_id} no longer matches its digest`,
      );
    }
    return { envelopeJson: capture.envelope, digest };
  };

  /**
   * Distill one claimed row. Returns the pass report; the caller records it.
   * A gateway call is never made inside a transaction: the attempt is claimed,
   * dispatched, and only then persisted, all-or-nothing.
   */
  const distillOne = async (job: DistillationJob): Promise<DistillationPassReport> => {
    const scope = scopeFor(job);
    const snapshot = loadSnapshot(job);
    const envelope = parseSnapshot(job, snapshot.envelopeJson);
    const classification = classifyOutcome(envelope);

    // Episode-only outcomes are never distilled from. A well-formed outbox
    // never holds one; a row that does is closed with its reason visible.
    if (classification.episode_only || !classification.known) {
      jobs.markSkipped(job.id, "EPISODE_ONLY_OUTCOME", now());
      return {
        job_id: job.id,
        run_id: job.run_id,
        outcome_class: classification.class,
        state: "skipped",
        item_ids: [],
        accepted: 0,
        dropped: 0,
        skipped_reason: "EPISODE_ONLY_OUTCOME",
        model_id: null,
      };
    }

    // The episode is looked up by the item id the capture row recorded, and
    // only in the job's own workspace: the snapshot cannot point at another
    // workspace's episode.
    const capture = captureJobs.get(job.capture_job_id);
    const episodeId = capture?.item_id ?? null;
    const episodeRecord =
      episodeId === null ? undefined : options.memory.items.getById(scope, episodeId);
    if (episodeRecord === undefined) {
      throw new DistillationError(
        "EPISODE_MISSING",
        `episode for capture snapshot ${job.capture_job_id} is not in this workspace`,
      );
    }
    if (episodeRecord.current.kind !== "episode") {
      throw new DistillationError(
        "EPISODE_MISSING",
        `item ${episodeRecord.item.id} is not a captured episode`,
      );
    }

    const outcome: CapturedOutcome = {
      envelope,
      classification,
      evidence: captureEvidence(envelope),
      episode: episodeRecord,
    };

    const model = options.model;
    if (model === undefined) {
      throw new DistillationError(
        "MODEL_UNAVAILABLE",
        "no distillation model is configured for this deployment",
      );
    }

    // Composition refuses a cross-workspace outcome before any line is built;
    // egress goes through the ADR-0005 gateway or not at all.
    const context = buildDistillationContext({ scope, outcomes: [outcome] });
    const identity: GatewayBindingIdentity = {
      enterpriseId: job.enterprise_id,
      workspaceId: job.workspace_id,
      scopeAuthority: {
        // Server-side scope: the capture row was written from the owning
        // task's projection. Nothing in the envelope can retarget it.
        resolve: () => ({ enterpriseId: job.enterprise_id, workspaceId: job.workspace_id }),
      },
      issueId: envelope.issue_id,
      runId: envelope.run_id,
      traceId: `distill:${job.id}`,
    };
    const text = await dispatchDistillation({ gateway: options.gateway, model, identity, context });

    const output = parseDistillationOutput(text);
    const ledger = buildEvidenceLedger([outcome]);
    const validation = validateCandidates(output, ledger);

    // A policy-violating batch persists nothing at all; the row records why.
    if (validation.rejected) {
      jobs.markSkipped(job.id, "POLICY_VIOLATION_BATCH", now());
      return {
        job_id: job.id,
        run_id: job.run_id,
        outcome_class: classification.class,
        state: "skipped",
        item_ids: [],
        accepted: 0,
        dropped: validation.dropped.length,
        skipped_reason: "POLICY_VIOLATION_BATCH",
        model_id: model.id,
      };
    }

    const resolver = ledgerEvidenceResolver(
      [...ledger.values()].map((entry): EvidenceResolution => ({
        evidence_type: entry.evidence_type,
        reference: entry.reference,
        known: entry.known,
        positive: entry.positive,
      })),
    );
    const provenance: MemoryProvenance = {
      author_type: "agent",
      agent_model: model.id,
      prompt_template_version: job.prompt_template_version,
    };

    // Persist and completion commit together: a crash after an item insert but
    // before `markDistilled` would otherwise re-distill on the next pass. The
    // outbox shares the memory store's connection, so `runAtomically` covers
    // both, and admission's candidate hash keeps a re-delivery idempotent.
    const pass = options.memory.runAtomically(() => {
      const itemIds: string[] = [];
      let accepted = 0;
      let dropped = validation.dropped.length;
      for (const validated of validation.accepted) {
        const admissionOutcome = admitCandidate(
          options.memory,
          options.admission,
          scope,
          admissionCandidateFor(validated, provenance, envelope.run_id),
          // Nothing is promoted: accepted candidates stay `proposed` for the
          // human-gated lifecycle path.
          { evidence: resolver, run_id: envelope.run_id, promote: false },
        );
        if (admissionOutcome.item === null) {
          dropped += 1;
          continue;
        }
        accepted += 1;
        if (!itemIds.includes(admissionOutcome.item.item.id)) {
          itemIds.push(admissionOutcome.item.item.id);
        }
      }
      jobs.markDistilled(
        job.id,
        { model_id: model.id, item_ids: itemIds, accepted, dropped },
        now(),
      );
      return { itemIds, accepted, dropped };
    });

    return {
      job_id: job.id,
      run_id: job.run_id,
      outcome_class: classification.class,
      state: "distilled",
      item_ids: pass.itemIds,
      accepted: pass.accepted,
      dropped: pass.dropped,
      skipped_reason: null,
      model_id: model.id,
    };
  };

  const runDrain = async (): Promise<DistillDrainReport> => {
    const report = emptyReport();
    // Derive first: a restart, or a crash between capture and the first
    // drain, resumes here because the snapshot is durable.
    report.derived = jobs.sync(batchSize);
    for (let processed = 0; processed < batchSize; processed += 1) {
      const at = now();
      const job = jobs.claim(at, leaseMs);
      if (job === null) {
        break;
      }
      report.claimed += 1;
      try {
        const pass = await distillOne(job);
        if (pass.state === "skipped") {
          report.skipped += 1;
        } else {
          report.distilled += 1;
        }
        options.onDistilled?.(job, pass);
      } catch (error) {
        const code = attemptErrorCode(error);
        if (job.attempts >= maxAttempts) {
          jobs.markFailed(job.id, code, now());
          report.failed += 1;
        } else {
          const attempts = now();
          const backoff = retryDelayMs * Math.max(1, job.attempts);
          jobs.markRetry(job.id, code, new Date(attempts.getTime() + backoff), attempts);
          report.retried += 1;
        }
        options.onError?.(error);
      }
    }
    return report;
  };

  const drain = (): Promise<DistillDrainReport> => {
    if (active !== undefined) {
      return active;
    }
    active = runDrain().finally(() => {
      active = undefined;
    });
    return active;
  };

  return {
    jobs,
    sync: () => jobs.sync(batchSize),
    drain,
    start() {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void drain().catch((error: unknown) => options.onError?.(error));
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer === undefined) {
        return;
      }
      clearInterval(timer);
      timer = undefined;
    },
  };
}
