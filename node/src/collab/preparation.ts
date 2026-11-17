import { createHash } from "node:crypto";

import type {
  DshCandidateArtifact,
  DshPatchDiffArtifact,
  DshRunResponse,
  DshValidationEvidence,
  DshValidationSummaryArtifact,
} from "../dsh/types.js";
import { diffDigest } from "./candidate-store.js";
import { CollabError } from "./errors.js";
import { artifactEvidenceRef, grantEvidenceRef, planEvidenceRef } from "./evidence.js";
import type {
  ArtifactInput,
  CollabMachine,
  FreezeCandidateInput,
  GrantInput,
  RegisterTestPolicyInput,
} from "./machine.js";
import type { ProductState } from "./states.js";
import type {
  ArtifactRef,
  CandidateRecord,
  CapabilityGrant,
  IssueRecord,
  RepositoryRef,
  RunRecord,
  TestPlanRecord,
  TestPolicyRecord,
  WorkspaceScope,
} from "./types.js";

/**
 * Bridge from a completed dsh preparation run to a frozen collab candidate
 * (DAT-258, reusing DAT-219).
 *
 * dsh remains the execution gate and the only source of the prepared change.
 * The bridge reads the run's frozen `patch_diff`, `candidate`, and
 * `validation_summary` artifacts and mirrors them into the durable
 * collaboration record: one issue per task, one run bound to the dsh run, the
 * exact test plan, the grant, the retained evidence references, and finally the
 * immutable candidate. It performs no provider write — the branch in the
 * candidate is a prospective `autofixer/*` name, and delivery stays a separate
 * approval-bound operation owned by DAT-259.
 *
 * Every machine command uses an operation id derived from the dsh run id, so a
 * retried observation replays recorded results instead of appending duplicate
 * facts. A run that already froze a candidate returns that candidate.
 */

/** The narrow dsh read surface the bridge needs (a real DshClient satisfies it). */
export interface PreparationArtifactReader {
  getArtifact(runId: string, artifactId: string): Promise<Record<string, unknown>>;
}

export interface PreparationPolicyOptions {
  /** Required checks, matching the registered sandbox profile identities. */
  checks?: string[];
  /** Test-environment identity the evidence ran in. */
  environment?: string;
  /** Explicit `sha256:<64 hex>` configuration digest; derived from the checks when unset. */
  configDigest?: string;
}

export interface PreparationBridgeOptions {
  machine: CollabMachine;
  dsh: PreparationArtifactReader;
  /** Actor recorded on the bridge's commands (the orchestrator). */
  actor: string;
  policy?: PreparationPolicyOptions;
  /** Default for the collab run's token limit when the dsh grant carries none. */
  maxTokens?: number;
}

/** One authoritative observation of a stopped dsh preparation run. */
export interface PreparationObservation {
  taskId: string;
  workspace: WorkspaceScope;
  /**
   * The task's pinned repository identity. The URL is not part of the task
   * projection; it comes from the run's capability grant, which dsh issued for
   * exactly this run.
   */
  repository: { repository_id: string; base_ref: string; base_sha: string };
  summary: string;
  sourceReference: string | null;
  run: DshRunResponse;
}

/** The policy content one bridge instance measures candidates against. */
export interface PreparationPolicy {
  checks: string[];
  environment: string;
  configDigest: string;
}

interface PreparedArtifacts {
  diff: DshPatchDiffArtifact;
  candidate: DshCandidateArtifact;
  validation: DshValidationSummaryArtifact;
  reportDigest: string;
  patchDigest: string;
  candidateDigest: string;
}

interface ParsedGrant {
  repositoryUrl: string;
  grant: Omit<GrantInput, "grant_id"> & { base_sha: string };
}

interface LeaseRef {
  holder: string;
  fencing_token: number;
}

