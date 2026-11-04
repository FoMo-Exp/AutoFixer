import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  Approval,
  Candidate,
  Delivery,
  ForgePilotClient,
  Issue,
  IssueRun,
  IssueStage,
  IssueStageTransition,
  IssueTask,
  IssueTaskState,
  ProductState,
} from "../api/client";
import { ChangeReviewCard } from "./ChangeReview";
import { DeliveryStatusCard } from "./DeliveryStatus";
import { describeIssueError, errorLabel } from "./errors";
import type { IssueError } from "./errors";
import { useIssueStream } from "../api/issue-hooks";
import type { IssueStreamConnection, IssueStreamState } from "../api/issue-hooks";
import { CreateIdempotencyKeys } from "../api/idempotency";
import { formatDate, shortId } from "../ui/format";
import {
  HARNESS_STATE_NOTE,
  harnessStateLabel,
  harnessStateTone,
  isKnownProductState,
  isTerminalProductState,
  isTerminalTaskState,
  issueEventLabel,
  issueEventSummary,
  issueTaskStateLabel,
  productStageTone,
  productStateDescription,
  productStateLabel,
  runRequiresDisposition,
  stageChangeNeedsDisposition,
  stageChangeNeedsReason,
} from "../ui/issues";
import { redactText } from "../ui/redaction";

export interface IssueDetailProps {
  client: ForgePilotClient;
  workspaceId: string;
  issueId: string;
  seed: Issue | undefined;
  currentUserId?: string;
  canMutate: boolean;
  onBack: () => void;
  onChanged: () => void;
}

