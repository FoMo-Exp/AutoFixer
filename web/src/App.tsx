import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ApiConfigurationError, ApiError, ForgePilotClient } from "./api/client";
import type { ArtifactMetadata, RunSummary, Task, TaskEvent, TaskStatus } from "./api/client";
import { resolveApiConfig } from "./api/config";
import { useTaskStream } from "./api/hooks";
import { CreateIdempotencyKeys } from "./api/idempotency";
import { RepositoryPicker } from "./settings/RepositoryPicker";
import { SettingsDialog } from "./settings/SettingsDialog";
import {
  approvalScopeDigest,
  buildTimelineRows,
  eventLabel,
  eventSummary,
  formatDate,
  formatStatus,
  piTurnSummary,
  progressPercent,
  shortId,
  TERMINAL_STATUSES,
} from "./ui/format";
import type { PiTurnRow } from "./ui/format";
import { piSummaryHeadline, piSummaryStateLabel, resolvePiSummary } from "./ui/pi-summary";
import { redactText, sanitizeValue } from "./ui/redaction";
import { Select } from "./ui/Select";
import { applyScrollMode, getScrollMode, STACKED_MIN_TASKS } from "./ui/scroll-mode";
import type { ScrollMode } from "./ui/scroll-mode";
import { useStackFold } from "./ui/use-stack-fold";

const STATUS_FILTERS: Array<"all" | TaskStatus> = [
  "all",
  "awaiting_approval",
  "executing",
  "awaiting_review",
  "approved_for_merge",
  "stopped",
  "merged",
];

interface CreateTaskForm {
  repositoryId: string;
  baseRef: string;
  summary: string;
  sourceReference: string;
  acceptanceCriteria: string;
}

const INITIAL_FORM: CreateTaskForm = {
  repositoryId: "github:Luthiel/AutoFixer",
  baseRef: "main",
  summary: "",
  sourceReference: "",
  acceptanceCriteria: "",
};

type ServiceStatus = "connecting" | "connected" | "offline";