const DEFAULT_CHECKS = ["go.test"];
const DEFAULT_ENVIRONMENT = "dsh-isolated-v1";
const DEFAULT_MAX_TOKENS = 200_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function preparationPolicy(options: PreparationPolicyOptions = {}): PreparationPolicy {
  const checks = uniqueChecks(options.checks ?? DEFAULT_CHECKS);
  const environment = options.environment?.trim() || DEFAULT_ENVIRONMENT;
  const configDigest =
    options.configDigest ??
    `sha256:${createHash("sha256")
      .update(JSON.stringify({ checks, environment }), "utf8")
      .digest("hex")}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(configDigest)) {
    throw new CollabError("INVALID_INPUT", "test policy config digest must be sha256:<64 hex>", {
      config_digest: configDigest,
    });
  }
  return { checks, environment, configDigest };
}

function uniqueChecks(checks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of checks) {
    const check = raw.trim();
    if (check === "") {
      throw new CollabError("INVALID_INPUT", "a test-policy check must not be empty", {});
    }
    if (!seen.has(check)) {
      seen.add(check);
      out.push(check);
    }
  }
  if (out.length === 0) {
    throw new CollabError("INVALID_INPUT", "a test policy requires at least one check", {});
  }
  return out;
}

export class PreparationBridge {
  private readonly options: PreparationBridgeOptions;
  private readonly policy: PreparationPolicy;

  constructor(options: PreparationBridgeOptions) {
    this.options = options;
    this.policy = preparationPolicy(options.policy);
  }

  /**
   * Observe one stopped dsh run.
   *
   * Returns the frozen candidate, or null when the run produced no reviewable
   * change (cancellation, a missing validation, or a preparation the policy
   * does not accept). A preparation that cannot be frozen is recorded as
   * `needs_human`; an evidence set that contradicts itself throws, and the
   * caller leaves the run stopped with the failure recorded.
   */
  async observe(observation: PreparationObservation): Promise<CandidateRecord | null> {
    const run = observation.run;
    if (run.state !== "stopped") {
      return null;
    }
    const report = run.patch_report;
    if (report === undefined || report === null || report.patch_status !== "prepared_no_pr") {
      // No validated revision was frozen: cancellation, timeout, rejection,
      // and failure stay truthful and produce no candidate.
      return null;
    }

    const grant = parseGrant(run);
    const issue = this.ensureIssue(observation, grant.repositoryUrl, run);
    if (this.wasDispositioned(issue, run.run_id)) {
      return null;
    }
    const existing = this.options.machine
      .listCandidates(issue.issue_id)
      .find((candidate) => candidate.run_id === run.run_id);
    if (existing !== undefined) {
      return existing;
    }

    let artifacts: PreparedArtifacts;
    try {
      artifacts = await this.readArtifacts(run);
      this.assertConsistent(observation, grant, artifacts);
    } catch (error) {
      this.dispositionFailure(issue, run, error);
      throw error;
    }

    const policy = this.ensurePolicy(
      observation.workspace,
      observation.repository.repository_id,
      grant.repositoryUrl,
    );
    const accepted = qualifiedAttempts(artifacts.validation.validation, policy.checks);
    if (accepted === null) {
      this.dispositionFailure(issue, run, {
        code: "CANDIDATE_INVALID",
        message: `the preparation has no passing evidence for every required check (${policy.checks.join(", ")})`,
      });
      return null;
    }

    try {
      return this.freeze(observation, issue, grant, artifacts, policy, accepted);
    } catch (error) {
      this.dispositionFailure(issue, run, error);
      throw error;
    }
  }

  // -------------------------------------------------------------- evidence

  private async readArtifacts(run: DshRunResponse): Promise<PreparedArtifacts> {
    const runId = run.run_id;
    const [patchRaw, candidateRaw, validationRaw] = await Promise.all([
      this.options.dsh.getArtifact(runId, "patch_diff"),
      this.options.dsh.getArtifact(runId, "candidate"),
      this.options.dsh.getArtifact(runId, "validation_summary"),
    ]);
    const reportDigest = run.patch_report?.report_digest;
    if (typeof reportDigest !== "string" || !SHA256_HEX.test(reportDigest)) {
      throw new CollabError("CANDIDATE_INVALID", "the stopped run has no patch-report digest", {
        run_id: runId,
      });
    }
    // Every envelope must name this run and the requested artifact type, and
    // its digest must recompute from the content it carries: a corrupt or
    // substituted artifact can never pass on the strength of its own claim.
    const patch = verifiedArtifact<DshPatchDiffArtifact>(patchRaw, runId, "patch_diff");
    const candidate = verifiedArtifact<DshCandidateArtifact>(candidateRaw, runId, "candidate");
    const validation = verifiedArtifact<DshValidationSummaryArtifact>(
      validationRaw,
      runId,
      "validation_summary",
    );
    // The retained patch identity is the digest over the exact diff bytes,
    // which is what a reviewer recomputes and what candidate freeze
    // cross-checks; the envelope digest covers the artifact document.
    return {
      diff: patch.content,
      candidate: candidate.content,
      validation: validation.content,
      patchDigest: patch.content.diff_digest,
      candidateDigest: candidate.digest,
      reportDigest,
    };
  }

  /**
   * Every artifact must describe exactly the revision the task pinned and the
   * diff the candidate manifest claims. A mismatch is tampering or a stale
   * read, never something to freeze.
   */
  private assertConsistent(
    observation: PreparationObservation,
    grant: ParsedGrant,
    artifacts: PreparedArtifacts,
  ): void {
    const { diff, candidate, validation } = artifacts;
    const run = observation.run;
    const report = run.patch_report;
    const fail = (message: string, details: Record<string, unknown>): never => {
      throw new CollabError("CANDIDATE_INVALID", message, details);
    };
    if (report === null || report === undefined) {
      throw new CollabError("CANDIDATE_INVALID", "the stopped run has no patch report", {
        run_id: run.run_id,
      });
    }
    if (report.base_sha !== diff.base_sha || report.head_sha !== diff.head_sha) {
      fail("patch report and patch artifact name different revisions", {
        report_base: report.base_sha,
        report_head: report.head_sha,
        diff_base: diff.base_sha,
        diff_head: diff.head_sha,
      });
    }
    if (candidate.base_sha !== diff.base_sha || candidate.head_sha !== diff.head_sha) {
      fail("candidate artifact and patch artifact name different revisions", {
        candidate_base: candidate.base_sha,
        candidate_head: candidate.head_sha,
        diff_base: diff.base_sha,
        diff_head: diff.head_sha,
      });
    }
    if (candidate.tree_sha !== diff.tree_sha) {
      fail("candidate and patch artifacts name different trees", {
        candidate_tree: candidate.tree_sha,
        diff_tree: diff.tree_sha,
      });
    }
    if (candidate.diff_digest !== diff.diff_digest) {
      fail("candidate and patch artifacts declare different diff digests", {
        candidate_digest: candidate.diff_digest,
        diff_digest: diff.diff_digest,
      });
    }
    if (candidate.repository_url !== grant.repositoryUrl) {
      fail("candidate names another repository", {
        candidate_url: candidate.repository_url,
        grant_url: grant.repositoryUrl,
      });
    }
    if (diff.base_sha !== observation.repository.base_sha) {
      fail("the preparation base is not the task's pinned base", {
        diff_base: diff.base_sha,
        task_base: observation.repository.base_sha,
      });
    }
    if (grant.grant.base_sha !== diff.base_sha) {
      fail("the run grant names another base revision", {
        grant_base: grant.grant.base_sha,
        diff_base: diff.base_sha,
      });
    }
    const computed = diffDigest(diff.diff);
    if (computed !== diff.diff_digest) {
      fail("the retained diff content does not match its declared digest", {
        declared: diff.diff_digest,
        computed,
      });
    }
    if (validation.base_sha !== diff.base_sha || validation.head_sha !== diff.head_sha) {
      fail("validation evidence is bound to another revision", {
        validation_base: validation.base_sha,
        validation_head: validation.head_sha,
        diff_base: diff.base_sha,
        diff_head: diff.head_sha,
      });
    }
    if (candidate.run_id !== run.run_id || validation.run_id !== run.run_id) {
      fail("an artifact names another preparation run", {
        run_id: run.run_id,
        candidate_run_id: candidate.run_id,
        validation_run_id: validation.run_id,
      });
    }
    if (candidate.task_id !== observation.taskId) {
      fail("the candidate artifact names another task", {
        task_id: observation.taskId,
        candidate_task_id: candidate.task_id,
      });
    }
    if (validation.state !== run.state) {
      fail("the validation summary names another run state", {
        run_state: run.state,
        validation_state: validation.state,
      });
    }
    if (validation.branch !== candidate.branch) {
      fail("candidate and validation summary name different branches", {
        candidate_branch: candidate.branch,
        validation_branch: validation.branch,
      });
    }
    if (report.branch !== candidate.branch) {
      fail("candidate and patch report name different branches", {
        candidate_branch: candidate.branch,
        report_branch: report.branch,
      });
    }
    // Candidate eligibility may only be read from one identical list of
    // attempts: the manifest, the validation summary, and the patch report of
    // the same revision must agree item by item. A passing manifest cannot
    // stand next to a missing, failed, or different summary.
    const candidateAttempts = normalizedAttempts(candidate.validation, "candidate.validation", run);
    const summaryAttempts = normalizedAttempts(
      validation.validation,
      "validation_summary.validation",
      run,
    );
    const reportAttempts = normalizedAttempts(report.validation, "patch_report.validation", run);
    if (!attemptsEqual(candidateAttempts, summaryAttempts)) {
      fail("candidate validation attempts differ from the validation summary", {
        candidate_attempts: attemptSignatures(candidateAttempts),
        summary_attempts: attemptSignatures(summaryAttempts),
      });
    }
    if (!attemptsEqual(candidateAttempts, reportAttempts)) {
      fail("candidate validation attempts differ from the patch report", {
        candidate_attempts: attemptSignatures(candidateAttempts),
        report_attempts: attemptSignatures(reportAttempts),
      });
    }
    if (diff.changed_paths.length === 0) {
      fail("the prepared change touches no path", { run_id: run.run_id });
    }
    if (candidate.risk_class !== run.risk_assessment.risk_class) {
      fail("the candidate risk class differs from the run assessment", {
        candidate: candidate.risk_class,
        assessment: run.risk_assessment.risk_class,
      });
    }
  }

  // ---------------------------------------------------------------- freeze

  private freeze(
    observation: PreparationObservation,
    issue: IssueRecord,
    grant: ParsedGrant,
    artifacts: PreparedArtifacts,
    policy: TestPolicyRecord,
    passing: DshValidationEvidence[],
  ): CandidateRecord {
    const { diff, candidate } = artifacts;
    const dshRunId = observation.run.run_id;
    const baseSha = diff.base_sha;
    const headSha = diff.head_sha;

    const aligned = this.alignBase(issue, observation, dshRunId, grant);
    this.ensureImplementing(aligned, dshRunId);
    let run = this.ensureRun(aligned, observation, grant);
    // The collaboration run has its own generated id; the dsh run id names the
    // worktree and keys the operations that existed before the record did.
    const runId = run.run_id;

    if (run.state === "requested" || run.state === "approved" || run.state === "running") {
      const lease = this.ensureLease(runId);
      if (run.grants.length === 0) {
        this.recordGrant(runId, lease, grant);
      }
      if (run.state === "requested") {
        run = this.recordRunState(runId, lease, "approved");
      }
      if (run.state === "approved") {
        run = this.recordRunState(runId, lease, "running");
      }
      this.ensurePlan(runId, policy);
      this.attachEvidence(runId, lease, baseSha, headSha, artifacts, passing);
      run = this.recordRunState(runId, lease, "stopped", headSha);
      this.releaseLease(runId, lease);
    } else if (run.state !== "stopped") {
      throw new CollabError(
        "CANDIDATE_INVALID",
        `no local candidate can be frozen from run state ${run.state}`,
        { run_id: runId, state: run.state },
      );
    }

    const recorded = this.options.machine.getRun(runId);
    if (recorded === undefined) {
      throw new CollabError("CANDIDATE_INVALID", "the preparation run disappeared", {
        run_id: runId,
      });
    }
    if (recorded.head_sha !== headSha) {
      throw new CollabError("CANDIDATE_INVALID", "the stopped run names another head", {
        run_id: runId,
        run_head_sha: recorded.head_sha,
        head_sha: headSha,
      });
    }
    const evidence = this.retainedEvidence(recorded, artifacts, passing);
    this.advanceToAwaitingChangeApproval(this.options.machine.getIssue(issue.issue_id), runId);

    const results = passing.map((attempt, index) => {
      const artifact = evidence.testReports[index];
      if (artifact === undefined) {
        throw new CollabError(
          "CANDIDATE_INVALID",
          "a passing validation attempt has no retained test report",
          { index },
        );
      }
      return {
        tool: attempt.tool,
        exit_status: 0,
        output_digest: {
          algorithm: "sha256",
          value: requireDigestValue(attempt.output_digest, `validation[${index}].output_digest`),
        },
        event_reference: artifactEvidenceRef(runId, artifact.artifact_id),
      };
    });
    const planRef = this.planReference(runId);
    const grantReference =
      recorded.grants.length > 0
        ? [grantEvidenceRef(runId, recorded.grants[recorded.grants.length - 1]!.grant_id)]
        : [];
    const input: FreezeCandidateInput = {
      operation_id: this.operation(runId, "freeze"),
      actor: this.options.actor,
      issue_id: issue.issue_id,
      run_id: runId,
      summary: candidate.summary.slice(0, 1000),
      base_sha: baseSha,
      head_sha: headSha,
      tree_sha: diff.tree_sha,
      diff: {
        digest_algorithm: "sha256",
        digest: diff.diff_digest,
        changed_paths: [...diff.changed_paths],
        insertions: diff.insertions,
        deletions: diff.deletions,
      },
      diff_content: diff.diff,
      validation: {
        config_digest: policy.config_digest,
        environment: policy.environment,
        required_checks: [...policy.checks],
        results,
      },
      risk: {
        class: observation.run.risk_assessment.risk_class,
        decision_code: observation.run.risk_assessment.decision_code,
        requires_human_approval: observation.run.risk_assessment.risk_class === "elevated",
      },
      artifact_ids: unique([
        evidence.patch.artifact_id,
        evidence.report.artifact_id,
        evidence.candidate.artifact_id,
        ...evidence.testReports.map((artifact) => artifact.artifact_id),
      ]),
      audit_refs: unique([
        artifactEvidenceRef(runId, evidence.patch.artifact_id),
        artifactEvidenceRef(runId, evidence.report.artifact_id),
        artifactEvidenceRef(runId, evidence.candidate.artifact_id),
        ...evidence.testReports.map((artifact) => artifactEvidenceRef(runId, artifact.artifact_id)),
        ...(planRef === null ? [] : [planRef]),
        ...grantReference,
      ]),
    };
    return this.options.machine.freezeCandidate(input);
  }

  /** The run's retained artifacts, matched to the frozen revision and digests. */
  private retainedEvidence(
    run: RunRecord,
    artifacts: PreparedArtifacts,
    passing: DshValidationEvidence[],
  ): {
    patch: ArtifactRef;
    report: ArtifactRef;
    candidate: ArtifactRef;
    testReports: ArtifactRef[];
  } {
    const at = (kind: string, digest: string): ArtifactRef | undefined =>
      run.artifact_refs.find(
        (ref) =>
          ref.kind === kind &&
          ref.digest === digest &&
          ref.base_sha === artifacts.diff.base_sha &&
          ref.head_sha === artifacts.diff.head_sha,
      );
    const patch = at("patch", artifacts.patchDigest);
    if (patch === undefined) {
      throw new CollabError("CANDIDATE_INVALID", "the run retained no patch artifact", {
        run_id: run.run_id,
      });
    }
    const report = at("report", artifacts.reportDigest);
    if (report === undefined) {
      throw new CollabError("CANDIDATE_INVALID", "the run retained no report artifact", {
        run_id: run.run_id,
      });
    }
    const candidate = at("candidate", artifacts.candidateDigest);
    if (candidate === undefined) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        "the run retained no matching candidate artifact",
        {
          run_id: run.run_id,
          candidate_digest: artifacts.candidateDigest,
        },
      );
    }
    const testReports = passing.map((attempt, index) => {
      const digest = requireDigestValue(
        attempt.output_digest,
        `validation[${index}].output_digest`,
      );
      const artifact = at("test_report", digest);
      if (artifact === undefined) {
        throw new CollabError(
          "CANDIDATE_INVALID",
          "a passing validation attempt has no retained test report",
          { digest },
        );
      }
      return artifact;
    });
    return { patch, report, candidate, testReports };
  }

  private planReference(runId: string): string | null {
    const plan = this.options.machine.getTestPlan(runId);
    return plan === undefined ? null : planEvidenceRef(runId, plan.plan_id);
  }

  // ------------------------------------------------------------ recording

  private ensureIssue(
    observation: PreparationObservation,
    repositoryUrl: string,
    run: DshRunResponse,
  ): IssueRecord {
    const machine = this.options.machine;
    const dedupeKey = `autofixer-task:${observation.taskId}`;
    const existing = machine.listIssues().find((issue) => issue.dedupe_key === dedupeKey);
    if (existing !== undefined) {
      if (
        existing.workspace.enterprise_id !== observation.workspace.enterprise_id ||
        existing.workspace.workspace_id !== observation.workspace.workspace_id ||
        existing.repository.repository_id !== observation.repository.repository_id
      ) {
        throw new CollabError(
          "ISSUE_DEDUPE_CONFLICT",
          "the task is already recorded under another workspace or repository",
          {
            task_id: observation.taskId,
            issue_id: existing.issue_id,
          },
        );
      }
      return existing;
    }
    return machine.createIssue({
      operation_id: this.operation(run.run_id, "issue"),
      actor: this.options.actor,
      workspace: observation.workspace,
      repository: {
        repository_id: observation.repository.repository_id,
        url: repositoryUrl,
        base_ref: observation.repository.base_ref,
        base_sha: observation.repository.base_sha,
      },
      dedupe_key: dedupeKey,
      summary: observation.summary.slice(0, 1000),
      source_reference: observation.sourceReference ?? `forgepilot://tasks/${observation.taskId}`,
    });
  }

  /**
   * Record the repository base this preparation observed. A base advance is a
   * durable fact: candidates frozen against the older base are invalidated by
   * the machine before a new candidate is frozen.
   */
  private alignBase(
    issue: IssueRecord,
    observation: PreparationObservation,
    runId: string,
    grant: ParsedGrant,
  ): IssueRecord {
    if (
      issue.repository.base_sha === observation.repository.base_sha &&
      issue.repository.base_ref === observation.repository.base_ref
    ) {
      return issue;
    }
    if (grant.grant.base_sha !== observation.repository.base_sha) {
      throw new CollabError(
        "BASE_ADVANCED",
        "the run grant and the task disagree about the base revision",
        {
          grant_base_sha: grant.grant.base_sha,
          task_base_sha: observation.repository.base_sha,
        },
      );
    }
    return this.options.machine.recordBaseAdvance({
      operation_id: this.operation(runId, "base-advance"),
      actor: this.options.actor,
      issue_id: issue.issue_id,
      base_sha: observation.repository.base_sha,
      base_ref: observation.repository.base_ref,
    }).issue;
  }

  private ensureImplementing(issue: IssueRecord, runId: string): void {
    const steps: ProductState[] = [];
    switch (issue.product_state) {
      case "triage":
        steps.push("planning", "implementing");
        break;
      case "planning":
      case "awaiting_change_approval":
      case "needs_human":
        steps.push("implementing");
        break;
      case "implementing":
      case "validating":
        break;
      default:
        throw new CollabError(
          "CANDIDATE_INVALID",
          `no preparation may open in product state ${issue.product_state}`,
          { issue_id: issue.issue_id, product_state: issue.product_state },
        );
    }
    for (const to of steps) {
      this.options.machine.transitionIssue({
        operation_id: this.operation(runId, `issue-to-${to}`),
        actor: this.options.actor,
        issue_id: issue.issue_id,
        to,
        reason: null,
      });
    }
  }

  private ensureRun(
    issue: IssueRecord,
    observation: PreparationObservation,
    grant: ParsedGrant,
  ): RunRecord {
    const machine = this.options.machine;
    const worktreeId = `dsh-${observation.run.run_id}`;
    const existing = machine
      .listRuns(issue.issue_id)
      .find((candidate) => candidate.worktree.worktree_id === worktreeId);
    if (existing !== undefined) {
      return existing;
    }
    const repository: RepositoryRef = {
      repository_id: issue.repository.repository_id,
      url: grant.repositoryUrl,
      base_ref: observation.repository.base_ref,
      base_sha: observation.repository.base_sha,
    };
    return machine.openRun({
      operation_id: this.operation(observation.run.run_id, "run"),
      actor: this.options.actor,
      issue_id: issue.issue_id,
      task_id: null,
      role: "implementation",
      repository,
      worktree: { worktree_id: worktreeId, path: `dsh://runs/${observation.run.run_id}` },
      scope: {
        tools: unique(grant.grant.permitted_tools.map((tool) => tool.identity)),
        paths: unique(grant.grant.permitted_paths),
        network: unique(grant.grant.network_destinations),
      },
      limits: {
        max_wall_clock_seconds: grant.grant.max_wall_clock_seconds,
        max_memory_mb: grant.grant.resource_limits.max_memory_mb,
        max_tokens: grant.grant.resource_limits.max_tokens,
      },
    });
  }

  private ensureLease(runId: string): LeaseRef {
    const machine = this.options.machine;
    const run = machine.getRun(runId);
    if (run === undefined) {
      throw new CollabError("RUN_NOT_FOUND", "unknown preparation run", { run_id: runId });
    }
    const now = machine.now();
    if (run.lease !== null && run.lease.expires_at > now) {
      if (run.lease.holder !== this.options.actor) {
        throw new CollabError("LEASE_HELD", "the preparation run is leased by another worker", {
          run_id: runId,
          holder: run.lease.holder,
        });
      }
      // Resume after a crash inside this process: the lease is still ours.
      return { holder: run.lease.holder, fencing_token: run.lease.fencing_token };
    }
    const lease = machine.acquireLease({
      operation_id: this.operation(
        runId,
        `lease-${run.fencing_counter + 1}-${run.lease === null ? "free" : `expired-${run.lease.fencing_token}`}`,
      ),
      actor: this.options.actor,
      run_id: runId,
      holder: this.options.actor,
      ttl_seconds: Math.max(120, run.limits.max_wall_clock_seconds * 2),
    });
    return { holder: lease.holder, fencing_token: lease.fencing_token };
  }

  private recordGrant(runId: string, lease: LeaseRef, parsed: ParsedGrant): CapabilityGrant {
    const { base_sha: _baseSha, ...grant } = parsed.grant;
    return this.options.machine.recordGrant({
      operation_id: this.operation(runId, "grant"),
      actor: this.options.actor,
      run_id: runId,
      lease,
      grant: { ...grant, grant_id: "" } as GrantInput,
    });
  }

  private recordRunState(
    runId: string,
    lease: LeaseRef,
    to: "approved" | "running" | "stopped",
    headSha?: string,
  ): RunRecord {
    return this.options.machine.recordRunState({
      operation_id: this.operation(runId, `state-${to}`),
      actor: this.options.actor,
      run_id: runId,
      lease,
      to,
      ...(to === "stopped"
        ? {
            stop_reason: "local preparation completed; candidate revision frozen",
            head_sha: headSha ?? null,
          }
        : {}),
    });
  }

  private releaseLease(runId: string, lease: LeaseRef): void {
    this.options.machine.releaseLease({
      operation_id: this.operation(runId, "lease-release"),
      actor: this.options.actor,
      run_id: runId,
      ...lease,
    });
  }

  private ensurePlan(runId: string, policy: TestPolicyRecord): TestPlanRecord {
    const existing = this.options.machine.getTestPlan(runId);
    if (existing !== undefined) {
      return existing;
    }
    // A test plan is policy, not a worker decision; the command records only
    // the binding to the repository's registered policy version.
    return this.options.machine.recordTestPlan({
      operation_id: this.operation(runId, "plan"),
      actor: this.options.actor,
      run_id: runId,
      policy_id: policy.policy_id,
    });
  }

  /**
   * Register (or reuse) the exact test-policy version this bridge measures.
   * The checks, environment, and configuration digest are deployment policy:
   * the bridge never derives the required checks from what the run executed.
   */
  private ensurePolicy(
    workspace: WorkspaceScope,
    repositoryId: string,
    repositoryUrl: string,
  ): TestPolicyRecord {
    const machine = this.options.machine;
    const policyVersion = `1-${createHash("sha256")
      .update(
        JSON.stringify({
          checks: this.policy.checks,
          environment: this.policy.environment,
          config_digest: this.policy.configDigest,
          repository_url: repositoryUrl,
        }),
        "utf8",
      )
      .digest("hex")
      .slice(0, 12)}`;
    const current = machine.currentTestPolicy(workspace, repositoryId);
    if (
      current !== undefined &&
      current.policy_version === policyVersion &&
      current.config_digest === this.policy.configDigest &&
      current.environment === this.policy.environment &&
      canonicalChecks(current.checks) === canonicalChecks(this.policy.checks)
    ) {
      return current;
    }
    const input: RegisterTestPolicyInput = {
      operation_id: `prep:policy:${workspace.enterprise_id}:${workspace.workspace_id}:${repositoryId}:${policyVersion}`,
      actor: this.options.actor,
      workspace,
      repository_id: repositoryId,
      repository_url: repositoryUrl,
      policy_version: policyVersion,
      checks: [...this.policy.checks],
      config_digest: this.policy.configDigest,
      environment: this.policy.environment,
    };
    return machine.registerTestPolicy(input);
  }

  private attachEvidence(
    runId: string,
    lease: LeaseRef,
    baseSha: string,
    headSha: string,
    artifacts: PreparedArtifacts,
    passing: DshValidationEvidence[],
  ): void {
    this.attach(runId, lease, baseSha, headSha, "patch", artifacts.patchDigest);
    this.attach(runId, lease, baseSha, headSha, "report", artifacts.reportDigest);
    this.attach(runId, lease, baseSha, headSha, "candidate", artifacts.candidateDigest);
    for (const [index, attempt] of passing.entries()) {
      const digest = requireDigestValue(
        attempt.output_digest,
        `validation[${index}].output_digest`,
      );
      this.attach(runId, lease, baseSha, headSha, "test_report", digest, attempt.event_reference);
    }
  }

  private attach(
    runId: string,
    lease: LeaseRef,
    baseSha: string,
    headSha: string,
    kind: string,
    digest: string,
    discriminator?: string,
  ): ArtifactRef {
    const artifact: ArtifactInput = {
      kind,
      digest_algorithm: "sha256",
      digest,
      base_sha: baseSha,
      head_sha: headSha,
    };
    return this.options.machine.attachArtifact({
      operation_id: this.operation(runId, `artifact-${kind}-${discriminator ?? digest}`),
      actor: this.options.actor,
      run_id: runId,
      lease,
      artifact,
    });
  }

  private advanceToAwaitingChangeApproval(issue: IssueRecord | undefined, runId: string): void {
    if (issue === undefined) {
      throw new CollabError("ISSUE_NOT_FOUND", "the preparation issue disappeared", {
        run_id: runId,
      });
    }
    let state = issue.product_state;
    if (state === "implementing") {
      state = this.transitionIssue(issue.issue_id, runId, "validating").product_state;
    }
    if (state === "validating") {
      this.transitionIssue(issue.issue_id, runId, "awaiting_change_approval");
    }
  }

  private transitionIssue(issueId: string, runId: string, to: ProductState): IssueRecord {
    return this.options.machine.transitionIssue({
      operation_id: this.operation(runId, `issue-to-${to}`),
      actor: this.options.actor,
      issue_id: issueId,
      to,
      reason: null,
    });
  }

  // ------------------------------------------------------------ disposition

  private wasDispositioned(issue: IssueRecord, runId: string): boolean {
    return (
      issue.product_state === "needs_human" &&
      (issue.state_reason ?? "").startsWith(this.failurePrefix(runId))
    );
  }

  private failurePrefix(runId: string): string {
    return `preparation_failed:${runId}: `;
  }

  /**
   * Record why a completed preparation produced no candidate. The issue is the
   * durable record a human acts on; the run keeps its truthful stopped state.
   * A failed disposition never masquerades as a successful freeze and never
   * hides the original error.
   */
  private dispositionFailure(issue: IssueRecord, run: DshRunResponse, error: unknown): void {
    const machine = this.options.machine;
    const current = machine.getIssue(issue.issue_id) ?? issue;
    if (
      current.product_state === "needs_human" ||
      current.product_state === "cancelled" ||
      current.product_state === "completed"
    ) {
      return;
    }
    const code = error instanceof CollabError ? error.code : "PREPARATION_FAILED";
    const detail =
      error instanceof CollabError
        ? error.message
        : error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
    const reason = `${this.failurePrefix(run.run_id)}${code}: ${detail}`.slice(0, 500);
    try {
      machine.transitionIssue({
        operation_id: this.operation(
          run.run_id,
          `needs-human-${createHash("sha256").update(reason, "utf8").digest("hex").slice(0, 10)}`,
        ),
        actor: this.options.actor,
        issue_id: issue.issue_id,
        to: "needs_human",
        reason,
      });
    } catch {
      // The freeze failure is the outcome worth surfacing; an issue that
      // cannot record the disposition keeps its current truthful state.
    }
  }

  private operation(runId: string, name: string): string {
    return `prep:${runId}:${name}`;
  }
}