export function IssueDetail({
  client,
  workspaceId,
  issueId,
  seed,
  currentUserId,
  canMutate,
  onBack,
  onChanged,
}: IssueDetailProps): ReactElement {
  const [issue, setIssue] = useState<Issue | undefined>(seed);
  const [stage, setStage] = useState<IssueStage | undefined>(undefined);
  const [tasks, setTasks] = useState<IssueTask[]>([]);
  const [runs, setRuns] = useState<IssueRun[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewError, setReviewError] = useState<IssueError | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(seed === undefined);
  const [loadError, setLoadError] = useState<IssueError | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [taskBusy, setTaskBusy] = useState<string | undefined>(undefined);
  const [pendingTransition, setPendingTransition] = useState<ProductState | undefined>(undefined);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [transitionError, setTransitionError] = useState<IssueError | undefined>(undefined);
  const transitionKeys = useRef(new CreateIdempotencyKeys());
  const taskKeys = useRef(new CreateIdempotencyKeys());
  const stream = useIssueStream(client, workspaceId, issueId);
  const seenSequence = useRef(0);
  const stageCardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([
      client.getIssue(workspaceId, issueId),
      client.getIssueStage(workspaceId, issueId),
      client.listAllIssueTasks(workspaceId, issueId),
      client.listAllIssueRuns(workspaceId, issueId),
    ])
      .then(([nextIssue, nextStage, nextTasks, nextRuns]) => {
        if (!active) return;
        setIssue(nextIssue);
        setStage(nextStage);
        setTasks(nextTasks);
        setRuns(nextRuns);
        setLoadError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setLoadError(describeIssueError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, issueId, reloadToken]);

  // The review surface loads independently: a candidate/approval read failure
  // must never blank the issue projection or its stage actions.
  useEffect(() => {
    let active = true;
    setReviewLoading(true);
    void Promise.all([
      client.listAllIssueCandidates(workspaceId, issueId),
      client.listAllIssueApprovals(workspaceId, issueId),
      client.listAllIssueDeliveries(workspaceId, issueId),
    ])
      .then(([nextCandidates, nextApprovals, nextDeliveries]) => {
        if (!active) return;
        setCandidates(nextCandidates);
        setApprovals(nextApprovals);
        setDeliveries(nextDeliveries);
        setReviewError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setReviewError(describeIssueError(caught));
      })
      .finally(() => {
        if (active) setReviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, issueId, reloadToken]);

  useEffect(() => {
    seenSequence.current = 0;
  }, [issueId]);

  // Any durable event can change the projection this view renders. Refresh
  // once per burst instead of racing one request per event.
  useEffect(() => {
    const latest = stream.events.at(-1);
    if (!latest || latest.sequence <= seenSequence.current) return;
    seenSequence.current = latest.sequence;
    const timer = window.setTimeout(() => setReloadToken((value) => value + 1), 250);
    return () => window.clearTimeout(timer);
  }, [stream.events]);

  const allowedTransitions = useMemo(
    () => (stage?.allowed_transitions ?? []).filter(isKnownProductState),
    [stage],
  );
  const unrecognisedTransitions = (stage?.allowed_transitions ?? []).filter(
    (target) => !isKnownProductState(target),
  );

  function applyApproval(updated: Approval): void {
    setApprovals((current) =>
      current.some((approval) => approval.approval_id === updated.approval_id)
        ? current.map((approval) =>
            approval.approval_id === updated.approval_id ? updated : approval,
          )
        : [...current, updated],
    );
  }

  function applyDelivery(updated: Delivery): void {
    setDeliveries((current) =>
      current.some((delivery) => delivery.delivery_id === updated.delivery_id)
        ? current.map((delivery) =>
            delivery.delivery_id === updated.delivery_id ? updated : delivery,
          )
        : [...current, updated],
    );
  }

  async function submitTransition(input: { reason: string; disposition: string }): Promise<void> {
    if (!stage || !pendingTransition) return;
    const body: IssueStageTransition = {
      to: pendingTransition,
      ...(input.reason.trim() ? { reason: input.reason.trim() } : {}),
      ...(input.disposition.trim() ? { disposition: { reference: input.disposition.trim() } } : {}),
    };
    setTransitionBusy(true);
    setTransitionError(undefined);
    try {
      const key = transitionKeys.current.forInput(body);
      const nextStage = await client.transitionIssueStage(workspaceId, issueId, body, key);
      transitionKeys.current.complete(body);
      setStage(nextStage);
      setPendingTransition(undefined);
      setReloadToken((value) => value + 1);
      onChanged();
    } catch (caught) {
      const described = describeIssueError(caught);
      setTransitionError(described);
      // A refused edge means the local stage projection is stale; re-read it
      // so the rendered allowed transitions stay server-authoritative.
      if (!described.missing) setReloadToken((value) => value + 1);
    } finally {
      setTransitionBusy(false);
    }
  }

  async function moveTask(task: IssueTask, to: IssueTaskState): Promise<void> {
    setTaskBusy(task.task_id);
    setActionError(undefined);
    try {
      const input = { task_id: task.task_id, to };
      const key = taskKeys.current.forInput(input);
      const updated = await client.setIssueTaskState(workspaceId, issueId, task.task_id, to, key);
      taskKeys.current.complete(input);
      setTasks((current) =>
        current.map((entry) => (entry.task_id === updated.task_id ? updated : entry)),
      );
      onChanged();
    } catch (caught) {
      const described = describeIssueError(caught);
      setActionError(errorLabel(described));
      if (described.missing) setReloadToken((value) => value + 1);
    } finally {
      setTaskBusy(undefined);
    }
  }

  const streamLabel =
    stream.connection === "connected"
      ? stream.terminal
        ? "Stream closed after the terminal event"
        : "Live stream"
      : stream.connection === "connecting"
        ? "Connecting to the retained event log"
        : stream.connection === "reconnecting"
          ? "Reconnecting with Last-Event-ID"
          : stream.connection === "offline"
            ? "Stream offline"
            : "No issue stream";

  return (
    <section className="detail-view issue-detail" aria-labelledby="issue-detail-title">
      <div className="detail-header">
        <button type="button" className="detail-back" onClick={onBack}>
          ← Issues
        </button>
        <div className="detail-heading">
          <div className="breadcrumb">ISSUE / {shortId(issueId, 18)}</div>
          <h2 id="issue-detail-title">{issue ? redactText(issue.summary) : "Loading issue…"}</h2>
          {issue && (
            <div className="detail-subline">
              <span className="mono">{redactText(issue.repository.repository_id)}</span>
              <span className="divider">/</span>
              <span className="mono">{redactText(issue.repository.base_ref)}</span>
              <span className="divider">·</span>
              <span>Updated {formatDate(issue.updated_at)}</span>
            </div>
          )}
        </div>
        <div className="detail-actions">
          {issue && (
            <div className={`stage-pill stage-tone-${productStageTone(issue.product_state)}`}>
              <span className="eyebrow">Product stage</span>
              <strong>{productStateLabel(issue.product_state)}</strong>
            </div>
          )}
        </div>
      </div>

      {loadError && (
        <div className="connection-banner" role="alert">
          <span className="banner-dot" />
          <div>
            <strong>
              {loadError.missing ? "Issue not available" : "Issue could not be loaded"}
            </strong>
            <span>
              {loadError.missing
                ? `${errorLabel(loadError)}. The issue may have been removed, or it is outside this workspace scope.`
                : errorLabel(loadError)}
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
            aria-label="Dismiss issue action error"
            onClick={() => setActionError(undefined)}
          >
            ×
          </button>
        </div>
      )}

      {!issue ? (
        <div className="card card-empty">
          {loading ? "Reading the issue projection…" : "No issue projection is available."}
        </div>
      ) : (
        <div className="detail-grid">
          <div className="detail-main-column">
            <section
              ref={stageCardRef}
              id="issue-stage-card"
              className="card stage-card"
              aria-labelledby="issue-stage-heading"
            >
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Product lifecycle</span>
                  <h3 id="issue-stage-heading">Stage &amp; disposition</h3>
                </div>
                <span className={`stage-badge stage-tone-${productStageTone(issue.product_state)}`}>
                  {productStateLabel(issue.product_state)}
                </span>
              </div>
              <p className="stage-description">{productStateDescription(issue.product_state)}</p>
              {issue.state_reason && (
                <div className="reason-card issue-reason">
                  <span className="reason-icon">!</span>
                  <div>
                    <strong>Recorded state reason</strong>
                    <p>{redactText(issue.state_reason)}</p>
                  </div>
                </div>
              )}
              {isTerminalProductState(issue.product_state) && (
                <p className="stage-terminal-note">
                  {issue.product_state === "cancelled"
                    ? "Cancelled is terminal for this issue. New work requires a new issue."
                    : "Completed is terminal for this issue. Production recovery is not claimed by this stage."}
                </p>
              )}
              {stage && allowedTransitions.length > 0 && (
                <div
                  className="transition-group"
                  role="group"
                  aria-label={
                    stageChangeNeedsDisposition(stage.product_state)
                      ? "Record human disposition"
                      : "Allowed product stage transitions"
                  }
                >
                  <span className="field-label">
                    {stageChangeNeedsDisposition(stage.product_state)
                      ? "Leaving needs human disposition requires a recorded disposition reference."
                      : "Allowed transitions reported by the service"}
                  </span>
                  <div className="transition-actions">
                    {allowedTransitions.map((target) => (
                      <button
                        key={target}
                        type="button"
                        className="button button-secondary button-small"
                        disabled={!canMutate || transitionBusy}
                        onClick={() => {
                          setTransitionError(undefined);
                          setPendingTransition(target);
                        }}
                      >
                        {stageChangeNeedsDisposition(stage.product_state)
                          ? "Record disposition → "
                          : "Move to "}
                        {productStateLabel(target)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {stage && allowedTransitions.length === 0 && (
                <p className="stage-terminal-note">
                  The service reports no allowed transition from this stage.
                </p>
              )}
              {unrecognisedTransitions.length > 0 && (
                <p className="stage-terminal-note">
                  The service also reported transitions this build cannot render:{" "}
                  {unrecognisedTransitions.map((target) => redactText(target)).join(", ")}. Update
                  the workbench before using them.
                </p>
              )}
              {!stage && !loadError && <div className="card-empty compact">Reading stage…</div>}
              {!canMutate && (
                <p className="stage-terminal-note" role="status">
                  Your workspace role is read-only. Stage and task changes are disabled.
                </p>
              )}
            </section>

            <ChangeReviewCard
              client={client}
              workspaceId={workspaceId}
              issueId={issueId}
              currentUserId={currentUserId}
              canMutate={canMutate}
              candidates={candidates}
              approvals={approvals}
              loading={reviewLoading}
              error={reviewError}
              onRetry={() => setReloadToken((value) => value + 1)}
              onApprovalUpdated={applyApproval}
              onChanged={onChanged}
            />

            <DeliveryStatusCard
              client={client}
              workspaceId={workspaceId}
              issueId={issueId}
              deliveries={deliveries}
              candidates={candidates}
              loading={reviewLoading}
              error={reviewError}
              canMutate={canMutate}
              onRetry={() => setReloadToken((value) => value + 1)}
              onDeliveryUpdated={applyDelivery}
              onChanged={onChanged}
            />

            <section className="card task-progress-card" aria-labelledby="issue-tasks-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Bounded work</span>
                  <h3 id="issue-tasks-heading">Task progress</h3>
                </div>
                <span className="event-count">
                  {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
                </span>
              </div>
              {tasks.length === 0 ? (
                <div className="card-empty compact">No child task has been routed yet.</div>
              ) : (
                <ul className="issue-task-list">
                  {tasks.map((task) => (
                    <IssueTaskRow
                      key={task.task_id}
                      task={task}
                      tasks={tasks}
                      canMutate={canMutate}
                      busy={taskBusy === task.task_id}
                      onMove={moveTask}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="card issue-runs-card" aria-labelledby="issue-runs-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Harness</span>
                  <h3 id="issue-runs-heading">Bounded runs</h3>
                </div>
                <span className="event-count">
                  {runs.length} {runs.length === 1 ? "run" : "runs"}
                </span>
              </div>
              <p className="stage-description">{HARNESS_STATE_NOTE}</p>
              {runs.length === 0 ? (
                <div className="card-empty compact">No bounded run has been opened yet.</div>
              ) : (
                <div className="issue-run-list">
                  {runs.map((run) => (
                    <IssueRunCard key={run.run_id} run={run} />
                  ))}
                </div>
              )}
            </section>

            <IssueTimeline stream={stream} label={streamLabel} />
          </div>

          <aside className="detail-side-column">
            <section className="card identity-card" aria-labelledby="issue-binding-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Issue binding</span>
                  <h3 id="issue-binding-heading">Workspace scope</h3>
                </div>
              </div>
              <MetaRow label="Issue ID" value={shortId(issue.issue_id, 18)} mono />
              <MetaRow label="Workspace" value={redactText(issue.workspace.workspace_id)} mono />
              <MetaRow label="Enterprise" value={redactText(issue.workspace.enterprise_id)} mono />
              <MetaRow label="Repository" value={redactText(issue.repository.repository_id)} />
              <MetaRow label="Base revision" value={shortId(issue.repository.base_sha, 16)} mono />
              <MetaRow label="Dedupe key" value={redactText(issue.dedupe_key)} mono />
              {issue.source_reference && (
                <MetaRow label="Source" value={redactText(issue.source_reference)} />
              )}
              <MetaRow label="Created" value={formatDate(issue.created_at)} />
            </section>

            <section className="card disposition-card" aria-labelledby="issue-disposition-heading">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Stop outcomes</span>
                  <h3 id="issue-disposition-heading">Human disposition</h3>
                </div>
              </div>
              <p className="stage-description">
                A stop is an outcome, never a retry. Stopped runs do not resume; continuing requires
                a recorded disposition and new bounded work.
              </p>
              {runs.filter((run) => runRequiresDisposition(run.state)).length === 0 ? (
                <div className="card-empty compact">No run is waiting for a disposition.</div>
              ) : (
                <ul className="disposition-list">
                  {runs
                    .filter((run) => runRequiresDisposition(run.state))
                    .map((run) => (
                      <li key={run.run_id}>
                        <span className="mono">{shortId(run.run_id, 16)}</span>
                        <strong>{harnessStateLabel(run.state)}</strong>
                        {run.stop_reason && <span>{redactText(run.stop_reason)}</span>}
                        {run.stopped_at && <span>Stopped {formatDate(run.stopped_at)}</span>}
                      </li>
                    ))}
                </ul>
              )}
              {issue.product_state === "needs_human" && (
                <button
                  type="button"
                  className="button button-primary button-small disposition-jump"
                  onClick={() => stageCardRef.current?.scrollIntoView({ block: "start" })}
                >
                  Go to disposition entry
                </button>
              )}
            </section>
          </aside>
        </div>
      )}

      {pendingTransition && stage && (
        <TransitionDialog
          from={stage.product_state}
          to={pendingTransition}
          busy={transitionBusy}
          error={transitionError}
          onCancel={() => {
            setPendingTransition(undefined);
            setTransitionError(undefined);
          }}
          onSubmit={(input) => void submitTransition(input)}
        />
      )}
    </section>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined}>{value}</strong>
    </div>
  );
}

function IssueTaskRow({
  task,
  tasks,
  canMutate,
  busy,
  onMove,
}: {
  task: IssueTask;
  tasks: IssueTask[];
  canMutate: boolean;
  busy: boolean;
  onMove: (task: IssueTask, to: IssueTaskState) => Promise<void>;
}): ReactElement {
  const known = new Map(tasks.map((entry) => [entry.task_id, entry]));
  const unresolved = task.depends_on.filter((id) => known.get(id)?.state !== "done");
  const unknown = task.depends_on.filter((id) => !known.has(id));
  const terminal = isTerminalTaskState(task.state);
  const blocked = task.state === "open" && unresolved.length > 0;
  const canStart = task.state === "open" && !blocked;
  const canFinish = task.state === "active";
  return (
    <li className="issue-task-row">
      <div className="issue-task-topline">
        <span className={`task-state-pill task-state-${task.state}`}>
          {issueTaskStateLabel(task.state)}
        </span>
        <span className="mono">{shortId(task.task_id, 18)}</span>
        <span className="task-role">{task.role}</span>
        {task.assignee_agent_id && (
          <span className="task-assignee mono">{shortId(task.assignee_agent_id, 14)}</span>
        )}
        <span className="task-updated">{formatDate(task.updated_at)}</span>
      </div>
      {task.depends_on.length > 0 && (
        <div className="task-dependencies">
          <span className="field-label">Depends on</span>
          {task.depends_on.map((id) => {
            const dependency = known.get(id);
            return (
              <span
                key={id}
                className={`dependency-chip dependency-${dependency ? dependency.state : "unknown"}`}
              >
                {shortId(id, 14)} ·{" "}
                {dependency ? issueTaskStateLabel(dependency.state) : "state unknown"}
              </span>
            );
          })}
        </div>
      )}
      {blocked && !terminal && (
        <p className="task-blocked-note">
          Blocked: {unresolved.length}{" "}
          {unresolved.length === 1 ? "dependency is" : "dependencies are"} not done
          {unknown.length > 0
            ? ` (${unknown.length} state unknown; the service refuses the edge if the dependency is unfinished)`
            : ""}
          . A task cannot leave open until every dependency is done.
        </p>
      )}
      {canMutate && !terminal && (
        <div className="task-actions">
          {canStart && (
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={busy}
              onClick={() => void onMove(task, "active")}
            >
              {busy ? "Starting…" : "Start task"}
            </button>
          )}
          {canFinish && (
            <button
              type="button"
              className="button button-secondary button-small"
              disabled={busy}
              onClick={() => void onMove(task, "done")}
            >
              {busy ? "Saving…" : "Mark done"}
            </button>
          )}
          <button
            type="button"
            className="button button-quiet button-small"
            disabled={busy}
            onClick={() => void onMove(task, "cancelled")}
          >
            {busy ? "Saving…" : "Cancel task"}
          </button>
        </div>
      )}
    </li>
  );
}

function IssueRunCard({ run }: { run: IssueRun }): ReactElement {
  const hasHandoff = Boolean(run.head_sha) || run.artifact_refs.length > 0;
  return (
    <article className="issue-run" aria-labelledby={`run-${run.run_id}-title`}>
      <div className="issue-run-heading">
        <div>
          <span className="eyebrow">Run</span>
          <h4 id={`run-${run.run_id}-title`} className="mono">
            {shortId(run.run_id, 22)}
          </h4>
        </div>
        <span className={`harness-state-pill harness-tone-${harnessStateTone(run.state)}`}>
          Harness: {harnessStateLabel(run.state)}
        </span>
      </div>
      <div className="issue-run-meta">
        <span>Role {run.role}</span>
        <span>Opened {formatDate(run.opened_at)}</span>
        <span>Updated {formatDate(run.updated_at)}</span>
        <span>Worktree {shortId(run.worktree.worktree_id, 20)}</span>
        {run.task_id && <span>Task {shortId(run.task_id, 18)}</span>}
      </div>
      {run.stop_reason && (
        <div className="reason-card issue-reason">
          <span className="reason-icon">!</span>
          <div>
            <strong>
              {run.state === "stopped" ? "Stop reason" : "Outcome reason"}
              {run.stopped_at ? ` · ${formatDate(run.stopped_at)}` : ""}
            </strong>
            <p>{redactText(run.stop_reason)}</p>
          </div>
        </div>
      )}
      {runRequiresDisposition(run.state) && (
        <p className="run-disposition-note">
          {run.state === "stopped"
            ? "A stopped run never resumes. A new bounded run and a recorded human disposition are required to continue."
            : "This run is terminal for its grant. Continuing requires a new bounded run."}
        </p>
      )}
      <div className="run-facts">
        <div>
          <span className="metric-label">Head</span>
          <strong className="mono">{shortId(run.head_sha, 16)}</strong>
        </div>
        <div>
          <span className="metric-label">Lease</span>
          <strong className="mono">
            {run.lease
              ? `${redactText(run.lease.holder)} · fencing ${run.lease.fencing_token}`
              : "none"}
          </strong>
        </div>
        <div>
          <span className="metric-label">Limits</span>
          <strong>
            {run.limits.max_wall_clock_seconds}s · {run.limits.max_memory_mb} MB ·{" "}
            {run.limits.max_tokens} tokens
          </strong>
        </div>
      </div>
      <div className="run-scope">
        <span className="field-label">Scope</span>
        <span>Tools: {run.scope.tools.map(redactText).join(", ") || "none"}</span>
        <span>Paths: {run.scope.paths.map(redactText).join(", ") || "none"}</span>
        <span>Network: {run.scope.network.map(redactText).join(", ") || "none"}</span>
      </div>
      <div className="run-grants">
        <span className="field-label">Grants</span>
        {run.grants.length === 0 ? (
          <span className="muted-copy">No grant was recorded for this run.</span>
        ) : (
          run.grants.map((grant) => (
            <div className="grant-row" key={grant.grant_id}>
              <span className={`grant-state grant-${grant.state}`}>{grant.state}</span>
              <span className="mono">{shortId(grant.grant_id, 18)}</span>
              <span>
                patch {grant.may_create_patch ? "allowed" : "denied"} · PR{" "}
                {grant.may_create_or_update_pr ? "allowed" : "denied"}
              </span>
              <span>Expires {formatDate(grant.expires_at)}</span>
              {grant.revoked_reason && <span>{redactText(grant.revoked_reason)}</span>}
            </div>
          ))
        )}
      </div>
      {hasHandoff && (
        <div className="handoff-block">
          <span className="eyebrow">Handoff evidence</span>
          <p>
            Head identity and immutable artifact references only. Raw memory, commands, and absolute
            paths are never carried across runs.
          </p>
          {run.head_sha && (
            <div className="info-row">
              <span>Head</span>
              <strong className="mono">{run.head_sha}</strong>
            </div>
          )}
          {run.artifact_refs.map((artifact) => (
            <div className="artifact-ref" key={artifact.artifact_id}>
              <span className="mono">{redactText(artifact.artifact_id)}</span>
              <span>{redactText(artifact.kind)}</span>
              <span className="mono">
                {redactText(artifact.digest_algorithm)}:{redactText(artifact.digest)}
              </span>
              <span className="mono">
                base {shortId(artifact.base_sha, 12)} · head {shortId(artifact.head_sha, 12)}
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

const CONNECTION_TONE: Record<IssueStreamConnection, string> = {
  idle: "muted",
  connecting: "attention",
  connected: "live",
  reconnecting: "attention",
  offline: "danger",
};

function IssueTimeline({
  stream,
  label,
}: {
  stream: IssueStreamState;
  label: string;
}): ReactElement {
  return (
    <section className="card timeline-card" aria-labelledby="issue-timeline-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Durable log</span>
          <h3 id="issue-timeline-heading">Issue timeline</h3>
        </div>
        <span className={`stream-status stream-tone-${CONNECTION_TONE[stream.connection]}`}>
          {label}
        </span>
      </div>
      {stream.error && stream.connection === "offline" && (
        <div className="stream-note" role="status">
          Replay will resume automatically from the last delivered event id.
        </div>
      )}
      <div className="stream-meta" role="status">
        <span>
          {stream.events.length} {stream.events.length === 1 ? "event" : "events"}
        </span>
        {stream.duplicates > 0 && <span>{stream.duplicates} replayed duplicates suppressed</span>}
        {stream.gapRecoveries > 0 && (
          <span>{stream.gapRecoveries} sequence gaps repaired by full replay</span>
        )}
        <span>Deduplicated on event_id, ordered by sequence</span>
      </div>
      {stream.events.length === 0 ? (
        <div className="card-empty">
          {stream.connection === "offline"
            ? "No retained events are available while the stream is offline."
            : "Waiting for the retained event log."}
        </div>
      ) : (
        <ol className="issue-event-list">
          {stream.events.map((event) => (
            <li key={event.event_id} className="issue-event-row">
              <span className="event-sequence mono">{event.sequence}</span>
              <div>
                <strong>{issueEventLabel(event.type)}</strong>
                <p>{redactText(issueEventSummary(event))}</p>
              </div>
              <span className="event-time">{formatDate(event.occurred_at)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TransitionDialog({
  from,
  to,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  from: string;
  to: ProductState;
  busy: boolean;
  error: IssueError | undefined;
  onCancel: () => void;
  onSubmit: (input: { reason: string; disposition: string }) => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [disposition, setDisposition] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requiresReason = stageChangeNeedsReason(to);
  const requiresDisposition = stageChangeNeedsDisposition(from);
  const invalid =
    (requiresReason && reason.trim().length === 0) ||
    (requiresDisposition && disposition.trim().length === 0);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (invalid || busy) return;
    onSubmit({ reason, disposition });
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
        className="modal issue-transition-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-transition-title"
        aria-describedby="issue-transition-description"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id="issue-transition-title">Move to {productStateLabel(to)}</h2>
        <p id="issue-transition-description">
          {productStateDescription(to)}{" "}
          {requiresDisposition
            ? "Leaving needs human disposition records your authenticated reference; it never retries the stopped run."
            : "The service validates the edge and the product/harness consistency before applying it."}
        </p>
        {requiresReason && (
          <label className="field-block">
            <span className="field-label">Reason (required for a stop or cancellation)</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              required
              disabled={busy}
            />
          </label>
        )}
        {requiresDisposition && (
          <label className="field-block">
            <span className="field-label">Human disposition reference (required)</span>
            <input
              type="text"
              value={disposition}
              onChange={(event) => setDisposition(event.target.value)}
              required
              disabled={busy}
            />
          </label>
        )}
        {error && (
          <div className="inline-error issue-transition-error" role="alert">
            <span>{errorLabel(error)}</span>
          </div>
        )}
        <div className="modal-actions issue-transition-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={invalid || busy}>
            {busy ? "Applying…" : "Apply transition"}
          </button>
        </div>
      </form>
    </div>
  );
}