export default function App(): ReactElement {
  const client = useMemo(() => new ForgePilotClient(resolveApiConfig()), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  /** 窄屏钻取视图：list ↔ detail（≤900px 生效，桌面始终双栏并存） */
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  /** 每次点击任务卡片递增，强制详情 effect 重新执行（selectedId 不变时也能刷新） */
  const [detailEpoch, setDetailEpoch] = useState(0);
  /** 侧栏任务列表滚动模式：常规滚动条 / 每 3 张卡一组的折叠滚动 */
  const [scrollMode, setScrollMode] = useState<ScrollMode>(() => getScrollMode());

  const changeScrollMode = useCallback((mode: ScrollMode): void => {
    setScrollMode(mode);
    applyScrollMode(mode);
  }, []);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [selectedTask, setSelectedTask] = useState<Task>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>("connecting");
  const [serviceError, setServiceError] = useState<string>();
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Bumped whenever the settings dialog closes so open pickers re-run
  // discovery against the (possibly changed) account set.
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [form, setForm] = useState<CreateTaskForm>(INITIAL_FORM);
  const [isCreating, setIsCreating] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [isActionErrorHovered, setIsActionErrorHovered] = useState(false);
  const [actionBusy, setActionBusy] = useState<string>();
  const createKeyRef = useRef(new CreateIdempotencyKeys());
  const listRequestRef = useRef(0);
  const taskDetailRequestRef = useRef(0);

  useEffect(() => {
    if (!actionError) {
      setIsActionErrorHovered(false);
      return;
    }
    if (isActionErrorHovered) return;
    const timeoutId = window.setTimeout(() => {
      setActionError((current) => (current === actionError ? undefined : current));
    }, 1000);
    return () => window.clearTimeout(timeoutId);
  }, [actionError, isActionErrorHovered]);

  const selectTask = useCallback((taskId: string | undefined): void => {
    taskDetailRequestRef.current += 1;
    const previousId = selectedIdRef.current;
    selectedIdRef.current = taskId;
    setSelectedId(taskId);
    // 重新选中同一任务时保留现有详情，避免闪回 welcome 界面；
    // 切换到不同任务时才清空，等待新详情加载。
    if (previousId !== taskId) {
      setSelectedTask(undefined);
      setRuns([]);
    }
    setMobileView(taskId ? "detail" : "list");
    setActionError(undefined);
    setActionBusy(undefined);
    setDetailEpoch((n) => n + 1);
  }, []);

  const loadTasks = useCallback(async (showConnecting = false): Promise<void> => {
    const requestId = ++listRequestRef.current;
    if (showConnecting) setServiceStatus("connecting");
    try {
      const page = await client.listTasks();
      if (requestId !== listRequestRef.current) return;
      setTasks(page.items);
      setNextCursor(page.next_cursor);
      setServiceStatus("connected");
      setServiceError(undefined);
      if (!selectedIdRef.current && page.items[0]) selectTask(page.items[0].id);
    } catch (caught) {
      if (requestId !== listRequestRef.current) return;
      setServiceStatus("offline");
      setServiceError(errorMessage(caught));
    }
  }, [client, selectTask]);

  const loadMoreTasks = useCallback(async (): Promise<void> => {
    if (!nextCursor || isLoadingMore) return;
    const cursor = nextCursor;
    const listRequestId = listRequestRef.current;
    setIsLoadingMore(true);
    try {
      const page = await client.listTasks(undefined, cursor);
      if (listRequestId !== listRequestRef.current) return;
      setTasks((current) => {
        const knownIds = new Set(current.map((task) => task.id));
        return [...current, ...page.items.filter((task) => !knownIds.has(task.id))];
      });
      setNextCursor(page.next_cursor);
    } catch (caught) {
      if (listRequestId === listRequestRef.current) setActionError(errorMessage(caught));
    } finally {
      setIsLoadingMore(false);
    }
  }, [client, isLoadingMore, nextCursor]);

  useEffect(() => {
    void loadTasks(true);
  }, [loadTasks]);

  const refreshSelectedTask = useCallback(async (): Promise<void> => {
    const requestedId = selectedIdRef.current;
    if (!requestedId) return;
    const requestId = ++taskDetailRequestRef.current;
    try {
      const [task, taskRuns] = await Promise.all([
        client.getTask(requestedId),
        client.getRuns(requestedId),
      ]);
      if (
        selectedIdRef.current !== requestedId ||
        taskDetailRequestRef.current !== requestId
      ) {
        return;
      }
      setSelectedTask(task);
      setRuns(taskRuns);
      setTasks((current) => current.map((entry) => (entry.id === task.id ? task : entry)));
      setServiceStatus("connected");
      setServiceError(undefined);
    } catch (caught) {
      if (
        selectedIdRef.current !== requestedId ||
        taskDetailRequestRef.current !== requestId
      ) {
        return;
      }
      setActionError(errorMessage(caught));
    }
  }, [client]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedTask(undefined);
      setRuns([]);
      return;
    }
    void refreshSelectedTask();
  }, [refreshSelectedTask, selectedId, detailEpoch]);

  const handleStreamEvent = useCallback(
    (event: TaskEvent): void => {
      if (event.type === "task.status_changed" || event.type === "task.terminal") {
        void refreshSelectedTask();
        void loadTasks();
      }
    },
    [loadTasks, refreshSelectedTask],
  );
  const stream = useTaskStream(
    client,
    selectedId,
    handleStreamEvent,
    selectedTask ? TERMINAL_STATUSES.has(selectedTask.status) : false,
  );

  const visibleTasks = tasks.filter((task) => filter === "all" || task.status === filter);
  /** 折叠滚动只在卡片数超过阈值时生效，短列表保持常规滚动 */
  const stackedScroll = scrollMode === "stacked" && visibleTasks.length > STACKED_MIN_TASKS;

  const taskListRef = useRef<HTMLDivElement | null>(null);

  /** 折叠堆叠效果：中心按可展示高度定焦（约 5 张），范围外淡化收拢 */
  useStackFold(taskListRef, stackedScroll, `${visibleTasks.length}:${filter}`);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!form.summary.trim()) return;
    setIsCreating(true);
    setActionError(undefined);
    try {
      const input = {
        repository_id: form.repositoryId.trim(),
        base_ref: form.baseRef.trim(),
        summary: form.summary.trim(),
        ...(form.sourceReference.trim() ? { source_reference: form.sourceReference.trim() } : {}),
        ...(form.acceptanceCriteria.trim()
          ? { acceptance_criteria: splitCriteria(form.acceptanceCriteria) }
          : {}),
      };
      const idempotencyKey = createKeyRef.current.forInput(input);
      const task = await client.createTask(input, idempotencyKey);
      createKeyRef.current.complete(input);
      selectTask(task.id);
      setSelectedTask(task);
      setShowCreate(false);
      setForm(INITIAL_FORM);
      await loadTasks();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleTaskAction(
    action: "approve" | "reject" | "cancel",
    digest?: string,
  ): Promise<void> {
    if (!selectedTask) return;
    const taskId = selectedTask.id;
    setActionBusy(action);
    setActionError(undefined);
    try {
      const task =
        action === "cancel"
          ? await client.cancelTask(taskId)
          : await client.approveTask(taskId, {
              decision: action,
              scope_digest: digest ?? "",
            });
      listRequestRef.current += 1;
      if (selectedIdRef.current === taskId) {
        taskDetailRequestRef.current += 1;
        setSelectedTask(task);
      }
      setTasks((current) => current.map((entry) => (entry.id === task.id ? task : entry)));
    } catch (caught) {
      if (selectedIdRef.current === taskId) setActionError(errorMessage(caught));
    } finally {
      if (selectedIdRef.current === taskId) setActionBusy(undefined);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 22 22" fill="none" aria-hidden="true">
              <rect x="3" y="3.5" width="3.6" height="15" rx="1.2" fill="currentColor" />
              <rect x="15.4" y="3.5" width="3.6" height="15" rx="1.2" fill="currentColor" />
              <circle cx="11" cy="11" r="3" fill="var(--accent)" />
            </svg>
          </div>
          <div>
            <div className="brand-name">ForgePilot</div>
            <div className="brand-caption">Remediation workbench</div>
          </div>
        </div>
        <div className="topbar-actions">
          <ServiceBadge status={serviceStatus} />
          <button
            className="button button-quiet button-small"
            onClick={() => setShowSettings(true)}
            aria-label="Open settings"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
            <span className="action-label">Settings</span>
          </button>
          <button
            className="button button-primary button-small"
            onClick={() => setShowCreate(true)}
          >
            <span aria-hidden="true">＋</span> New task
          </button>
        </div>
      </header>

      <div className="workspace" data-view={mobileView}>
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div>
              <span className="eyebrow">Workspace</span>
              <h1>Tasks</h1>
            </div>
            <span className="task-count">{visibleTasks.length}</span>
          </div>
          <div className="filter-row" role="group" aria-label="Task filters">
            {STATUS_FILTERS.map((status) => (
              <button
                className={`filter-chip ${filter === status ? "filter-chip-active" : ""}`}
                key={status}
                onClick={() => setFilter(status)}
              >
                {status === "all" ? "All" : formatStatus(status)}
              </button>
            ))}
          </div>
          <div ref={taskListRef} className="task-list" data-scroll={stackedScroll ? "stacked" : "normal"}>
            {visibleTasks.length === 0 ? (
              <div className="empty-sidebar">
                <div className="empty-icon">⌁</div>
                <p>
                  {serviceStatus === "offline"
                    ? "Node service is offline."
                    : "No tasks in this view."}
                </p>
                <button className="button button-quiet" onClick={() => setShowCreate(true)}>
                  Start a task
                </button>
              </div>
            ) : (
              visibleTasks.map((task) => (
                <TaskListItem
                  key={task.id}
                  task={task}
                  selected={task.id === selectedId}
                  onClick={() => selectTask(task.id)}
                />
              ))
            )}
            {nextCursor && (
              <button
                className="button button-quiet button-small load-more"
                onClick={() => void loadMoreTasks()}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? "Loading…" : "Load more tasks"}
              </button>
            )}
          </div>
          <div className="sidebar-footer">
            <div className="security-note">
              <span className="security-icon" aria-hidden="true">
                ◈
              </span>
              <div>
                <strong>Local-only control</strong>
                <span>Redacted evidence · no shell access</span>
              </div>
            </div>
          </div>
        </aside>

        <main className="main-panel">
          {serviceStatus === "offline" && (
            <div className="connection-banner" role="alert">
              <span className="banner-dot" />
              <div>
                <strong>Node service unavailable</strong>
                <span>{serviceError ?? "Check the local service and try again."}</span>
              </div>
              <button
                className="button button-quiet button-small"
                onClick={() => void loadTasks(true)}
              >
                Retry connection
              </button>
            </div>
          )}
          {actionError && (
            <div
              className="inline-error"
              role="alert"
              onMouseEnter={() => setIsActionErrorHovered(true)}
              onMouseLeave={() => setIsActionErrorHovered(false)}
            >
              <span>{actionError}</span>
              <button
                aria-label="Dismiss error"
                onClick={() => setActionError(undefined)}
              >
                ×
              </button>
            </div>
          )}
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              runs={runs}
              events={stream.events}
              streamConnection={stream.connection}
              streamError={stream.error}
              client={client}
              actionBusy={actionBusy}
              onAction={handleTaskAction}
              onRefresh={() => void refreshSelectedTask()}
              onBack={() => {
                setMobileView("list");
                selectTask(undefined);
              }}
            />
          ) : (
            <WelcomePanel onCreate={() => setShowCreate(true)} />
          )}
        </main>
      </div>

      {showCreate && (
        <CreateTaskDialog
          form={form}
          isCreating={isCreating}
          onChange={setForm}
          onClose={() => setShowCreate(false)}
          onOpenSettings={() => setShowSettings(true)}
          onSubmit={handleCreate}
          refreshToken={settingsEpoch}
        />
      )}
      {showSettings && (
        <SettingsDialog
          onClose={() => {
            setShowSettings(false);
            setSettingsEpoch((value) => value + 1);
          }}
          scrollMode={scrollMode}
          onScrollModeChange={changeScrollMode}
        />
      )}
    </div>
  );
}