// ---------------------------------------------------------------- artifacts

interface VerifiedArtifact<T> {
  content: T;
  digest: string;
}

/**
 * Validate one dsh artifact envelope before anything reads its content.
 *
 * The envelope must be the requested artifact of exactly this run, its digest
 * must be a sha256 hex value, and that value must recompute from the content.
 * An artifact that merely declares a digest — a substituted document, a stale
 * read from another run, a corrupted body — never reaches the freeze.
 */
function verifiedArtifact<T>(
  raw: Record<string, unknown>,
  runId: string,
  artifactType: string,
): VerifiedArtifact<T> {
  if (raw["artifact_type"] !== artifactType) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `expected the ${artifactType} artifact, dsh returned ${String(raw["artifact_type"])}`,
      { artifact_type: raw["artifact_type"] },
    );
  }
  if (raw["run_id"] !== runId) {
    throw new CollabError("CANDIDATE_INVALID", `${artifactType} artifact belongs to another run`, {
      artifact_type: artifactType,
      run_id: raw["run_id"],
      expected: runId,
    });
  }
  const content = raw["content"];
  if (!isRecord(content)) {
    throw new CollabError("CANDIDATE_INVALID", `${artifactType} artifact has no content object`, {
      artifact_type: artifactType,
    });
  }
  const digest = raw["digest"];
  if (!isRecord(digest)) {
    throw new CollabError("CANDIDATE_INVALID", `${artifactType} artifact has no digest`, {
      artifact_type: artifactType,
    });
  }
  const algorithm = digest["algorithm"];
  const value = digest["value"];
  if (algorithm !== "sha256" || typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new CollabError("CANDIDATE_INVALID", `${artifactType} artifact digest is not sha256`, {
      artifact_type: artifactType,
    });
  }
  const computed = canonicalArtifactDigest(content);
  if (computed !== value) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      `${artifactType} artifact content does not match its envelope digest`,
      { artifact_type: artifactType, declared: value, computed },
    );
  }
  return { content: content as T, digest: value };
}

