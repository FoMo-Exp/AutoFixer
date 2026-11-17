import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  CreateIssueInput,
  ForgePilotClient,
  Issue,
  ProductState,
  Workspace,
} from "../api/client";
import { formatDate } from "../ui/format";
import { productStageTone, productStateLabel } from "../ui/issues";
import { redactText } from "../ui/redaction";
import { Select } from "../ui/Select";
import { useLiquidGlass } from "../ui/use-liquid-glass";
import { IssueDetail } from "./IssueDetail";
import { describeIssueError } from "./errors";
import type { IssueError } from "./errors";
import { CreateIdempotencyKeys } from "../api/idempotency";

type IssueFilter = "all" | ProductState;

const ISSUE_FILTERS: IssueFilter[] = [
  "all",
  "triage",
  "planning",
  "implementing",
  "validating",
  "awaiting_change_approval",
  "delivering",
  "pr_review",
  "needs_human",
  "completed",
  "cancelled",
];

export function IssuesWorkbench({
  client,
  currentUserId,
  loadWorkspaces,
}: {
  client: ForgePilotClient;
  currentUserId?: string;
  /** The caller's live workspace directory, owned by the identity surface. */
  loadWorkspaces: () => Promise<Workspace[]>;
}): ReactElement {
  const sidebarGlassRef = useLiquidGlass<HTMLElement>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [workspaceError, setWorkspaceError] = useState<IssueError | undefined>(undefined);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceToken, setWorkspaceToken] = useState(0);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<IssueFilter>("all");
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<IssueError | undefined>(undefined);
  const [listToken, setListToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRequestRef = useRef(0);

  const [selectedIssueId, setSelectedIssueId] = useState<string | undefined>(undefined);
  const [seedIssue, setSeedIssue] = useState<Issue | undefined>(undefined);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newLabels, setNewLabels] = useState("");
  const createKeys = useRef(new CreateIdempotencyKeys());

  useEffect(() => {
    let active = true;
    setWorkspaceLoading(true);
    loadWorkspaces()
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
        if (!active) return;
        setWorkspaceError(describeIssueError(caught));
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadWorkspaces, workspaceToken]);

  useEffect(() => {
    if (!workspaceId) {
      setIssues([]);
      setNextCursor(null);
      return;
    }
    let active = true;
    const requestId = ++listRequestRef.current;
    setListLoading(true);
    client
      .listIssues(workspaceId, filter === "all" ? {} : { productState: filter })
      .then((page) => {
        if (!active || requestId !== listRequestRef.current) return;
        setIssues(page.items);
        setNextCursor(page.next_cursor);
        setListError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || requestId !== listRequestRef.current) return;
        setListError(describeIssueError(caught));
      })
      .finally(() => {
        if (active && requestId === listRequestRef.current) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, filter, listToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!workspaceId || !nextCursor || loadingMore) return;
    const requestId = listRequestRef.current;
    setLoadingMore(true);
    try {
      const page = await client.listIssues(workspaceId, {
        ...(filter === "all" ? {} : { productState: filter }),
        cursor: nextCursor,
      });
      if (requestId !== listRequestRef.current) return;
      setIssues((current) => {
        const known = new Set(current.map((issue) => issue.issue_id));
        return [...current, ...page.items.filter((issue) => !known.has(issue.issue_id))];
      });
      setNextCursor(page.next_cursor);
    } catch (caught) {
      if (requestId === listRequestRef.current) setListError(describeIssueError(caught));
    } finally {
      setLoadingMore(false);
    }
  }, [client, workspaceId, nextCursor, loadingMore, filter]);

  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === "active");
  const selectedWorkspace = activeWorkspaces.find((workspace) => workspace.id === workspaceId);
  const canMutate = selectedWorkspace !== undefined && selectedWorkspace.role !== "viewer";
  const canOpenCreate = selectedWorkspace?.role !== "viewer";

  function selectIssue(issue: Issue): void {
    setSelectedIssueId(issue.issue_id);
    setSeedIssue(issue);
    setMobileView("detail");
  }

  function backToList(): void {
    setSelectedIssueId(undefined);
    setSeedIssue(undefined);
    setMobileView("list");
  }

  async function submitIssue(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!workspaceId || !newTitle.trim() || createBusy) return;
    setCreateBusy(true);
    setCreateError(undefined);
    const input: CreateIssueInput = {
      summary: newTitle.trim(),
      description: newDescription,
      labels: newLabels
        .split(/[\n,]/u)
        .map((label) => label.trim())
        .filter(Boolean),
    };
    try {
      const issue = await client.createIssue(
        workspaceId,
        input,
        createKeys.current.forInput(input),
      );
      createKeys.current.complete(input);
      setIssues((current) => [
        issue,
        ...current.filter((item) => item.issue_id !== issue.issue_id),
      ]);
      setCreating(false);
      setNewTitle("");
      setNewDescription("");
      setNewLabels("");
      setSelectedIssueId(issue.issue_id);
      setSeedIssue(issue);
      setMobileView("detail");
    } catch (caught) {
      setCreateError(describeIssueError(caught).message);
    } finally {
      setCreateBusy(false);
    }
  }

  const refreshList = useCallback((): void => {
    setListToken((value) => value + 1);
  }, []);

  const workspaceIssueUnavailable =
    workspaceError !== undefined && (workspaceError.missing || workspaceError.code === "NOT_FOUND");

  return (
    <div
      className="workspace issues-workspace"
      data-view={mobileView}
      data-scroll-lock={!selectedIssueId ? "true" : undefined}
    >
      <aside className="sidebar glass issues-sidebar" ref={sidebarGlassRef}>
        <div className="sidebar-heading">
          <div className="sidebar-heading-main">
            <div className="sidebar-title-row">
              <h1>Issues</h1>
              {canOpenCreate && (
                <button
                  type="button"
                  className="task-create"
                  onClick={() => setCreating(true)}
                  aria-label="New issue"
                  title="New issue"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M7 1.5v11M1.5 7h11" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <span className="task-count">{issues.length}</span>
        </div>

        {activeWorkspaces.length > 1 && (
          <div className="workspace-picker" role="group" aria-label="Workspace scope">
            <label className="field-label" htmlFor="issue-workspace">
              Workspace scope
            </label>
            <Select
              id="issue-workspace"
              value={workspaceId ?? ""}
              onChange={(value) => {
                setWorkspaceId(value);
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

        <div className="filter-row" role="group" aria-label="Product stage filters">
          {ISSUE_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={`filter-chip ${filter === option ? "filter-chip-active" : ""}`}
              aria-pressed={filter === option}
              onClick={() => {
                setFilter(option);
                backToList();
              }}
            >
              {option === "all" ? "All" : productStateLabel(option)}
            </button>
          ))}
        </div>

        <div className="task-list" data-scroll="normal">
          {workspaceLoading ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>Resolving workspace scope…</p>
            </div>
          ) : workspaceIssueUnavailable ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>
                No issue workspace is available to this credential. The issue surface is
                workspace-scoped and needs an active membership.
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
          ) : listError ? (
            <div className="empty-sidebar">
              <div className="empty-icon">!</div>
              <p>
                {listError.code}: {listError.message}
              </p>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={refreshList}
              >
                Retry
              </button>
            </div>
          ) : issues.length === 0 ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>{listLoading ? "Reading issues…" : "No issue in this product stage."}</p>
            </div>
          ) : (
            <>
              {issues.map((issue) => (
                <IssueListItem
                  key={issue.issue_id}
                  issue={issue}
                  selected={issue.issue_id === selectedIssueId}
                  onClick={() => selectIssue(issue)}
                />
              ))}
              {nextCursor && (
                <button
                  type="button"
                  className="button button-quiet button-small load-more"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more issues"}
                </button>
              )}
            </>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="security-note">
            <span className="security-icon" aria-hidden="true">
              ◈
            </span>
            <div>
              <strong>Workspace-scoped</strong>
              <span>Product stages and harness states stay separate</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        {selectedIssueId && workspaceId ? (
          <IssueDetail
            key={selectedIssueId}
            client={client}
            workspaceId={workspaceId}
            issueId={selectedIssueId}
            seed={seedIssue}
            currentUserId={currentUserId}
            canMutate={canMutate}
            onBack={backToList}
            onChanged={refreshList}
          />
        ) : (
          <section className="welcome-panel issue-welcome">
            <button type="button" className="detail-back" onClick={backToList}>
              ← Issues
            </button>
            <span className="eyebrow">Issue workbench</span>
            <h2>Follow bounded work from signal to delivery.</h2>
            <p>
              Product stages, child tasks, bounded runs, and the durable event log stay in one
              place. Stop outcomes require a recorded human disposition; nothing here retries a
              stopped run.
            </p>
            <div className="welcome-principles">
              <span>Product ≠ harness</span>
              <span>Replay-safe events</span>
              <span>Human disposition</span>
            </div>
          </section>
        )}
      </main>
      {creating && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreating(false);
          }}
        >
          <section
            className="modal glass issue-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-issue-title"
          >
            <div className="modal-heading">
              <h2 id="create-issue-title">New issue</h2>
              <button
                type="button"
                className="button button-quiet button-small"
                onClick={() => setCreating(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {!workspaceId ? (
              <div className="issue-create-empty-state">
                <p>No active workspace is available to this credential.</p>
                <p>Join or create a workspace from Workspaces, then create an issue here.</p>
              </div>
            ) : (
              <form className="form-stack" onSubmit={(event) => void submitIssue(event)}>
                <label className="field-label" htmlFor="new-issue-title">
                  <span className="label-text">
                    Title<span className="required-dot">*</span>
                  </span>
                  <input
                    id="new-issue-title"
                    autoFocus
                    required
                    maxLength={256}
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                  />
                </label>
                <label className="field-label" htmlFor="new-issue-description">
                  <span className="label-text">Description</span>
                  <textarea
                    id="new-issue-description"
                    rows={5}
                    value={newDescription}
                    onChange={(event) => setNewDescription(event.target.value)}
                  />
                </label>
                <label className="field-label" htmlFor="new-issue-labels">
                  <span className="label-text">Labels</span>
                  <input
                    id="new-issue-labels"
                    value={newLabels}
                    onChange={(event) => setNewLabels(event.target.value)}
                  />
                </label>
                {createError && (
                  <p role="alert" className="form-error">
                    {createError}
                  </p>
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={createBusy || !newTitle.trim()}
                  >
                    {createBusy ? "Creating…" : "Create issue"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function IssueListItem({
  issue,
  selected,
  onClick,
}: {
  issue: Issue;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <article
      className={`task-list-item issue-list-item ${selected ? "task-list-item-selected" : ""}`}
    >
      <button type="button" className="task-list-open" onClick={onClick}>
        <div className="task-list-item-topline">
          <span className={`stage-pip stage-tone-${productStageTone(issue.product_state)}`} />
          <span className="task-list-status task-list-status-label">
            {productStateLabel(issue.product_state)}
          </span>
          <span className="task-list-time">{formatDate(issue.updated_at)}</span>
        </div>
        <div className="task-list-summary">{redactText(issue.summary)}</div>
        <div className="task-list-repo">
          <span className="mono">{redactText(issue.repository.repository_id)}</span>
          <span className="issue-sync-indicator">
            {issue.provider ? (
              <a
                href={issue.provider.url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {issue.provider.provider_type} #{issue.provider.issue_number} ·{" "}
                {issue.provider.state}
              </a>
            ) : (
              `Sync ${issue.sync_state}`
            )}
          </span>
        </div>
      </button>
    </article>
  );
}