function ServiceBadge({ status }: { status: ServiceStatus }): ReactElement {
  const label =
    status === "connected"
      ? "Node connected"
      : status === "connecting"
        ? "Connecting"
        : "Node offline";
  return (
    <div className={`service-badge service-${status}`}>
      <span className="status-dot" />
      <span className="service-label">{label}</span>
    </div>
  );
}

function TaskListItem({
  task,
  selected,
  onClick,
}: {
  task: Task;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      className={`task-list-item ${selected ? "task-list-item-selected" : ""}`}
      onClick={onClick}
    >
      <div className="task-list-item-topline">
        <span className={`status-pip status-${task.status}`} />
        <span className="task-list-status">{formatStatus(task.status)}</span>
        <span className="task-list-time">{formatDate(task.updated_at)}</span>
      </div>
      <div className="task-list-summary">{redactText(task.request.summary)}</div>
      <div className="task-list-repo">
        <span>{redactText(task.repository.display_name)}</span>
      </div>
    </button>
  );
}

function WelcomePanel({ onCreate }: { onCreate: () => void }): ReactElement {
  return (
    <section className="welcome-panel">
      <div className="welcome-orbit" aria-hidden="true">
        <span />
        <span />
        <span />
        <b>
          <svg width="40" height="40" viewBox="0 0 22 22" fill="none" aria-hidden="true">
            <rect x="3" y="3.5" width="3.6" height="15" rx="1.2" fill="currentColor" />
            <rect x="15.4" y="3.5" width="3.6" height="15" rx="1.2" fill="currentColor" />
            <circle cx="11" cy="11" r="3" fill="var(--accent)" />
          </svg>
        </b>
      </div>
      <span className="eyebrow">Controlled remediation</span>
      <h2>Turn a reported problem into an auditable change.</h2>
      <p>
        ForgePilot keeps the operator in control. Start a task to follow risk, approval, execution,
        and evidence from one local workspace.
      </p>
      <button className="button button-primary" onClick={onCreate}>
        Create your first task <span aria-hidden="true">→</span>
      </button>
      <div className="welcome-principles">
        <span>Least privilege</span>
        <span>Redacted timeline</span>
        <span>Head-bound evidence</span>
      </div>
    </section>
  );
}

