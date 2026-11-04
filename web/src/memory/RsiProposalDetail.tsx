import { useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  ForgePilotClient,
  RsiApproval,
  RsiCanaryObservation,
  RsiEvaluation,
  RsiProposal,
  RsiRollout,
  RsiStatus,
  Workspace,
} from "../api/client";
import { formatDate, shortId } from "../ui/format";
import { redactText } from "../ui/redaction";
import {
  APPROVAL_KEY_LABELS,
  describeRsiError,
  evaluationsByDataset,
  evidenceRisk,
  formatCost,
  formatInterval,
  formatRate,
  formatSignedPercent,
  GATE_NOTE,
  HOLDOUT_NOTE,
  RISK_LADDER,
  rsiRiskLabel,
  rsiStatusLabel,
  rsiStatusTone,
  rsiTargetLabel,
  stageLabel,
  verdictLabel,
  verdictTone,
} from "./rsi-format";
import type { RsiError } from "./rsi-format";

interface RsiProposalDetailProps {
  client: ForgePilotClient;
  workspaceId: string;
  proposalId: string;
  seed: RsiProposal | undefined;
  role: Workspace["role"];
  currentUserId: string | undefined;
  status: RsiStatus | undefined;
  onBack: () => void;
  onChanged: () => void;
}

export function RsiProposalDetail({
  client,
  workspaceId,
  proposalId,
  seed,
  role,
  currentUserId,
  status,
  onBack,
  onChanged,
}: RsiProposalDetailProps): ReactElement {
  const [proposal, setProposal] = useState<RsiProposal | undefined>(seed);
  const [loading, setLoading] = useState(seed === undefined);
  const [loadError, setLoadError] = useState<RsiError | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    client
      .getRsiProposal(workspaceId, proposalId)
      .then((next) => {
        if (!active) return;
        setProposal(next);
        setLoadError(undefined);
      })
      .catch((caught: unknown) => {
        if (active) setLoadError(describeRsiError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, proposalId, reloadToken]);

  async function runAction(label: string, action: () => Promise<RsiProposal>): Promise<boolean> {
    setBusy(label);
    setActionError(undefined);
    try {
      const updated = await action();
      setProposal(updated);
      onChanged();
      return true;
    } catch (caught) {
      const described = describeRsiError(caught);
      setActionError(`${described.code}: ${described.message}`);
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  const canEvaluate = role === "owner";
  const canApprove = role === "owner" || role === "admin";
  const canOperate = role === "owner";
  const isProposer = currentUserId !== undefined && proposal?.proposer.id === currentUserId;
  const final = proposal?.status === "promoted" || proposal?.status === "rolled_back";
  const approvalComplete =
    proposal !== undefined && proposal.gate.approvals_satisfied >= proposal.gate.approvals_required;
  const rollout = proposal?.rollout ?? undefined;
  const evidence = proposal ? evidenceRisk(proposal) : undefined;
  const grouped = proposal ? evaluationsByDataset(proposal.evaluations) : undefined;

  const evaluateDisabledReason = !canEvaluate
    ? "Owner role required to run the replay."
    : isProposer
      ? "The proposer cannot evaluate its own proposal."
      : final
        ? "This proposal is final."
        : proposal?.gate.kill_switch
          ? "The workspace kill switch is engaged."
          : undefined;
  const approveDisabledReason = !canApprove
    ? "Owner or admin role required to approve."
    : isProposer
      ? "The proposer cannot approve its own proposal."
      : final
        ? "This proposal is final."
        : proposal?.gate.offline_evaluation !== "pass"
          ? "The offline replay has not passed."
          : approvalComplete
            ? "The required approvals are already recorded."
            : undefined;
  const canaryDisabledReason = !canOperate
    ? "Owner role required to start a canary."
    : proposal?.gate.kill_switch
      ? "The workspace kill switch is engaged."
      : !proposal?.gate.canary_eligible
        ? "The server gate reports this proposal is not canary eligible."
        : proposal.status !== "ready"
          ? `Only a ready proposal starts a canary (current: ${rsiStatusLabel(proposal.status)}).`
          : undefined;

  return (
    <section className="detail-view rsi-detail" aria-labelledby="rsi-detail-title">
      <div className="detail-header">
        <button type="button" className="detail-back" onClick={onBack}>
          ← RSI
        </button>
        <div className="detail-heading">
          <div className="breadcrumb">PROPOSAL / {shortId(proposalId, 18)}</div>
          <h2 id="rsi-detail-title">
            {proposal ? redactText(proposal.title) : "Loading proposal…"}
          </h2>
          {proposal && (
            <div className="detail-subline">
              <span>{rsiTargetLabel(proposal.target)}</span>
              <span className="divider">·</span>
              <span>{rsiRiskLabel(proposal.risk)}</span>
              <span className="divider">·</span>
              <span>Created {formatDate(proposal.created_at)}</span>
              <span className="divider">·</span>
              <span className="mono">{shortId(proposal.proposer.id, 18)}</span>
            </div>
          )}
        </div>
        <div className="detail-actions">
          {proposal && (
            <div className={`stage-pill rsi-tone-${rsiStatusTone(proposal.status)}`}>
              <span className="eyebrow">Proposal</span>
              <strong>{rsiStatusLabel(proposal.status)}</strong>
            </div>
          )}
        </div>
      </div>

      {status && (
        <div className="rsi-status-ribbon" role="group" aria-label="Workspace RSI state">
          <span className={`rsi-chip rsi-chip-${status.controls.kill_switch ? "danger" : "done"}`}>
            {status.controls.kill_switch ? "Kill switch engaged" : "Kill switch off"}
          </span>
          <span className="rsi-chip">Changes left {status.budget.changes_remaining}</span>
          <span className="rsi-chip">
            Reflection tokens left {status.budget.reflection_tokens_remaining.toLocaleString()}
          </span>
          <span className="rsi-chip">Holdout {status.holdout.cases} cases</span>
        </div>
      )}

      {loadError && (
        <div className="connection-banner" role="alert">
          <span className="banner-dot" />
          <div>
            <strong>
              {loadError.missing ? "Proposal not available" : "Proposal could not be loaded"}
            </strong>
            <span>
              {loadError.code}: {loadError.message}
            </span>
          </div>
          {!loadError.missing && (
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {actionError && (
        <div className="inline-error" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            aria-label="Dismiss proposal action error"
            onClick={() => setActionError(undefined)}
          >
            ×
          </button>
        </div>
      )}

      {!proposal ? (
        <div className="card card-empty">
          {loading ? "Reading the proposal projection…" : "No proposal projection is available."}
        </div>
      ) : (
        <div className="detail-grid">
          <div className="detail-main-column">
            {proposal.gate.kill_switch && (
              <div className="rsi-alert rsi-alert-danger" role="alert">
                <span className="reason-icon">!</span>
                <div>
                  <strong>Workspace kill switch is engaged</strong>
                  <p>
                    Evaluations, approvals, and canaries are refused until the owner releases it.
                  </p>
                </div>
              </div>
            )}

            {evidence && evidence.safetyEvents > 0 && (
              <div className="rsi-alert rsi-alert-danger" role="alert">
                <span className="reason-icon">!</span>
                <div>
                  <strong>Security event recorded</strong>
                  <p>
                    {evidence.safetyEvents} forbidden item injection
                    {evidence.safetyEvents === 1 ? "" : "s"} appeared in the offline evidence. A
                    single event fails the replay and blocks promotion.
                  </p>
                </div>
              </div>
            )}

            {evidence && (evidence.regressions.length > 0 || evidence.failed.length > 0) && (
              <div className="rsi-alert rsi-alert-attention" role="alert">
                <span className="reason-icon">!</span>
                <div>
                  <strong>Regression evidence</strong>
                  <p>
                    {evidence.failed.length > 0
                      ? `${evidence.failed.length} dataset verdict${evidence.failed.length === 1 ? "" : "s"} failed. `
                      : ""}
                    {evidence.regressions.length > 0
                      ? `${evidence.regressions.length} dataset${evidence.regressions.length === 1 ? "" : "s"} show a negative success delta. `
                      : ""}
                    Inconclusive blocks promotion; it is never a soft pass.
                  </p>
                </div>
              </div>
            )}

            {proposal.status_reason && (
              <div className="rsi-alert rsi-alert-attention" role="status">
                <span className="reason-icon">!</span>
                <div>
                  <strong>Recorded status reason</strong>
                  <p>{redactText(proposal.status_reason)}</p>
                </div>
              </div>
            )}

            <section className="card rsi-gate-card" aria-labelledby="rsi-gate-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Server gate</span>
                  <h3 id="rsi-gate-heading">Evidence → approval → canary</h3>
                </div>
                <span
                  className={`rsi-status-pill rsi-tone-${
                    proposal.gate.canary_eligible ? "done" : "attention"
                  }`}
                >
                  {proposal.gate.canary_eligible ? "Canary eligible" : "Not eligible"}
                </span>
              </div>
              <p className="rsi-hint">{GATE_NOTE}</p>

              <div className="rsi-gate-grid">
                <div>
                  <span className="metric-label">Offline evaluation</span>
                  <strong
                    className={`rsi-verdict rsi-tone-${verdictTone(
                      proposal.gate.offline_evaluation === "missing"
                        ? "inconclusive"
                        : proposal.gate.offline_evaluation,
                    )}`}
                  >
                    {proposal.gate.offline_evaluation === "missing"
                      ? "Missing"
                      : verdictLabel(proposal.gate.offline_evaluation)}
                  </strong>
                </div>
                <div>
                  <span className="metric-label">Holdout required</span>
                  <strong>{proposal.gate.holdout_required ? "Yes" : "No"}</strong>
                </div>
                <div>
                  <span className="metric-label">Approvals</span>
                  <strong>
                    {proposal.gate.approvals_satisfied} / {proposal.gate.approvals_required}
                    {proposal.gate.approval_keys.length > 0
                      ? ` · ${proposal.gate.approval_keys
                          .map((key) => APPROVAL_KEY_LABELS[key])
                          .join(", ")}`
                      : " · none required"}
                  </strong>
                </div>
                <div>
                  <span className="metric-label">Change budget</span>
                  <strong className={proposal.gate.budget_ok ? undefined : "rsi-danger-text"}>
                    {proposal.gate.budget_ok ? "Available" : "Exhausted"}
                  </strong>
                </div>
                <div>
                  <span className="metric-label">Kill switch</span>
                  <strong className={proposal.gate.kill_switch ? "rsi-danger-text" : undefined}>
                    {proposal.gate.kill_switch ? "Engaged" : "Off"}
                  </strong>
                </div>
                <div>
                  <span className="metric-label">Risk ladder</span>
                  <strong>{RISK_LADDER[proposal.risk].requirement}</strong>
                </div>
              </div>

              {proposal.gate.reasons.length > 0 && (
                <div className="rsi-gate-reasons">
                  <span className="field-label">Server-reported blockers</span>
                  <ul>
                    {proposal.gate.reasons.map((reason) => (
                      <li key={reason}>{redactText(reason)}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rsi-action-row">
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={Boolean(evaluateDisabledReason) || busy !== undefined}
                  title={evaluateDisabledReason}
                  onClick={() =>
                    void runAction("evaluate", () =>
                      client.evaluateRsiProposal(workspaceId, proposal.proposal_id, [
                        "golden",
                        "holdout",
                      ]),
                    )
                  }
                >
                  {busy === "evaluate" ? "Running replay…" : "Run offline replay"}
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={Boolean(approveDisabledReason) || busy !== undefined}
                  title={approveDisabledReason}
                  onClick={() => setApprovalDialogOpen(true)}
                >
                  {approvalComplete ? "Approvals complete" : "Record approval"}
                </button>
                <button
                  type="button"
                  className="button button-primary button-small"
                  disabled={Boolean(canaryDisabledReason) || busy !== undefined}
                  title={canaryDisabledReason}
                  onClick={() =>
                    void runAction("canary", () =>
                      client.startRsiCanary(workspaceId, proposal.proposal_id),
                    )
                  }
                >
                  {busy === "canary" ? "Starting…" : "Start 10% canary"}
                </button>
                {(proposal.status === "canary" || proposal.status === "promoted") && (
                  <button
                    type="button"
                    className="button button-danger button-small"
                    disabled={!canOperate || busy !== undefined}
                    title={!canOperate ? "Owner role required to roll back." : undefined}
                    onClick={() => setRollbackDialogOpen(true)}
                  >
                    Roll back
                  </button>
                )}
              </div>

              {evaluateDisabledReason && (
                <p className="stage-terminal-note" role="status">
                  {evaluateDisabledReason}
                </p>
              )}
              {approveDisabledReason && (
                <p className="stage-terminal-note" role="status">
                  {approveDisabledReason}
                </p>
              )}
              {canaryDisabledReason && (
                <p className="stage-terminal-note" role="status">
                  {canaryDisabledReason}
                </p>
              )}
            </section>

            <section className="card rsi-diff-card" aria-labelledby="rsi-diff-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Proposed change</span>
                  <h3 id="rsi-diff-heading">Artifact diff</h3>
                </div>
                <span className="event-count">{rsiTargetLabel(proposal.target)}</span>
              </div>
              <p className="rsi-hint">
                The diff is the stored artifact description. Holdout case content is never part of a
                proposal response.
              </p>
              <pre className="rsi-diff" aria-label="Proposal artifact diff">
                {proposal.diff.split("\n").map((line, index) => {
                  const added = line.startsWith("+") && !line.startsWith("+++");
                  const removed = line.startsWith("-") && !line.startsWith("---");
                  return (
                    <span
                      key={`${index}-${line}`}
                      className={
                        added ? "rsi-diff-added" : removed ? "rsi-diff-removed" : undefined
                      }
                    >
                      {redactText(line)}
                      {"\n"}
                    </span>
                  );
                })}
              </pre>
              <div className="rsi-detail-summary">
                <strong>Summary</strong>
                <p>{redactText(proposal.summary)}</p>
              </div>
            </section>

            <section className="card rsi-eval-card" aria-labelledby="rsi-eval-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Independent evidence</span>
                  <h3 id="rsi-eval-heading">Offline evaluations</h3>
                </div>
                <span className="event-count">
                  {proposal.evaluations.length}{" "}
                  {proposal.evaluations.length === 1 ? "record" : "records"}
                </span>
              </div>
              {proposal.evaluations.length === 0 ? (
                <div className="card-empty compact">
                  No replay has been recorded. The proposer cannot evaluate its own proposal, and no
                  caller can submit a score.
                </div>
              ) : (
                <>
                  {grouped?.golden.map((evaluation) => (
                    <EvaluationCard key={evaluation.evaluation_id} evaluation={evaluation} />
                  ))}
                  {grouped?.holdout.map((evaluation) => (
                    <HoldoutEvaluationCard key={evaluation.evaluation_id} evaluation={evaluation} />
                  ))}
                  <p className="rsi-hint">{HOLDOUT_NOTE}</p>
                </>
              )}
            </section>

            <section className="card rsi-approval-card" aria-labelledby="rsi-approvals-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Human gate</span>
                  <h3 id="rsi-approvals-heading">Approvals</h3>
                </div>
                <span className="event-count">{proposal.approvals.length} recorded</span>
              </div>
              <div className="rsi-approval-keys">
                {proposal.gate.approval_keys.length === 0 ? (
                  <span className="rsi-chip">No approval key required</span>
                ) : (
                  proposal.gate.approval_keys.map((key) => (
                    <span key={key} className="rsi-chip">
                      {APPROVAL_KEY_LABELS[key]}
                    </span>
                  ))
                )}
              </div>
              {proposal.approvals.length === 0 ? (
                <div className="card-empty compact">
                  No named human has approved this exact proposal version.
                </div>
              ) : (
                <ul className="rsi-approval-list">
                  {proposal.approvals.map((approval) => (
                    <ApprovalRow key={approval.approval_id} approval={approval} />
                  ))}
                </ul>
              )}
              <p className="rsi-hint">
                Approvals bind to proposal version {proposal.version}. A proposer may never approve
                its own proposal; the service enforces this even when the control is visible.
              </p>
            </section>

            <section className="card rsi-rollout-card" aria-labelledby="rsi-rollout-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Rollout</span>
                  <h3 id="rsi-rollout-heading">Canary &amp; rollback</h3>
                </div>
                {rollout && (
                  <span className={`rsi-status-pill rsi-tone-${rolloutTone(rollout.status)}`}>
                    {rollout.status}
                  </span>
                )}
              </div>
              {!rollout ? (
                <div className="card-empty compact">
                  No rollout exists for this proposal. A canary starts at 10% after the replay
                  passes, the required humans approve, the weekly change budget remains, and the
                  kill switch is off.
                </div>
              ) : (
                <>
                  <RolloutStages rollout={rollout} />
                  <div className="rsi-fact-grid">
                    <div>
                      <span className="metric-label">Baseline policy</span>
                      <strong className="mono">v{rollout.baseline_policy_version}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Candidate hash</span>
                      <strong className="mono">{shortId(rollout.candidate_hash, 22)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Started</span>
                      <strong>{formatDate(rollout.started_at)}</strong>
                    </div>
                    <div>
                      <span className="metric-label">Updated</span>
                      <strong>{formatDate(rollout.updated_at)}</strong>
                    </div>
                  </div>

                  {rollout.reason && (
                    <div className="rsi-alert rsi-alert-attention" role="status">
                      <span className="reason-icon">!</span>
                      <div>
                        <strong>
                          {rollout.status === "rolled_back" ? "Rollback reason" : "Rollout reason"}
                        </strong>
                        <p>{redactText(rollout.reason)}</p>
                        {rollout.ended_at && (
                          <span className="rsi-alert-meta">
                            Ended {formatDate(rollout.ended_at)}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {rollout.status === "canary" && (
                    <div className="rsi-action-row">
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={!canOperate || busy !== undefined}
                        title={!canOperate ? "Owner role required." : undefined}
                        onClick={() =>
                          void runAction("observe", () =>
                            client.recordRsiCanaryObservation(workspaceId, proposal.proposal_id),
                          )
                        }
                      >
                        {busy === "observe" ? "Recording…" : "Record stage observation"}
                      </button>
                    </div>
                  )}
                  {!canOperate && (
                    <p className="stage-terminal-note" role="status">
                      Owner role required to observe or stop a rollout.
                    </p>
                  )}

                  <div className="rsi-observations">
                    <span className="field-label">Stage observations</span>
                    {proposal.observations.length === 0 ? (
                      <div className="card-empty compact">
                        No stage observation is recorded. Samples are derived from pinned runs and
                        their terminal task outcomes; a request cannot supply them.
                      </div>
                    ) : (
                      <ul>
                        {proposal.observations.map((observation) => (
                          <ObservationRow
                            key={observation.observation_id}
                            observation={observation}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>

          <aside className="detail-side-column">
            <section className="card identity-card" aria-labelledby="rsi-artifact-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Artifact binding</span>
                  <h3 id="rsi-artifact-heading">Versions</h3>
                </div>
              </div>
              <div className="info-row">
                <span>Artifact</span>
                <strong>{proposal.artifact.kind}</strong>
              </div>
              <div className="info-row">
                <span>Baseline policy</span>
                <strong className="mono">v{proposal.artifact.baseline_policy_version}</strong>
              </div>
              <div className="info-row">
                <span>Candidate hash</span>
                <strong className="mono">
                  {shortId(proposal.artifact.candidate_policy_hash, 22)}
                </strong>
              </div>
              {proposal.artifact.item_id && (
                <div className="info-row">
                  <span>Item</span>
                  <strong className="mono">{redactText(proposal.artifact.item_id)}</strong>
                </div>
              )}
              {proposal.artifact.item_version !== null && (
                <div className="info-row">
                  <span>Item version</span>
                  <strong className="mono">v{proposal.artifact.item_version}</strong>
                </div>
              )}
              <div className="info-row">
                <span>Applied policy</span>
                <strong className="mono">
                  {proposal.applied_policy_version === null
                    ? "not applied"
                    : `v${proposal.applied_policy_version}`}
                </strong>
              </div>
              <div className="info-row">
                <span>Baseline memory</span>
                <strong className="mono">{shortId(proposal.baseline_memory_version, 22)}</strong>
              </div>
              <div className="info-row">
                <span>Proposal version</span>
                <strong className="mono">{proposal.version}</strong>
              </div>
            </section>

            <section className="card identity-card" aria-labelledby="rsi-proposer-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Provenance</span>
                  <h3 id="rsi-proposer-heading">Proposer</h3>
                </div>
              </div>
              <div className="info-row">
                <span>Identity</span>
                <strong className="mono">{redactText(proposal.proposer.id)}</strong>
              </div>
              <div className="info-row">
                <span>Kind</span>
                <strong>{proposal.proposer.kind}</strong>
              </div>
              {proposal.proposer.model && (
                <div className="info-row">
                  <span>Model</span>
                  <strong className="mono">{redactText(proposal.proposer.model)}</strong>
                </div>
              )}
              <div className="info-row">
                <span>Created by</span>
                <strong className="mono">{redactText(proposal.created_by)}</strong>
              </div>
            </section>

            <section className="card rsi-risk-note" aria-labelledby="rsi-risk-note-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Risk class {proposal.risk}</span>
                  <h3 id="rsi-risk-note-heading">Approval requirement</h3>
                </div>
              </div>
              <strong>{RISK_LADDER[proposal.risk].requirement}</strong>
              <p className="rsi-hint">{RISK_LADDER[proposal.risk].detail}</p>
            </section>
          </aside>
        </div>
      )}

      {proposal && approvalDialogOpen && (
        <ApprovalDialog
          busy={busy === "approve"}
          error={actionError}
          onCancel={() => setApprovalDialogOpen(false)}
          onSubmit={async (note) => {
            const saved = await runAction("approve", () =>
              client.approveRsiProposal(workspaceId, proposal.proposal_id, note),
            );
            if (saved) setApprovalDialogOpen(false);
          }}
        />
      )}
      {proposal && rollbackDialogOpen && (
        <RollbackDialog
          busy={busy === "rollback"}
          error={actionError}
          onCancel={() => setRollbackDialogOpen(false)}
          onSubmit={async (reason) => {
            const saved = await runAction("rollback", () =>
              client.rollbackRsiProposal(workspaceId, proposal.proposal_id, reason),
            );
            if (saved) setRollbackDialogOpen(false);
          }}
        />
      )}
    </section>
  );
}

function rolloutTone(status: RsiRollout["status"]): string {
  if (status === "promoted") return "done";
  if (status === "rolled_back") return "muted";
  return "active";
}

function RolloutStages({ rollout }: { rollout: RsiRollout }): ReactElement {
  return (
    <div
      className="rsi-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={rollout.stage}
      aria-label={`Canary at ${stageLabel(rollout.stage)}`}
    >
      {[10, 50, 100].map((stage) => (
        <span
          key={stage}
          className={`rsi-progress-step ${rollout.stage >= stage ? "rsi-progress-done" : ""} ${
            rollout.stage === stage ? "rsi-progress-current" : ""
          }`}
        >
          {stage === 100 ? "100% · promote" : `${stage}%`}
        </span>
      ))}
    </div>
  );
}

function EvaluationCard({ evaluation }: { evaluation: RsiEvaluation }): ReactElement {
  return (
    <article className="rsi-eval" aria-labelledby={`eval-${evaluation.evaluation_id}`}>
      <div className="rsi-eval-heading">
        <div>
          <span className="eyebrow">Golden set</span>
          <h4 id={`eval-${evaluation.evaluation_id}`}>Golden-set replay</h4>
        </div>
        <span className={`rsi-verdict rsi-tone-${verdictTone(evaluation.verdict)}`}>
          {verdictLabel(evaluation.verdict)}
        </span>
      </div>
      <div className="rsi-eval-grid">
        <div>
          <span className="metric-label">Sample</span>
          <strong className="mono">
            baseline {evaluation.baseline_sample_size} · candidate{" "}
            {evaluation.candidate_sample_size}
          </strong>
        </div>
        <div>
          <span className="metric-label">Success</span>
          <strong className="mono">
            {formatRate(evaluation.baseline_successes, evaluation.baseline_sample_size)} →{" "}
            {formatRate(evaluation.candidate_successes, evaluation.candidate_sample_size)}
          </strong>
        </div>
        <div>
          <span className="metric-label">Δ success · 95% CI</span>
          <strong className="mono">
            {formatSignedPercent(evaluation.success_delta)} ·{" "}
            {formatInterval(evaluation.delta_ci_low, evaluation.delta_ci_high)}
          </strong>
        </div>
        <div>
          <span className="metric-label">Rework</span>
          <strong className="mono">
            {evaluation.baseline_rework} → {evaluation.candidate_rework}
          </strong>
        </div>
        <div>
          <span className="metric-label">Context cost</span>
          <strong className="mono">
            {formatCost(evaluation.baseline_cost)} → {formatCost(evaluation.candidate_cost)}
          </strong>
        </div>
        <div>
          <span className="metric-label">Security events</span>
          <strong className={evaluation.safety_events > 0 ? "rsi-danger-text" : undefined}>
            {evaluation.safety_events}
          </strong>
        </div>
      </div>
      <div className="rsi-eval-trace">
        <span>
          Verifier {evaluation.verifier.kind} ·{" "}
          <span className="mono">{redactText(evaluation.verifier.id)}</span> ·{" "}
          <span className="mono">{redactText(evaluation.verifier.reference)}</span>
        </span>
        <span>
          Policy v{evaluation.policy_version} ·{" "}
          <span className="mono">{shortId(evaluation.policy_hash, 16)}</span> · memory{" "}
          <span className="mono">{shortId(evaluation.memory_version, 18)}</span>
        </span>
        <span>
          Reflection tokens {evaluation.reflection_tokens.toLocaleString()} ·{" "}
          {formatDate(evaluation.created_at)} · created by{" "}
          <span className="mono">{redactText(evaluation.created_by)}</span>
        </span>
      </div>
    </article>
  );
}

/**
 * The hidden holdout contributes an aggregate sample counter only. Its
 * per-arm outcomes, verdict, interval, cost, verifier, and version trace are
 * deliberately not rendered: the learning loop cannot read its cases, and this
 * administration view must not reconstruct them from evaluation rows.
 */
function HoldoutEvaluationCard({ evaluation }: { evaluation: RsiEvaluation }): ReactElement {
  return (
    <article className="rsi-eval rsi-eval-holdout" aria-label="Holdout evaluation aggregate">
      <div className="rsi-eval-heading">
        <div>
          <span className="eyebrow">Hidden holdout · aggregate only</span>
          <h4>Holdout evaluation</h4>
        </div>
      </div>
      <div className="rsi-eval-grid">
        <div>
          <span className="metric-label">Holdout used</span>
          <strong>{evaluation.holdout_used ? "Yes" : "No"}</strong>
        </div>
        <div>
          <span className="metric-label">Sample</span>
          <strong className="mono">{evaluation.sample_size}</strong>
        </div>
      </div>
      <p className="rsi-hint">{HOLDOUT_NOTE}</p>
    </article>
  );
}

function ApprovalRow({ approval }: { approval: RsiApproval }): ReactElement {
  return (
    <li>
      <div className="rsi-approval-heading">
        <span className="rsi-chip">{APPROVAL_KEY_LABELS[approval.approval_key]}</span>
        <strong className="mono">{redactText(approval.approver_id)}</strong>
        <span>{approval.role}</span>
        <span>{formatDate(approval.created_at)}</span>
      </div>
      {approval.note && <p>{redactText(approval.note)}</p>}
    </li>
  );
}

function ObservationRow({ observation }: { observation: RsiCanaryObservation }): ReactElement {
  return (
    <li>
      <div className="rsi-approval-heading">
        <span className={`rsi-verdict rsi-tone-${verdictTone(observation.verdict)}`}>
          {verdictLabel(observation.verdict)}
        </span>
        <strong>{stageLabel(observation.stage)}</strong>
        <span className="mono">
          {formatRate(observation.baseline_successes, observation.baseline_sample_size)} →{" "}
          {formatRate(observation.candidate_successes, observation.candidate_sample_size)}
        </span>
        <span>{formatDate(observation.created_at)}</span>
      </div>
      <div className="rsi-observation-meta">
        <span>
          Δ {formatSignedPercent(observation.success_delta)} · CI{" "}
          {formatInterval(observation.delta_ci_low, observation.delta_ci_high)}
        </span>
        <span>
          Rework {observation.baseline_rework} → {observation.candidate_rework} · cost{" "}
          {formatCost(observation.baseline_cost)} → {formatCost(observation.candidate_cost)}
        </span>
        <span className={observation.safety_events > 0 ? "rsi-danger-text" : undefined}>
          Security events {observation.safety_events}
        </span>
        <span className="mono">{redactText(observation.evidence_reference)}</span>
      </div>
    </li>
  );
}

function ApprovalDialog({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | undefined;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}): ReactElement {
  const [note, setNote] = useState("");
  return (
    <RsiActionDialog
      title="Record a named approval"
      description="The approval binds to this proposal version and is attributed to your authenticated identity. The proposer cannot approve its own proposal."
      confirmLabel="Record approval"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={() => onSubmit(note)}
    >
      <label className="field-block">
        <span className="field-label">Note (optional)</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={1000}
          disabled={busy}
        />
      </label>
    </RsiActionDialog>
  );
}

function RollbackDialog({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | undefined;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  return (
    <RsiActionDialog
      title="Roll back this proposal"
      description="A canary is stopped. A promoted retrieval change reverts by publishing the baseline policy as a new immutable version, and a promoted memory item is deprecated. Historical run pins are not rewritten."
      confirmLabel="Roll back"
      busy={busy}
      error={error}
      invalid={reason.trim().length === 0}
      onCancel={onCancel}
      onSubmit={() => onSubmit(reason)}
    >
      <label className="field-block">
        <span className="label-text">
          Reason<span className="required-dot">*</span>
        </span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={1000}
          required
          disabled={busy}
        />
      </label>
    </RsiActionDialog>
  );
}

function RsiActionDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  invalid = false,
  onCancel,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  error: string | undefined;
  invalid?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  children?: ReactElement;
}): ReactElement {
  const [cancelRef, setCancelRef] = useState<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef?.focus();
  }, [cancelRef]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (invalid || busy) return;
    onSubmit();
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        className="modal rsi-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rsi-action-title"
        aria-describedby="rsi-action-description"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id="rsi-action-title">{title}</h2>
        <p id="rsi-action-description">{description}</p>
        {children}
        {error && (
          <div className="inline-error" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="modal-actions">
          <button
            ref={setCancelRef}
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={invalid || busy}>
            {busy ? "Applying…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