/**
 * The sha256 dsh stamps on an artifact envelope: Go's `encoding/json` bytes of
 * the content document. The response preserves struct field order, so
 * `JSON.stringify` reproduces the same document except for the HTML escapes
 * Go always applies (`<`, `>`, `&`) and the U+2028/U+2029 escapes it adds for
 * JSONP safety; those are re-applied here before hashing.
 *
 * Exported so tests can build envelopes the way dsh does instead of copying
 * the encoding rules.
 */
export function canonicalArtifactDigest(content: unknown): string {
  const serialized = JSON.stringify(content);
  if (serialized === undefined) {
    throw new CollabError("CANDIDATE_INVALID", "artifact content is not JSON-serializable", {});
  }
  const canonical = serialized.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

interface NormalizedAttempt {
  tool: string;
  arguments: string[];
  exit_status: number | null;
  output_digest: { algorithm: "sha256"; value: string };
  event_reference: string;
}

/**
 * Parse one validation-attempt list into an exact, comparable shape. Attempts
 * are execution evidence: a check name, the registered arguments, an exit
 * status, the output digest, and the event that proves it. Anything else is
 * not evidence and stops the freeze.
 */
function normalizedAttempts(
  value: unknown,
  field: string,
  run: DshRunResponse,
): NormalizedAttempt[] {
  if (!Array.isArray(value)) {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be an array`, { field });
  }
  return value.map((entry, index) => {
    const attempt = asRecord(entry, `${field}[${index}]`);
    const rawArguments = attempt["arguments"] ?? [];
    if (
      !Array.isArray(rawArguments) ||
      rawArguments.some((argument) => typeof argument !== "string")
    ) {
      throw new CollabError("CANDIDATE_INVALID", `${field}[${index}].arguments must be strings`, {
        field: `${field}[${index}].arguments`,
      });
    }
    const exitStatus = attempt["exit_status"];
    if (
      exitStatus !== null &&
      exitStatus !== undefined &&
      (typeof exitStatus !== "number" || !Number.isInteger(exitStatus))
    ) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        `${field}[${index}].exit_status must be an integer or null`,
        { field: `${field}[${index}].exit_status` },
      );
    }
    const digest = attempt["output_digest"];
    if (
      !isRecord(digest) ||
      digest["algorithm"] !== "sha256" ||
      typeof digest["value"] !== "string" ||
      !SHA256_HEX.test(digest["value"])
    ) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        `${field}[${index}].output_digest must be a sha256 digest`,
        { field: `${field}[${index}].output_digest` },
      );
    }
    const eventReference = requireString(
      attempt["event_reference"],
      `${field}[${index}].event_reference`,
    );
    const event = /^evidence:\/\/events\/([^/]+)\/([0-9]+)$/.exec(eventReference);
    if (event === null || event[1] !== run.run_id || Number(event[2]) < 1) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        `${field}[${index}].event_reference does not name an event of this run`,
        { field: `${field}[${index}].event_reference`, event_reference: eventReference },
      );
    }
    return {
      tool: requireString(attempt["tool"], `${field}[${index}].tool`),
      arguments: rawArguments as string[],
      exit_status: exitStatus === undefined ? null : exitStatus,
      output_digest: { algorithm: "sha256", value: digest["value"] },
      event_reference: eventReference,
    };
  });
}

function attemptSignatures(attempts: NormalizedAttempt[]): string[] {
  return attempts.map((attempt) =>
    JSON.stringify([
      attempt.tool,
      attempt.arguments,
      attempt.exit_status,
      attempt.output_digest.value,
      attempt.event_reference,
    ]),
  );
}

function attemptsEqual(left: NormalizedAttempt[], right: NormalizedAttempt[]): boolean {
  const leftSignatures = attemptSignatures(left);
  const rightSignatures = attemptSignatures(right);
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((signature, index) => signature === rightSignatures[index])
  );
}

function requireDigestValue(
  digest: { algorithm: string; value: string } | undefined,
  field: string,
): string {
  if (digest === undefined || digest.algorithm !== "sha256" || !SHA256_HEX.test(digest.value)) {
    throw new CollabError("CANDIDATE_INVALID", `${field} is not a sha256 digest`, { field });
  }
  return digest.value;
}

// ------------------------------------------------------------------- policy

/**
 * The passing attempts a frozen candidate may claim, or null when the
 * preparation is not acceptable under the policy.
 *
 * A failed attempt of the frozen revision is a truthful failure, not a
 * candidate: local preparation needs human disposition. So is a required check
 * with no recorded attempt.
 */
function qualifiedAttempts(
  attempts: DshValidationEvidence[],
  checks: string[],
): DshValidationEvidence[] | null {
  const failed = attempts.filter((attempt) => attempt.exit_status !== 0);
  if (failed.length > 0) {
    return null;
  }
  const passing = attempts.filter(
    (attempt) =>
      attempt.exit_status === 0 &&
      attempt.output_digest !== undefined &&
      attempt.event_reference !== "",
  );
  for (const check of checks) {
    if (!passing.some((attempt) => attempt.tool === check)) {
      return null;
    }
  }
  return passing.filter((attempt) => checks.includes(attempt.tool));
}

// ---------------------------------------------------------------- grant

function parseGrant(run: DshRunResponse): ParsedGrant {
  const raw = run.grant_status.grant;
  if (raw === null || raw === undefined) {
    throw new CollabError(
      "CANDIDATE_INVALID",
      "the stopped run has no capability grant to bind the preparation to",
      { run_id: run.run_id, grant_state: run.grant_status.state },
    );
  }
  const repositoryUrl = requireString(raw["repository_url"], "grant.repository_url");
  const resourceLimits = asRecord(raw["resource_limits"], "grant.resource_limits");
  return {
    repositoryUrl,
    grant: {
      capability_grant_version: requireString(
        raw["capability_grant_version"],
        "grant.capability_grant_version",
      ),
      policy_version: requireString(raw["policy_version"], "grant.policy_version"),
      issued_at: isoOf(raw["issued_at"], "grant.issued_at"),
      expires_at: isoOf(raw["expires_at"], "grant.expires_at"),
      permitted_paths: stringArrayOf(raw["permitted_paths"], "grant.permitted_paths"),
      permitted_tools: grantToolsOf(raw["permitted_tools"]),
      network_destinations: stringArrayOf(
        raw["network_destinations"] ?? [],
        "grant.network_destinations",
      ),
      max_wall_clock_seconds: positiveIntOf(
        raw["max_wall_clock_seconds"],
        "grant.max_wall_clock_seconds",
      ),
      resource_limits: {
        max_memory_mb: positiveIntOf(
          resourceLimits["max_memory_mb"],
          "grant.resource_limits.max_memory_mb",
        ),
        max_tokens: DEFAULT_MAX_TOKENS,
      },
      may_create_patch: boolOf(raw["may_create_patch"], "grant.may_create_patch"),
      may_create_or_update_pr: boolOf(
        raw["may_create_or_update_pr"],
        "grant.may_create_or_update_pr",
      ),
      scope_digest: run.grant_status.scope_digest,
      base_sha: requireString(raw["base_sha"], "grant.base_sha"),
    },
  };
}

function grantToolsOf(value: unknown): Array<{ identity: string; allowed_arguments: string[] }> {
  if (!Array.isArray(value)) {
    throw new CollabError("CANDIDATE_INVALID", "grant.permitted_tools must be an array", {
      field: "grant.permitted_tools",
    });
  }
  return value.map((entry, index) => {
    const tool = asRecord(entry, `grant.permitted_tools[${index}]`);
    return {
      identity: requireString(tool["identity"], `grant.permitted_tools[${index}].identity`),
      allowed_arguments: stringArrayOf(
        tool["allowed_arguments"],
        `grant.permitted_tools[${index}].allowed_arguments`,
      ),
    };
  });
}

// ------------------------------------------------------------------ parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be an object`, { field });
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be a non-empty string`, { field });
  }
  return value;
}

function stringArrayOf(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be a string array`, { field });
  }
  return value as string[];
}

function isoOf(value: unknown, field: string): string {
  const text = requireString(value, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be an ISO timestamp`, { field });
  }
  return new Date(parsed).toISOString();
}

function positiveIntOf(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be a positive integer`, { field });
  }
  return parsed;
}

function boolOf(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CollabError("CANDIDATE_INVALID", `${field} must be a boolean`, { field });
  }
  return value;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value !== "" && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function canonicalChecks(checks: string[]): string {
  return JSON.stringify([...checks].sort());
}