interface TaskDetailProps {
  task: Task;
  runs: RunSummary[];
  events: TaskEvent[];
  streamConnection: ReturnType<typeof useTaskStream>["connection"];
  streamError: string | undefined;
  client: ForgePilotClient;
  actionBusy: string | undefined;
  onAction: (action: "approve" | "reject" | "cancel", digest?: string) => Promise<void>;
  onRefresh: () => void;
  /** 窄屏钻取：返回任务列表 */
  onBack?: () => void;
}

function TaskDetail({
  task,
  runs,
  events,
  streamConnection,
  streamError,
  client,
  actionBusy,
  onAction,
  onRefresh,
  onBack,
}: TaskDetailProps): ReactElement {
  const [artifact, setArtifact] = useState<{
    metadata: ArtifactMetadata;
    value?: Record<string, unknown>;
  }>();
  const [artifactBusy, setArtifactBusy] = useState<string>();
  const [artifactError, setArtifactError] = useState<string>();
  const [message, setMessage] = useState("");
  const [messageMode, setMessageMode] = useState<"steer" | "follow_up">("steer");
  const [messageSent, setMessageSent] = useState(false);
  const digest = approvalScopeDigest(events, task.id);
  const timelineRows = buildTimelineRows(events);
  const piSummary = resolvePiSummary(task, events);
  const percentage = progressPercent(task.progress.actions_completed, task.progress.actions_total);
  const canCancel = !TERMINAL_STATUSES.has(task.status);

  async function browseArtifact(metadata: ArtifactMetadata): Promise<void> {
    if (!metadata.available) return;
    setArtifactBusy(metadata.artifact_id);
    setArtifactError(undefined);
    try {
      const value = await client.getArtifact(task.id, metadata.artifact_id);
      setArtifact({ metadata, value });
    } catch (caught) {
      setArtifactError(errorMessage(caught));
    } finally {
      setArtifactBusy(undefined);
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!message.trim()) return;
    try {
      await client.sendMessage(task.id, { mode: messageMode, content: message.trim() });
      setMessage("");
      setMessageSent(true);
      window.setTimeout(() => setMessageSent(false), 2200);
    } catch (caught) {
      setArtifactError(errorMessage(caught));
    }
  }

  return (
    <section className="detail-view">
      <div className="detail-header">
        {onBack && (
          <button type="button" className="detail-back" onClick={onBack}>
            ← Tasks
          </button>
        )}
        <div className="detail-heading">
          <div className="breadcrumb">TASK / {shortId(task.id, 18)}</div>
          <h2>{redactText(task.request.summary)}</h2>
          <div className="detail-subline">
            <span>{redactText(task.repository.display_name)}</span>
            <span className="divider">/</span>
            <span className="mono">{redactText(task.repository.base_ref)}</span>
            <span className="divider">·</span>
            <span>Updated {formatDate(task.updated_at)}</span>
          </div>
        </div>
        <div className="detail-actions">
          <div className={`status-pill status-pill-${task.status}`}>
            <span className="status-pip" /> {formatStatus(task.status)}
          </div>
          {canCancel && (
            <button
              className="button button-secondary"
              disabled={actionBusy === "cancel"}
              onClick={() => {
                if (window.confirm("Cancel this remediation task?")) void onAction("cancel");
              }}
            >
              {actionBusy === "cancel" ? "Cancelling…" : "Cancel task"}
            </button>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main-column">
          {task.status === "awaiting_approval" && (
            <ApprovalCard task={task} digest={digest} busy={actionBusy} onAction={onAction} />
          )}
          {task.status_reason && (
            <div className="reason-card">
              <span className="reason-icon">!</span>
              <div>
                <strong>Run note</strong>
                <p>{redactText(task.status_reason)}</p>
              </div>
            </div>
          )}
          <section className="card progress-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Current run</span>
                <h3>{task.current_run_id ? shortId(task.current_run_id, 18) : "Preparing run"}</h3>
              </div>
              <span className="connection-label">
                <span className={`stream-dot stream-${streamConnection}`} />
                {streamConnection === "connected"
                  ? "Live"
                  : streamConnection === "reconnecting"
                    ? "Reconnecting"
                    : "Syncing"}
              </span>
            </div>
            {streamError && streamConnection === "reconnecting" && (
              <div className="stream-note">
                Timeline paused while the local service reconnects. Events will resume
                automatically.
              </div>
            )}
            <div className="progress-metrics">
              <div>
                <span className="metric-label">Phase</span>
                <strong>
                  {task.progress.phase ? redactText(task.progress.phase) : "Not started"}
                </strong>
              </div>
              <div>
                <span className="metric-label">Actions</span>
                <strong>
                  {task.progress.actions_completed}
                  {task.progress.actions_total !== null
                    ? ` / ${task.progress.actions_total}`
                    : " completed"}
                </strong>
              </div>
              <div>
                <span className="metric-label">Risk</span>
                <strong>{task.risk ? redactText(task.risk.class) : "Pending"}</strong>
              </div>
            </div>
            <div
              className="progress-track"
              aria-label={
                percentage === undefined ? "Progress unavailable" : `${percentage}% complete`
              }
            >
              <span style={{ width: `${percentage ?? 8}%` }} />
            </div>
          </section>

          <section className="card pi-summary-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Pi</span>
                <h3>Pi summary</h3>
              </div>
              <span className={`pi-summary-state pi-summary-${piSummary.state}`}>
                {piSummaryStateLabel(piSummary)}
              </span>
            </div>
            <p className="pi-summary-copy">{piSummaryHeadline(piSummary)}</p>
            <div className="pi-summary-meta">
              {piSummary.runId && <span>run {shortId(piSummary.runId, 12)}</span>}
              {piSummary.turnId && <span>{piSummary.turnId}</span>}
              {piSummary.updatedAt && <span>{formatDate(piSummary.updatedAt)}</span>}
            </div>
            <span className="pi-summary-note">
              Raw Pi text is never displayed. The Node-side summary is the only Pi text source.
            </span>
          </section>

          <section className="card timeline-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Trace</span>
                <h3>Activity timeline</h3>
              </div>
              <span className="event-count">{events.length} events</span>
            </div>
            {events.length === 0 ? (
              <div className="card-empty">Waiting for the first task event.</div>
            ) : (
              <div className="timeline">
                {timelineRows.map((row) =>
                  row.kind === "pi_turn" ? (
                    <PiTurnEvent key={row.key} row={row} />
                  ) : (
                    <TimelineEvent key={row.key} event={row.event} />
                  ),
                )}
              </div>
            )}
          </section>

          {!TERMINAL_STATUSES.has(task.status) && (
            <form className="card message-card" onSubmit={(event) => void submitMessage(event)}>
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Operator input</span>
                  <h3>Guide this run</h3>
                </div>
                {messageSent && <span className="success-label">Message queued</span>}
              </div>
              <div className="message-controls">
                <Select
                  value={messageMode}
                  onChange={(v) => setMessageMode(v as typeof messageMode)}
                  options={[
                    { value: "steer", label: "Steer current turn" },
                    { value: "follow_up", label: "Queue follow-up" },
                  ]}
                  className="message-mode-select"
                />
                <button
                  className="button button-primary button-small"
                  type="submit"
                  disabled={!message.trim()}
                >
                  Send
                </button>
              </div>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Add a bounded instruction for Pi…"
                rows={3}
              />
              <span className="field-hint">
                Input is sent to the current task session and remains inside the local control
                plane.
              </span>
            </form>
          )}
        </div>

        <aside className="detail-side-column">
          <section className="card identity-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Task binding</span>
                <h3>Repository scope</h3>
              </div>
            </div>
            <InfoRow label="Repository" value={redactText(task.repository.display_name)} />
            <InfoRow label="Base ref" value={redactText(task.repository.base_ref)} mono />
            <InfoRow label="Base revision" value={shortId(task.repository.base_sha, 16)} mono />
            <InfoRow label="Task ID" value={shortId(task.id, 16)} mono />
            {task.request.source_reference && (
              <InfoRow label="Source" value={redactText(task.request.source_reference)} />
            )}
          </section>

          <section className="card artifacts-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Evidence</span>
                <h3>Artifacts</h3>
              </div>
              <span className="event-count">Redacted</span>
            </div>
            <div className="artifact-list">
              {task.artifacts.index.length === 0 ? (
                <div className="card-empty compact">Artifacts appear as the run produces them.</div>
              ) : (
                task.artifacts.index.map((metadata) => (
                  <ArtifactRow
                    key={metadata.artifact_id}
                    metadata={metadata}
                    busy={artifactBusy === metadata.artifact_id}
                    onBrowse={() => void browseArtifact(metadata)}
                  />
                ))
              )}
            </div>
            {artifactError && <div className="artifact-error">{artifactError}</div>}
            {artifact && (
              <div className="artifact-viewer">
                <div className="artifact-viewer-heading">
                  <strong>{redactText(artifact.metadata.artifact_id)}</strong>
                  <button aria-label="Close artifact" onClick={() => setArtifact(undefined)}>
                    ×
                  </button>
                </div>
                <pre>{JSON.stringify(sanitizeValue(artifact.value), null, 2)}</pre>
              </div>
            )}
          </section>

          <section className="card runs-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">History</span>
                <h3>Run history</h3>
              </div>
              <button className="icon-button" aria-label="Refresh task" onClick={onRefresh}>
                ↻
              </button>
            </div>
            {runs.length === 0 ? (
              <div className="card-empty compact">No run history yet.</div>
            ) : (
              <div className="run-list">
                {runs.map((run) => (
                  <div className="run-row" key={run.run_id}>
                    <span className={`status-pip status-${run.state}`} />
                    <span className="mono">{shortId(run.run_id, 14)}</span>
                    <span>{redactText(run.state.replaceAll("_", " "))}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function ApprovalCard({
  task,
  digest,
  busy,
  onAction,
}: {
  task: Task;
  digest: string | undefined;
  busy: string | undefined;
  onAction: (action: "approve" | "reject", digest?: string) => Promise<void>;
}): ReactElement {
  return (
    <section className="approval-card">
      <div className="approval-icon">⌁</div>
      <div className="approval-copy">
        <span className="eyebrow">Human checkpoint</span>
        <h3>Review before capabilities are granted</h3>
        <p>
          This task is classified as <strong>{task.risk?.class ?? "elevated"}</strong>. Approve only
          if the repository scope and acceptance criteria match your intent.
        </p>
        <div className="approval-lock">
          <span>◈</span>
          <span>{digest ? "Scope locked to this exact run" : "Waiting for the scope digest"}</span>
        </div>
        <div className="approval-actions">
          <button
            className="button button-primary"
            disabled={!digest || !!busy}
            onClick={() => void onAction("approve", digest)}
          >
            {busy === "approve" ? "Recording…" : "Approve run"}
          </button>
          <button
            className="button button-secondary"
            disabled={!digest || !!busy}
            onClick={() => void onAction("reject", digest)}
          >
            {busy === "reject" ? "Recording…" : "Reject"}
          </button>
        </div>
      </div>
    </section>
  );
}

function PiTurnEvent({ row }: { row: PiTurnRow }): ReactElement {
  return (
    <div className="timeline-event timeline-pi-turn">
      <div className="timeline-marker" aria-hidden="true">
        ✦
      </div>
      <div className="timeline-content">
        <div className="timeline-title">
          <strong>Pi summary</strong>
          <time dateTime={row.startedAt}>{formatDate(row.startedAt)}</time>
        </div>
        <p className="timeline-delta">{piTurnSummary(row)}</p>
      </div>
    </div>
  );
}

function TimelineEvent({ event }: { event: TaskEvent }): ReactElement {
  return (
    <div className={`timeline-event timeline-${event.type.replaceAll(".", "-")}`}>
      <div className="timeline-marker" aria-hidden="true">
        {event.type === "task.terminal" ? "✓" : event.type === "approval.required" ? "!" : "·"}
      </div>
      <div className="timeline-content">
        <div className="timeline-title">
          <strong>{eventLabel(event.type)}</strong>
          <time dateTime={event.occurred_at}>{formatDate(event.occurred_at)}</time>
        </div>
        <p>{redactText(eventSummary(event))}</p>
      </div>
    </div>
  );
}

function ArtifactRow({
  metadata,
  busy,
  onBrowse,
}: {
  metadata: ArtifactMetadata;
  busy: boolean;
  onBrowse: () => void;
}): ReactElement {
  return (
    <div className="artifact-row">
      <div className={`artifact-icon ${metadata.available ? "artifact-available" : ""}`}>
        {metadata.available ? "✓" : "·"}
      </div>
      <div className="artifact-copy">
        <strong>{redactText(metadata.artifact_id.replaceAll("_", " "))}</strong>
        <span>
          {metadata.available ? `Head ${shortId(metadata.head_sha, 12)}` : "Not available yet"}
        </span>
      </div>
      <button
        className="icon-button"
        disabled={!metadata.available || busy}
        onClick={onBrowse}
        aria-label={`Browse ${metadata.artifact_id}`}
      >
        {busy ? "…" : "→"}
      </button>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

function CreateTaskDialog({
  form,
  isCreating,
  onChange,
  onClose,
  onOpenSettings,
  onSubmit,
  refreshToken,
}: {
  form: CreateTaskForm;
  isCreating: boolean;
  onChange: (form: CreateTaskForm) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  refreshToken: number;
}): ReactElement {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
        <div className="modal-heading">
          <div>
            <span className="eyebrow">New remediation</span>
            <h2 id="new-task-title">Create a controlled task</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>
        <p className="modal-intro">
          Describe the bounded change. ForgePilot pins the repository and base revision before work
          begins.
        </p>
        <form onSubmit={(event) => void onSubmit(event)}>
          <RepositoryPicker
            repositoryId={form.repositoryId}
            baseRef={form.baseRef}
            onChange={(patch) => onChange({ ...form, ...patch })}
            onOpenSettings={onOpenSettings}
            refreshToken={refreshToken}
          />
          <label>
            <span className="label-text">Task summary <span className="required-dot">*</span></span>
            <textarea
              value={form.summary}
              onChange={(event) => onChange({ ...form, summary: event.target.value })}
              placeholder="What should ForgePilot investigate or prepare?"
              rows={3}
              required
            />
          </label>
          <label>
            Source reference
            <input
              value={form.sourceReference}
              onChange={(event) => onChange({ ...form, sourceReference: event.target.value })}
              placeholder="Issue or incident URL"
            />
          </label>
          <label>
            Acceptance criteria
            <textarea
              value={form.acceptanceCriteria}
              onChange={(event) => onChange({ ...form, acceptanceCriteria: event.target.value })}
              placeholder="Tests stay green\nNo changes outside the task scope"
              rows={3}
            />
          </label>
          <div className="modal-footer">
            <span className="field-hint">
              Retrying unchanged details reuses the same idempotency key.
            </span>
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={onClose}>
                Close
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={isCreating || !form.summary.trim()}
              >
                {isCreating ? "Creating…" : "Create task"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function splitCriteria(value: string): string[] {
  return value
    .split("\n")
    .map((criterion) => criterion.trim())
    .filter(Boolean);
}

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiConfigurationError)
    return (
      window.forgePilotConfig?.startupError ||
      "Configure the loopback Node service; default startup requires FORGEPILOT_BASE_SHA."
    );
  if (caught instanceof ApiError) return `${caught.code}: ${redactText(caught.message)}`;
  return caught instanceof Error
    ? redactText(caught.message)
    : "The request could not be completed.";
}
