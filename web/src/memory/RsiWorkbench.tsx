import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  ForgePilotClient,
  RsiControlsPatch,
  RsiProposal,
  RsiProposalStatus,
  RsiRisk,
  RsiStatus,
  Workspace,
} from "../api/client";
import { formatDate, progressPercent, shortId } from "../ui/format";
import { redactText } from "../ui/redaction";
import { Select } from "../ui/Select";
import {
  describeRsiError,
  HOLDOUT_NOTE,
  RISK_LADDER,
  RISK_ORDER,
  rsiRiskLabel,
  RSI_STATUS_LABELS,
  RSI_STATUS_ORDER,
  rsiStatusLabel,
  rsiStatusTone,
  rsiTargetLabel,
  verdictTone,
} from "./rsi-format";
import type { RsiError } from "./rsi-format";
import { RsiProposalDetail } from "./RsiProposalDetail";

type StatusFilter = "all" | RsiProposalStatus;
type RiskFilter = "all" | RsiRisk;

export function RsiWorkbench({
  client,
  currentUserId,
}: {
  client: ForgePilotClient;
  currentUserId?: string;
}): ReactElement {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [workspaceError, setWorkspaceError] = useState<RsiError | undefined>(undefined);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceToken, setWorkspaceToken] = useState(0);

  const [status, setStatus] = useState<RsiStatus | undefined>(undefined);
  const [proposals, setProposals] = useState<RsiProposal[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<RsiError | undefined>(undefined);
  const [dataToken, setDataToken] = useState(0);
  const requestRef = useRef(0);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [selectedProposalId, setSelectedProposalId] = useState<string | undefined>(undefined);
  const [seedProposal, setSeedProposal] = useState<RsiProposal | undefined>(undefined);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setWorkspaceLoading(true);
    client
      .listWorkspaces()
      .then((items) => {
        if (!active) return;
        setWorkspaces(items);
        setWorkspaceError(undefined);
        const activeItems = items.filter((workspace) => workspace.status === "active");
        setWorkspaceId((current) => {
          if (current && activeItems.some((workspace) => workspace.id === current)) return current;
          return activeItems[0]?.id;
        });
      })
      .catch((caught: unknown) => {
        if (active) setWorkspaceError(describeRsiError(caught));
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceToken]);

  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === "active");
  const selectedWorkspace = activeWorkspaces.find((workspace) => workspace.id === workspaceId);
  const role = selectedWorkspace?.role;
  // The read routes require the member role, so a viewer is refused by the
  // service before any list is returned. Do not issue a request that is known
  // to be denied; explain the role instead.
  const canRead = role === "member" || role === "admin" || role === "owner";
  const canOperate = role === "owner";

  useEffect(() => {
    if (!workspaceId || !canRead) {
      setStatus(undefined);
      setProposals([]);
      setDataError(undefined);
      return;
    }
    let active = true;
    const requestId = ++requestRef.current;
    setDataLoading(true);
    void Promise.all([
      client.getRsiStatus(workspaceId),
      client.listRsiProposals(workspaceId, {
        ...(statusFilter === "all" ? {} : { status: statusFilter }),
        ...(riskFilter === "all" ? {} : { risk: riskFilter }),
      }),
    ])
      .then(([nextStatus, nextProposals]) => {
        if (!active || requestId !== requestRef.current) return;
        setStatus(nextStatus);
        setProposals(nextProposals);
        setDataError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || requestId !== requestRef.current) return;
        setDataError(describeRsiError(caught));
      })
      .finally(() => {
        if (active && requestId === requestRef.current) setDataLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, canRead, statusFilter, riskFilter, dataToken]);

  const refreshAll = useCallback((): void => {
    setDataToken((value) => value + 1);
  }, []);

  function selectProposal(proposal: RsiProposal): void {
    setSelectedProposalId(proposal.proposal_id);
    setSeedProposal(proposal);
    setMobileView("detail");
  }

  function backToList(): void {
    setSelectedProposalId(undefined);
    setSeedProposal(undefined);
    setMobileView("list");
  }

  async function saveKillSwitch(enabled: boolean, reason: string): Promise<boolean> {
    if (!workspaceId) return false;
    setControlBusy(true);
    setControlError(undefined);
    try {
      const controls = await client.setRsiKillSwitch(workspaceId, enabled, reason);
      setStatus((current) => (current ? { ...current, controls } : current));
      refreshAll();
      return true;
    } catch (caught) {
      setControlError(`${describeRsiError(caught).code}: ${describeRsiError(caught).message}`);
      return false;
    } finally {
      setControlBusy(false);
    }
  }

  async function saveControls(patch: RsiControlsPatch): Promise<boolean> {
    if (!workspaceId) return false;
    setControlBusy(true);
    setControlError(undefined);
    try {
      const controls = await client.updateRsiControls(workspaceId, patch);
      setStatus((current) => (current ? { ...current, controls } : current));
      refreshAll();
      return true;
    } catch (caught) {
      const described = describeRsiError(caught);
      setControlError(`${described.code}: ${described.message}`);
      return false;
    } finally {
      setControlBusy(false);
    }
  }

  const workspaceUnavailable =
    workspaceError !== undefined && (workspaceError.missing || workspaceError.code === "NOT_FOUND");

  return (
    <div className="workspace rsi-workspace" data-view={mobileView}>
      <aside className="sidebar rsi-sidebar">
        <div className="sidebar-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>RSI</h1>
          </div>
          <span className="task-count">{proposals.length}</span>
        </div>

        {activeWorkspaces.length > 1 && (
          <div className="workspace-picker" role="group" aria-label="Workspace scope">
            <label className="field-label" htmlFor="rsi-workspace">
              Workspace scope
            </label>
            <Select
              id="rsi-workspace"
              value={workspaceId ?? ""}
              onChange={(value) => {
                setWorkspaceId(value);
                setStatusFilter("all");
                setRiskFilter("all");
                backToList();
              }}
              options={activeWorkspaces.map((workspace) => ({
                value: workspace.id,
                label: `${workspace.name} · ${workspace.role}`,
              }))}
            />
          </div>
        )}

        {selectedWorkspace && (
          <div className="workspace-role">
            <span className="mono">{redactText(selectedWorkspace.name)}</span>
            <span className={`role-chip role-${selectedWorkspace.role}`}>
              {selectedWorkspace.role}
              {selectedWorkspace.role === "viewer" ? " · read-only" : ""}
            </span>
          </div>
        )}

        {status && (
          <div className="rsi-sidebar-state">
            <span
              className={`rsi-chip rsi-chip-${status.controls.kill_switch ? "danger" : "done"}`}
            >
              {status.controls.kill_switch ? "Kill switch engaged" : "Kill switch off"}
            </span>
            <span className="rsi-chip">Changes left {status.budget.changes_remaining}</span>
            <span className="rsi-chip">Holdout {status.holdout.cases}</span>
          </div>
        )}

        <div className="rsi-filter-stack" role="group" aria-label="Proposal filters">
          <div className="workspace-picker">
            <label className="field-label" htmlFor="rsi-status-filter">
              Proposal status
            </label>
            <Select
              id="rsi-status-filter"
              value={statusFilter}
              onChange={(value) => {
                setStatusFilter(value as StatusFilter);
                backToList();
              }}
              options={[
                { value: "all", label: "All statuses" },
                ...RSI_STATUS_ORDER.map((entry) => ({
                  value: entry,
                  label: RSI_STATUS_LABELS[entry],
                })),
              ]}
            />
          </div>
          <div className="workspace-picker">
            <label className="field-label" htmlFor="rsi-risk-filter">
              Risk class
            </label>
            <Select
              id="rsi-risk-filter"
              value={riskFilter}
              onChange={(value) => {
                setRiskFilter(value as RiskFilter);
                backToList();
              }}
              options={[
                { value: "all", label: "All risk classes" },
                ...RISK_ORDER.map((entry) => ({ value: entry, label: rsiRiskLabel(entry) })),
              ]}
            />
          </div>
        </div>

        <div className="task-list" data-scroll="normal">
          {workspaceLoading ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>Resolving workspace scope…</p>
            </div>
          ) : workspaceUnavailable ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>
                No RSI workspace is available to this credential. The surface is workspace-scoped
                and needs an active membership.
              </p>
            </div>
          ) : workspaceError ? (
            <div className="empty-sidebar">
              <div className="empty-icon">!</div>
              <p>
                {workspaceError.code}: {workspaceError.message}
              </p>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setWorkspaceToken((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : !workspaceId ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>No active workspace is visible to this credential.</p>
            </div>
          ) : !canRead ? (
            <div className="empty-sidebar">
              <div className="empty-icon">◈</div>
              <p>
                RSI requires the member role. A viewer can see the workspace but not its proposals,
                evaluations, budget, or holdout counter.
              </p>
            </div>
          ) : dataError ? (
            <div className="empty-sidebar">
              <div className="empty-icon">!</div>
              <p>
                {dataError.code}: {dataError.message}
              </p>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={refreshAll}
              >
                Retry
              </button>
            </div>
          ) : proposals.length === 0 ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>{dataLoading ? "Reading proposals…" : "No proposal matches these filters."}</p>
            </div>
          ) : (
            proposals.map((proposal) => (
              <RsiProposalListItem
                key={proposal.proposal_id}
                proposal={proposal}
                selected={proposal.proposal_id === selectedProposalId}
                onClick={() => selectProposal(proposal)}
              />
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <div className="security-note">
            <span className="security-icon" aria-hidden="true">
              ◈
            </span>
            <div>
              <strong>Server-computed gate</strong>
              <span>Holdout content is never exposed; only aggregate counts</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        {selectedProposalId && workspaceId && role ? (
          <RsiProposalDetail
            key={selectedProposalId}
            client={client}
            workspaceId={workspaceId}
            proposalId={selectedProposalId}
            seed={seedProposal}
            role={role}
            currentUserId={currentUserId}
            status={status}
            onBack={backToList}
            onChanged={refreshAll}
          />
        ) : (
          <RsiOverview
            workspaceRole={role}
            canRead={canRead}
            canOperate={canOperate}
            status={status}
            loading={dataLoading}
            error={dataError}
            controlBusy={controlBusy}
            controlError={controlError}
            onDismissControlError={() => setControlError(undefined)}
            onKillSwitch={saveKillSwitch}
            onSaveControls={saveControls}
            onOpenProposal={(proposalId) => {
              const proposal = proposals.find((entry) => entry.proposal_id === proposalId);
              if (proposal) selectProposal(proposal);
            }}
            onRetry={refreshAll}
          />
        )}
      </main>
    </div>
  );
}

function RsiProposalListItem({
  proposal,
  selected,
  onClick,
}: {
  proposal: RsiProposal;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <article
      className={`task-list-item rsi-list-item ${selected ? "task-list-item-selected" : ""}`}
    >
      <button type="button" className="task-list-open" onClick={onClick}>
        <div className="task-list-item-topline">
          <span className={`rsi-status-pill rsi-tone-${rsiStatusTone(proposal.status)}`}>
            {rsiStatusLabel(proposal.status)}
          </span>
          <span className={`rsi-risk-badge rsi-risk-${proposal.risk}`}>Class {proposal.risk}</span>
          <span className="task-list-time">{formatDate(proposal.created_at)}</span>
        </div>
        <div className="task-list-summary">{redactText(proposal.title)}</div>
        <div className="rsi-list-meta">
          <span>{rsiTargetLabel(proposal.target)}</span>
          <span
            className={`rsi-verdict-inline rsi-tone-${verdictTone(proposal.gate.offline_evaluation)}`}
          >
            {proposal.gate.offline_evaluation === "missing"
              ? "No replay"
              : `Replay ${proposal.gate.offline_evaluation}`}
          </span>
        </div>
      </button>
    </article>
  );
}

function RsiOverview({
  workspaceRole,
  canRead,
  canOperate,
  status,
  loading,
  error,
  controlBusy,
  controlError,
  onDismissControlError,
  onKillSwitch,
  onSaveControls,
  onOpenProposal,
  onRetry,
}: {
  workspaceRole: Workspace["role"] | undefined;
  canRead: boolean;
  canOperate: boolean;
  status: RsiStatus | undefined;
  loading: boolean;
  error: RsiError | undefined;
  controlBusy: boolean;
  controlError: string | undefined;
  onDismissControlError: () => void;
  onKillSwitch: (enabled: boolean, reason: string) => Promise<boolean>;
  onSaveControls: (patch: RsiControlsPatch) => Promise<boolean>;
  onOpenProposal: (proposalId: string) => void;
  onRetry: () => void;
}): ReactElement {
  return (
    <section className="detail-view rsi-overview" aria-labelledby="rsi-overview-title">
      <div className="detail-header">
        <div className="detail-heading">
          <div className="breadcrumb">WORKSPACE / RSI</div>
          <h2 id="rsi-overview-title">Bounded self-improvement</h2>
          <p className="rsi-lede">
            Review the evidence behind each proposal, the gate the server computed, and the
            workspace controls that bound the loop.
          </p>
        </div>
        {workspaceRole && (
          <span className={`role-chip role-${workspaceRole}`}>{workspaceRole}</span>
        )}
      </div>

      {!canRead ? (
        <div className="card card-empty rsi-role-gate">
          <span className="eyebrow">Role gate</span>
          <h3>RSI requires the member role</h3>
          <p>
            A viewer can see the workspace but not its proposals, evaluations, holdout counter, or
            budget. Ask a workspace owner or admin for membership before using this surface.
          </p>
        </div>
      ) : error ? (
        <div className="card card-empty">
          <span className="eyebrow">Request failed</span>
          <h3>
            {error.code}: {error.message}
          </h3>
          {error.forbidden && <p>The service refused this read for the current workspace role.</p>}
          <button type="button" className="button button-secondary button-small" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : !status ? (
        <div className="card card-empty">
          {loading ? "Reading RSI controls…" : "No RSI status is available."}
        </div>
      ) : (
        <div className="detail-grid">
          <div className="detail-main-column">
            <RsiControlCard
              status={status}
              canOperate={canOperate}
              busy={controlBusy}
              error={controlError}
              onDismissError={onDismissControlError}
              onKillSwitch={onKillSwitch}
              onSaveControls={onSaveControls}
            />
            <RsiActiveRolloutCard rollout={status.active_rollout} onOpenProposal={onOpenProposal} />
            <RsiRiskLadderCard />
          </div>
          <aside className="detail-side-column">
            <RsiBudgetCard status={status} />
            <RsiHoldoutCard
              cases={status.holdout.cases}
              lastEvaluatedAt={status.holdout.last_evaluated_at}
            />
            <RsiLifecycleCard counts={status.proposals} />
          </aside>
        </div>
      )}
    </section>
  );
}

function RsiControlCard({
  status,
  canOperate,
  busy,
  error,
  onDismissError,
  onKillSwitch,
  onSaveControls,
}: {
  status: RsiStatus;
  canOperate: boolean;
  busy: boolean;
  error: string | undefined;
  onDismissError: () => void;
  onKillSwitch: (enabled: boolean, reason: string) => Promise<boolean>;
  onSaveControls: (patch: RsiControlsPatch) => Promise<boolean>;
}): ReactElement {
  const controls = status.controls;
  const [changeBudget, setChangeBudget] = useState(String(controls.weekly_change_budget));
  const [tokenBudget, setTokenBudget] = useState(String(controls.weekly_reflection_token_budget));
  const [autoPromote, setAutoPromote] = useState(controls.auto_promote_low_risk);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [killSwitchOpen, setKillSwitchOpen] = useState(false);

  useEffect(() => {
    setChangeBudget(String(controls.weekly_change_budget));
    setTokenBudget(String(controls.weekly_reflection_token_budget));
    setAutoPromote(controls.auto_promote_low_risk);
  }, [
    controls.weekly_change_budget,
    controls.weekly_reflection_token_budget,
    controls.auto_promote_low_risk,
  ]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(undefined);
    const nextChange = Number(changeBudget);
    const nextTokens = Number(tokenBudget);
    if (
      !Number.isInteger(nextChange) ||
      nextChange < 0 ||
      !Number.isInteger(nextTokens) ||
      nextTokens < 0
    ) {
      setFormError("Budgets must be whole numbers, zero or greater.");
      return;
    }
    if (
      nextChange > controls.weekly_change_budget ||
      nextTokens > controls.weekly_reflection_token_budget
    ) {
      setFormError(
        "This surface may only tighten the workspace budget. Fixed sample sizes and regression ceilings are code constants and cannot be raised.",
      );
      return;
    }
    const saved = await onSaveControls({
      auto_promote_low_risk: autoPromote,
      weekly_change_budget: nextChange,
      weekly_reflection_token_budget: nextTokens,
    });
    if (saved) setFormError(undefined);
  }

  return (
    <section className="card rsi-control-card" aria-labelledby="rsi-control-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Workspace controls</span>
          <h3 id="rsi-control-heading">Kill switch &amp; budgets</h3>
        </div>
        <span className={`rsi-chip rsi-chip-${controls.kill_switch ? "danger" : "done"}`}>
          {controls.kill_switch ? "RSI stopped" : "RSI available"}
        </span>
      </div>

      {controls.kill_switch && (
        <div className="rsi-alert rsi-alert-danger" role="alert">
          <span className="reason-icon">!</span>
          <div>
            <strong>Workspace kill switch engaged</strong>
            <p>
              {controls.kill_switch_reason
                ? redactText(controls.kill_switch_reason)
                : "No reason was recorded."}
            </p>
            <span className="rsi-alert-meta">
              {controls.kill_switch_changed_at
                ? `Changed ${formatDate(controls.kill_switch_changed_at)}`
                : "Change time not recorded"}
              {controls.kill_switch_changed_by
                ? ` · ${shortId(controls.kill_switch_changed_by, 18)}`
                : ""}
            </span>
            <p>
              New runs resolve to the baseline policy. Proposals, evaluations, approvals, and
              canaries are refused until it is released.
            </p>
          </div>
        </div>
      )}

      <form className="rsi-control-form" onSubmit={(event) => void submit(event)}>
        <div className="rsi-control-row">
          <div>
            <span className="field-label">Automatic promotion · class A</span>
            <strong>{autoPromote ? "Enabled" : "Disabled"}</strong>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoPromote}
            aria-label="Automatic promotion for class A proposals"
            className={`rsi-switch ${autoPromote ? "rsi-switch-on" : ""}`}
            disabled={!canOperate || busy}
            onClick={() => setAutoPromote((current) => !current)}
          >
            <span />
          </button>
        </div>
        <div className="rsi-budget-fields">
          <label className="field-block" htmlFor="rsi-change-budget">
            <span className="label-text">Weekly change budget</span>
            <input
              id="rsi-change-budget"
              type="number"
              min={0}
              step={1}
              value={changeBudget}
              disabled={!canOperate || busy}
              onChange={(event) => setChangeBudget(event.target.value)}
            />
          </label>
          <label className="field-block" htmlFor="rsi-token-budget">
            <span className="label-text">Weekly reflection-token budget</span>
            <input
              id="rsi-token-budget"
              type="number"
              min={0}
              step={1}
              value={tokenBudget}
              disabled={!canOperate || busy}
              onChange={(event) => setTokenBudget(event.target.value)}
            />
          </label>
        </div>
        {(formError ?? error) && (
          <div className="inline-error" role="alert">
            <span>{formError ?? error}</span>
            {!formError && onDismissError && (
              <button type="button" aria-label="Dismiss controls error" onClick={onDismissError}>
                ×
              </button>
            )}
          </div>
        )}
        <div className="rsi-control-actions">
          <button
            type="submit"
            className="button button-primary button-small"
            disabled={!canOperate || busy}
          >
            {busy ? "Saving…" : "Save controls"}
          </button>
          <button
            type="button"
            className={`button button-small ${
              controls.kill_switch ? "button-secondary" : "button-danger"
            }`}
            disabled={!canOperate || busy}
            onClick={() => setKillSwitchOpen(true)}
          >
            {controls.kill_switch ? "Release kill switch" : "Engage kill switch"}
          </button>
        </div>
        {!canOperate && (
          <p className="stage-terminal-note" role="status">
            Owner role required to change RSI controls.
          </p>
        )}
      </form>

      {killSwitchOpen && (
        <KillSwitchDialog
          enabling={!controls.kill_switch}
          busy={busy}
          error={error}
          onCancel={() => setKillSwitchOpen(false)}
          onSubmit={async (reason) => {
            const saved = await onKillSwitch(!controls.kill_switch, reason);
            if (saved) setKillSwitchOpen(false);
          }}
        />
      )}
    </section>
  );
}

function KillSwitchDialog({
  enabling,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  enabling: boolean;
  busy: boolean;
  error: string | undefined;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const invalid = enabling && reason.trim().length === 0;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

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
        aria-labelledby="rsi-kill-switch-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (invalid || busy) return;
          onSubmit(reason);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id="rsi-kill-switch-title">
          {enabling ? "Engage the workspace kill switch" : "Release the workspace kill switch"}
        </h2>
        <p>
          {enabling
            ? "Every active canary is rolled back in the same call. New runs resolve to the baseline policy, and proposals, evaluations, approvals, and canaries are refused until release."
            : "Releasing does not resume a rolled-back canary. New runs may resolve to a canary only after a new proposal passes its gate and starts a rollout."}
        </p>
        <label className="field-block">
          <span className="label-text">
            Reason{enabling ? " (required)" : " (optional)"}
            {enabling ? <span className="required-dot">*</span> : null}
          </span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={1000}
            required={enabling}
            disabled={busy}
          />
        </label>
        {error && (
          <div className="inline-error" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={enabling ? "button button-danger" : "button button-primary"}
            disabled={invalid || busy}
          >
            {busy ? "Applying…" : enabling ? "Engage kill switch" : "Release kill switch"}
          </button>
        </div>
      </form>
    </div>
  );
}

function RsiActiveRolloutCard({
  rollout,
  onOpenProposal,
}: {
  rollout: RsiStatus["active_rollout"];
  onOpenProposal: (proposalId: string) => void;
}): ReactElement {
  return (
    <section className="card rsi-rollout-summary" aria-labelledby="rsi-active-rollout-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Active rollout</span>
          <h3 id="rsi-active-rollout-heading">Canary</h3>
        </div>
        {rollout && <span className="rsi-status-pill rsi-tone-active">{rollout.stage}%</span>}
      </div>
      {!rollout ? (
        <div className="card-empty compact">
          No canary is active. Rollouts are serialized per workspace: one proposal receives the
          unpublished candidate policy until it promotes or rolls back.
        </div>
      ) : (
        <>
          <div className="rsi-progress" aria-label={`Canary stage ${rollout.stage}%`}>
            {[10, 50, 100].map((stage) => (
              <span
                key={stage}
                className={`rsi-progress-step ${rollout.stage >= stage ? "rsi-progress-done" : ""}`}
              >
                {stage}%
              </span>
            ))}
          </div>
          <div className="rsi-fact-grid">
            <div>
              <span className="metric-label">Status</span>
              <strong>{rollout.status}</strong>
            </div>
            <div>
              <span className="metric-label">Baseline policy</span>
              <strong className="mono">v{rollout.baseline_policy_version}</strong>
            </div>
            <div>
              <span className="metric-label">Candidate hash</span>
              <strong className="mono">{shortId(rollout.candidate_hash, 18)}</strong>
            </div>
            <div>
              <span className="metric-label">Started</span>
              <strong>{formatDate(rollout.started_at)}</strong>
            </div>
          </div>
          {rollout.reason && (
            <div className="rsi-alert rsi-alert-attention" role="status">
              <span className="reason-icon">!</span>
              <div>
                <strong>Rollout reason</strong>
                <p>{redactText(rollout.reason)}</p>
              </div>
            </div>
          )}
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => onOpenProposal(rollout.proposal_id)}
          >
            Open proposal
          </button>
        </>
      )}
    </section>
  );
}

function RsiBudgetCard({ status }: { status: RsiStatus }): ReactElement {
  const changesPercent = progressPercent(
    status.budget.changes_promoted,
    status.budget.weekly_change_budget,
  );
  const tokensPercent = progressPercent(
    status.budget.reflection_tokens_used,
    status.budget.weekly_reflection_token_budget,
  );
  return (
    <section className="card rsi-budget-card" aria-labelledby="rsi-budget-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">This week</span>
          <h3 id="rsi-budget-heading">Budget</h3>
        </div>
        <span className="event-count">from {status.budget.week_start}</span>
      </div>
      <div className="rsi-budget-meter">
        <div>
          <span className="field-label">Changes promoted</span>
          <strong>
            {status.budget.changes_promoted} / {status.budget.weekly_change_budget} ·{" "}
            {status.budget.changes_remaining} remaining
          </strong>
        </div>
        <div
          className="rsi-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={status.budget.weekly_change_budget}
          aria-valuenow={status.budget.changes_promoted}
          aria-label="Weekly change budget used"
        >
          <span style={{ width: `${changesPercent ?? 0}%` }} />
        </div>
      </div>
      <div className="rsi-budget-meter">
        <div>
          <span className="field-label">Reflection tokens</span>
          <strong>
            {status.budget.reflection_tokens_used.toLocaleString()} /{" "}
            {status.budget.weekly_reflection_token_budget.toLocaleString()} ·{" "}
            {status.budget.reflection_tokens_remaining.toLocaleString()} remaining
          </strong>
        </div>
        <div
          className="rsi-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={status.budget.weekly_reflection_token_budget}
          aria-valuenow={status.budget.reflection_tokens_used}
          aria-label="Weekly reflection-token budget used"
        >
          <span style={{ width: `${tokensPercent ?? 0}%` }} />
        </div>
      </div>
      <p className="rsi-hint">
        A replay blocks before it records anything once the weekly reflection-token budget is
        exhausted. Promotions beyond the change budget are refused.
      </p>
    </section>
  );
}

function RsiHoldoutCard({
  cases,
  lastEvaluatedAt,
}: {
  cases: number;
  lastEvaluatedAt: string | null;
}): ReactElement {
  return (
    <section className="card rsi-holdout-card" aria-labelledby="rsi-holdout-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Hidden holdout</span>
          <h3 id="rsi-holdout-heading">Aggregate only</h3>
        </div>
        <span className="rsi-chip">Content withheld</span>
      </div>
      <div className="info-row">
        <span>Cases</span>
        <strong className="mono">{cases}</strong>
      </div>
      <div className="info-row">
        <span>Last evaluated</span>
        <strong>{lastEvaluatedAt ? formatDate(lastEvaluatedAt) : "Never"}</strong>
      </div>
      <p className="rsi-hint">{HOLDOUT_NOTE}</p>
    </section>
  );
}

function RsiLifecycleCard({ counts }: { counts: RsiStatus["proposals"] }): ReactElement {
  return (
    <section className="card rsi-lifecycle-card" aria-labelledby="rsi-lifecycle-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Proposal count</span>
          <h3 id="rsi-lifecycle-heading">Lifecycle</h3>
        </div>
      </div>
      <ul className="rsi-count-list">
        {RSI_STATUS_ORDER.map((entry) => (
          <li key={entry}>
            <span className={`rsi-status-pill rsi-tone-${rsiStatusTone(entry)}`}>
              {RSI_STATUS_LABELS[entry]}
            </span>
            <strong className="mono">{counts[entry]}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RsiRiskLadderCard(): ReactElement {
  return (
    <section className="card rsi-ladder-card" aria-labelledby="rsi-ladder-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Risk ladder</span>
          <h3 id="rsi-ladder-heading">Target → approval gate</h3>
        </div>
      </div>
      <ol className="rsi-ladder">
        {RISK_ORDER.map((risk) => (
          <li key={risk} className={`rsi-ladder-step rsi-ladder-${risk}`}>
            <span className={`rsi-risk-badge rsi-risk-${risk}`}>Class {risk}</span>
            <div>
              <strong>{RISK_LADDER[risk].requirement}</strong>
              <p>{RISK_LADDER[risk].detail}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="rsi-hint">
        Risk is derived from the proposal target; a proposer cannot choose it. The proposal's gate
        below repeats the server's required and satisfied approval keys.
      </p>
    </section>
  );
}
