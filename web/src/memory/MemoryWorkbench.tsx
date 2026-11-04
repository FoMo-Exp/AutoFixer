import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  ForgePilotClient,
  MemoryItem,
  MemoryKind,
  MemorySensitivity,
  MemoryStatus,
  MemoryTier,
  MemoryTrust,
  Workspace,
} from "../api/client";
import type { Team } from "../api/identity";
import { formatDate } from "../ui/format";
import { redactText } from "../ui/redaction";
import { Select } from "../ui/Select";
import { MemoryItemDetail } from "./MemoryItemDetail";
import {
  describeMemoryError,
  isMemoryRedacted,
  MEMORY_KIND_LABELS,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_STATUS_LABELS,
  MEMORY_TRUST_LABELS,
  memoryStanding,
  memoryStatusTone,
  quarantineSafeItem,
  workspaceRoleFromSession,
} from "./memory-format";
import type { MemoryError, MemorySessionView, MemoryStanding } from "./memory-format";

type KindFilter = "all" | MemoryKind;
type StatusFilter = "all" | MemoryStatus;
type TierFilter = "all" | MemoryTier;
type TrustFilter = "all" | MemoryTrust;
type SensitivityFilter = "all" | MemorySensitivity;

interface ScopeFilter {
  teamId: string;
  pathPrefix: string;
  language: string;
  taskFamily: string;
}

const EMPTY_SCOPE: ScopeFilter = { teamId: "", pathPrefix: "", language: "", taskFamily: "" };

const KIND_OPTIONS = (Object.keys(MEMORY_KIND_LABELS) as MemoryKind[]).map((kind) => ({
  value: kind,
  label: MEMORY_KIND_LABELS[kind],
}));
const STATUS_OPTIONS = (Object.keys(MEMORY_STATUS_LABELS) as MemoryStatus[]).map((status) => ({
  value: status,
  label: MEMORY_STATUS_LABELS[status],
}));
const TIER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "L1", label: "L1" },
  { value: "L2", label: "L2" },
  { value: "L3", label: "L3" },
  { value: "L4", label: "L4" },
];
const TRUST_OPTIONS = (Object.keys(MEMORY_TRUST_LABELS) as MemoryTrust[]).map((trust) => ({
  value: trust,
  label: MEMORY_TRUST_LABELS[trust],
}));
const SENSITIVITY_OPTIONS = (Object.keys(MEMORY_SENSITIVITY_LABELS) as MemorySensitivity[]).map(
  (sensitivity) => ({
    value: sensitivity,
    label: MEMORY_SENSITIVITY_LABELS[sensitivity],
  }),
);

/**
 * Identity of one browse query: workspace plus every contract filter. A page is
 * only rendered while it belongs to the currently selected query, so switching
 * workspace can never show the previous workspace's items, not even for the
 * render before the new request settles.
 */
function memoryQueryKey(
  workspaceId: string | undefined,
  kind: KindFilter,
  status: StatusFilter,
  tier: TierFilter,
  trust: TrustFilter,
  sensitivity: SensitivityFilter,
  scope: ScopeFilter,
): string {
  return [
    workspaceId ?? "",
    kind,
    status,
    tier,
    trust,
    sensitivity,
    scope.teamId,
    scope.pathPrefix,
    scope.language,
    scope.taskFamily,
  ].join("\u0000");
}

/** Only filters the merged contract defines are ever put on the wire. */
function memoryListOptions(
  kind: KindFilter,
  status: StatusFilter,
  tier: TierFilter,
  trust: TrustFilter,
  sensitivity: SensitivityFilter,
  scope: ScopeFilter,
  cursor?: string,
): Parameters<ForgePilotClient["listMemoryItems"]>[1] {
  const options: NonNullable<Parameters<ForgePilotClient["listMemoryItems"]>[1]> = {};
  if (kind !== "all") options.kind = kind;
  if (status !== "all") options.status = status;
  if (tier !== "all") options.tier = tier;
  if (trust !== "all") options.trust = trust;
  if (sensitivity !== "all") options.sensitivity = sensitivity;
  if (scope.teamId !== "") options.team_id = scope.teamId;
  if (scope.pathPrefix !== "") options.path_prefix = scope.pathPrefix;
  if (scope.language !== "") options.language = scope.language;
  if (scope.taskFamily !== "") options.task_family = scope.taskFamily;
  if (cursor !== undefined) options.cursor = cursor;
  return options;
}

export interface MemoryWorkbenchProps {
  client: ForgePilotClient;
  /** Session memberships decide governance standing; without them no actions show. */
  session?: MemorySessionView;
  /** Team leadership lookup; workspace owners and admins do not need it. */
  loadTeams?: (workspaceId: string) => Promise<Team[]>;
}

/**
 * Workspace memory browse plus the DAT-251 governance surface. Reads are
 * workspace-scoped and filtered by the service's sensitivity ceiling; writes
 * are named-human transitions whose authority the service re-checks on every
 * request.
 */
export function MemoryWorkbench({
  client,
  session,
  loadTeams,
}: MemoryWorkbenchProps): ReactElement {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [workspaceError, setWorkspaceError] = useState<MemoryError | undefined>(undefined);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceToken, setWorkspaceToken] = useState(0);

  const [page, setPage] = useState<{
    key: string;
    items: MemoryItem[];
    nextCursor: string | null;
  }>({ key: "", items: [], nextCursor: null });
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [tier, setTier] = useState<TierFilter>("all");
  const [trust, setTrust] = useState<TrustFilter>("all");
  const [sensitivity, setSensitivity] = useState<SensitivityFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>(EMPTY_SCOPE);
  const [scopeDraft, setScopeDraft] = useState<ScopeFilter>(EMPTY_SCOPE);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<{ key: string; error: MemoryError } | undefined>(
    undefined,
  );
  const [listToken, setListToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRequestRef = useRef(0);

  const queryKey = memoryQueryKey(workspaceId, kind, status, tier, trust, sensitivity, scope);
  const items = page.key === queryKey ? page.items : [];
  const nextCursor = page.key === queryKey ? page.nextCursor : null;
  const visibleListError = listError?.key === queryKey ? listError.error : undefined;

  const [selection, setSelection] = useState<{ workspaceId: string; item: MemoryItem }>();
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  // A detail belongs to the workspace it was opened from: a workspace change
  // hides it without needing a state reset after the next render.
  const selectedItem =
    selection !== undefined && selection.workspaceId === workspaceId ? selection.item : undefined;
  const selectedItemId = selectedItem?.item_id;

  const sessionRole = workspaceRoleFromSession(session, workspaceId);
  const [ledTeamIds, setLedTeamIds] = useState<ReadonlySet<string>>(new Set());
  const [teamState, setTeamState] = useState<"idle" | "loading" | "ready" | "failed">("idle");

  // Team leadership is not a workspace role, so it must be looked up from the
  // workspace's teams. Only a member can gain standing this way; an owner or
  // admin is never limited to a team, and a viewer never governs.
  useEffect(() => {
    let active = true;
    if (!workspaceId || !session || sessionRole !== "member" || !loadTeams) {
      setLedTeamIds(new Set());
      setTeamState("ready");
      return () => {
        active = false;
      };
    }
    setTeamState("loading");
    loadTeams(workspaceId)
      .then((teams) => {
        if (!active) return;
        setLedTeamIds(
          new Set(
            teams.filter((team) => team.leader_user_id === session.user.id).map((team) => team.id),
          ),
        );
        setTeamState("ready");
      })
      .catch(() => {
        if (!active) return;
        setLedTeamIds(new Set());
        setTeamState("failed");
      });
    return () => {
      active = false;
    };
  }, [workspaceId, session, sessionRole, loadTeams]);

  const standing: MemoryStanding | undefined =
    selectedItem && sessionRole
      ? (() => {
          const base = memoryStanding(sessionRole, ledTeamIds, selectedItem);
          if (base.scope === "workspace") return base;
          if (sessionRole === "member" && teamState !== "ready") {
            return {
              ...base,
              canGovern: false,
              note:
                teamState === "loading"
                  ? "Verifying team leadership before showing governance actions."
                  : "Team leadership could not be verified, so governance actions stay hidden.",
            };
          }
          return base;
        })()
      : undefined;

  useEffect(() => {
    let active = true;
    setWorkspaceLoading(true);
    client
      .listWorkspaces()
      .then((entries) => {
        if (!active) return;
        setWorkspaces(entries);
        setWorkspaceError(undefined);
        const activeEntries = entries.filter((workspace) => workspace.status === "active");
        setWorkspaceId((current) => {
          if (current && activeEntries.some((workspace) => workspace.id === current))
            return current;
          return activeEntries[0]?.id;
        });
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setWorkspaceError(describeMemoryError(caught));
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceToken]);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const requestId = ++listRequestRef.current;
    const key = memoryQueryKey(workspaceId, kind, status, tier, trust, sensitivity, scope);
    setListLoading(true);
    client
      .listMemoryItems(
        workspaceId,
        memoryListOptions(kind, status, tier, trust, sensitivity, scope),
      )
      .then((next) => {
        if (!active || requestId !== listRequestRef.current) return;
        setPage({
          key,
          items: next.items.map(quarantineSafeItem),
          nextCursor: next.next_cursor,
        });
        setListError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || requestId !== listRequestRef.current) return;
        setListError({ key, error: describeMemoryError(caught) });
      })
      .finally(() => {
        if (active && requestId === listRequestRef.current) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, kind, status, tier, trust, sensitivity, scope, listToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!workspaceId || !nextCursor || loadingMore) return;
    const requestId = listRequestRef.current;
    const key = memoryQueryKey(workspaceId, kind, status, tier, trust, sensitivity, scope);
    setLoadingMore(true);
    try {
      const next = await client.listMemoryItems(
        workspaceId,
        memoryListOptions(kind, status, tier, trust, sensitivity, scope, nextCursor),
      );
      if (requestId !== listRequestRef.current) return;
      const safeItems = next.items.map(quarantineSafeItem);
      setPage((current) => {
        if (current.key !== key) return current;
        const known = new Set(current.items.map((item) => item.item_id));
        return {
          key,
          items: [...current.items, ...safeItems.filter((item) => !known.has(item.item_id))],
          nextCursor: next.next_cursor,
        };
      });
      setListError(undefined);
    } catch (caught) {
      if (requestId === listRequestRef.current) {
        setListError({ key, error: describeMemoryError(caught) });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [client, workspaceId, nextCursor, loadingMore, kind, status, tier, trust, sensitivity, scope]);

  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === "active");
  const selectedWorkspace = activeWorkspaces.find((workspace) => workspace.id === workspaceId);
  const filtersActive =
    kind !== "all" ||
    status !== "all" ||
    tier !== "all" ||
    trust !== "all" ||
    sensitivity !== "all" ||
    scope.teamId !== "" ||
    scope.pathPrefix !== "" ||
    scope.language !== "" ||
    scope.taskFamily !== "";

  function selectItem(item: MemoryItem): void {
    if (!workspaceId) return;
    setSelection({ workspaceId, item: quarantineSafeItem(item) });
    setMobileView("detail");
  }

  function backToList(): void {
    setSelection(undefined);
    setMobileView("list");
  }

  function changeWorkspace(nextId: string): void {
    setWorkspaceId(nextId);
    setMobileView("list");
  }

  /** After a governance transition: adopt the server's view, then re-read the list. */
  const applyGovernedItem = useCallback(
    (next: MemoryItem): void => {
      setSelection((current) =>
        current !== undefined && current.workspaceId === workspaceId
          ? { workspaceId: current.workspaceId, item: quarantineSafeItem(next) }
          : current,
      );
      setListToken((value) => value + 1);
    },
    [workspaceId],
  );

  function applyScope(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setScope({
      teamId: scopeDraft.teamId.trim(),
      pathPrefix: scopeDraft.pathPrefix.trim(),
      language: scopeDraft.language.trim(),
      taskFamily: scopeDraft.taskFamily.trim(),
    });
    backToList();
  }

  function resetFilters(): void {
    setKind("all");
    setStatus("all");
    setTier("all");
    setTrust("all");
    setSensitivity("all");
    setScope(EMPTY_SCOPE);
    setScopeDraft(EMPTY_SCOPE);
    backToList();
  }

  const workspaceUnavailable =
    workspaceError !== undefined && (workspaceError.status === 404 || workspaceError.status === 0);

  return (
    <div className="workspace memory-workspace" data-view={mobileView}>
      <aside className="sidebar memory-sidebar">
        <div className="sidebar-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>Memory</h1>
          </div>
          <div className="memory-heading-actions">
            <span className="task-count">{items.length}</span>
            <button
              type="button"
              className="button button-quiet button-small"
              aria-label="Refresh memory list"
              disabled={!workspaceId || listLoading}
              onClick={() => setListToken((value) => value + 1)}
            >
              ↻
            </button>
          </div>
        </div>

        {activeWorkspaces.length > 1 && (
          <div className="workspace-picker" role="group" aria-label="Workspace scope">
            <label className="field-label" htmlFor="memory-workspace">
              Workspace scope
            </label>
            <Select
              id="memory-workspace"
              value={workspaceId ?? ""}
              onChange={changeWorkspace}
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

        <div className="memory-filters" role="group" aria-label="Memory filters">
          <div className="memory-filter">
            <label className="field-label" htmlFor="memory-kind-filter">
              Kind
            </label>
            <Select
              id="memory-kind-filter"
              value={kind}
              onChange={(value) => {
                setKind(value as KindFilter);
                backToList();
              }}
              options={[{ value: "all", label: "All kinds" }, ...KIND_OPTIONS]}
            />
          </div>
          <div className="memory-filter">
            <label className="field-label" htmlFor="memory-status-filter">
              Status
            </label>
            <Select
              id="memory-status-filter"
              value={status}
              onChange={(value) => {
                setStatus(value as StatusFilter);
                backToList();
              }}
              options={[{ value: "all", label: "All statuses" }, ...STATUS_OPTIONS]}
            />
          </div>
          <div className="memory-filter">
            <label className="field-label" htmlFor="memory-tier-filter">
              Tier
            </label>
            <Select
              id="memory-tier-filter"
              value={tier}
              onChange={(value) => {
                setTier(value as TierFilter);
                backToList();
              }}
              options={[{ value: "all", label: "All tiers" }, ...TIER_OPTIONS]}
            />
          </div>
          <div className="memory-filter">
            <label className="field-label" htmlFor="memory-trust-filter">
              Trust
            </label>
            <Select
              id="memory-trust-filter"
              value={trust}
              onChange={(value) => {
                setTrust(value as TrustFilter);
                backToList();
              }}
              options={[{ value: "all", label: "All trust classes" }, ...TRUST_OPTIONS]}
            />
          </div>
          <div className="memory-filter">
            <label className="field-label" htmlFor="memory-sensitivity-filter">
              Sensitivity
            </label>
            <Select
              id="memory-sensitivity-filter"
              value={sensitivity}
              onChange={(value) => {
                setSensitivity(value as SensitivityFilter);
                backToList();
              }}
              options={[
                { value: "all", label: "All visible sensitivities" },
                ...SENSITIVITY_OPTIONS,
              ]}
            />
          </div>

          <details className="memory-scope-filters">
            <summary>Scope filters</summary>
            <form className="memory-scope-form" onSubmit={applyScope}>
              <label className="memory-filter">
                <span className="field-label">Team id</span>
                <input
                  value={scopeDraft.teamId}
                  onChange={(event) =>
                    setScopeDraft((current) => ({ ...current, teamId: event.target.value }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className="memory-filter">
                <span className="field-label">Path prefix</span>
                <input
                  value={scopeDraft.pathPrefix}
                  onChange={(event) =>
                    setScopeDraft((current) => ({ ...current, pathPrefix: event.target.value }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className="memory-filter">
                <span className="field-label">Language</span>
                <input
                  value={scopeDraft.language}
                  onChange={(event) =>
                    setScopeDraft((current) => ({ ...current, language: event.target.value }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className="memory-filter">
                <span className="field-label">Task family</span>
                <input
                  value={scopeDraft.taskFamily}
                  onChange={(event) =>
                    setScopeDraft((current) => ({ ...current, taskFamily: event.target.value }))
                  }
                  autoComplete="off"
                />
              </label>
              <button type="submit" className="button button-quiet button-small">
                Apply scope filters
              </button>
            </form>
          </details>

          {filtersActive && (
            <button
              type="button"
              className="button button-quiet button-small"
              onClick={resetFilters}
            >
              Clear filters
            </button>
          )}
        </div>

        <div className="task-list" data-scroll="normal">
          {workspaceLoading ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>Resolving workspace scope…</p>
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
          ) : workspaceUnavailable ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>No workspace is visible to this credential, so no memory is readable.</p>
            </div>
          ) : !workspaceId ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>No active workspace is visible to this credential.</p>
            </div>
          ) : visibleListError ? (
            <div className="empty-sidebar">
              <div className="empty-icon">!</div>
              <p>
                {visibleListError.code}: {visibleListError.message}
              </p>
              {visibleListError.retryable && (
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => setListToken((value) => value + 1)}
                >
                  Retry
                </button>
              )}
            </div>
          ) : items.length === 0 ? (
            <div className="empty-sidebar">
              <div className="empty-icon">⌁</div>
              <p>
                {listLoading
                  ? "Reading workspace memory…"
                  : filtersActive
                    ? "No memory item matches these filters."
                    : "This workspace has no memory item at your sensitivity ceiling yet."}
              </p>
            </div>
          ) : (
            <>
              {items.map((item) => (
                <MemoryListItem
                  key={item.item_id}
                  item={item}
                  selected={item.item_id === selectedItemId}
                  onClick={() => selectItem(item)}
                />
              ))}
              {nextCursor ? (
                <button
                  type="button"
                  className="button button-quiet button-small load-more"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more items"}
                </button>
              ) : (
                <p className="memory-list-end">
                  End of list · {items.length} {items.length === 1 ? "item" : "items"}
                </p>
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
              <span>
                The service omits items above your role&apos;s sensitivity ceiling and withholds
                quarantined content; this view never fabricates or counts hidden items.
              </span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        {selectedItem && workspaceId ? (
          <MemoryItemDetail
            key={selectedItem.item_id}
            client={client}
            workspaceId={workspaceId}
            item={selectedItem}
            standing={standing}
            onBack={backToList}
            onItemUpdated={applyGovernedItem}
          />
        ) : (
          <section className="welcome-panel memory-welcome">
            <button type="button" className="detail-back" onClick={backToList}>
              ← Memory
            </button>
            <span className="eyebrow">Workspace memory</span>
            <h2>Read what the workspace remembers before you trust it.</h2>
            <p>
              Lessons, playbooks, facts, and policy are reference data with their evidence and
              applicability attached. Version history, named-human governance, and the audit
              timeline are served by the governance contract; this view never infers them locally.
            </p>
            <div className="welcome-principles">
              <span>Workspace-scoped</span>
              <span>Evidence attached</span>
              <span>Reference, not instruction</span>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function MemoryListItem({
  item,
  selected,
  onClick,
}: {
  item: MemoryItem;
  selected: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <article
      className={`task-list-item memory-list-item ${selected ? "task-list-item-selected" : ""}`}
    >
      <button type="button" className="task-list-open" onClick={onClick}>
        <div className="task-list-item-topline">
          <span className={`stage-pip stage-tone-${memoryStatusTone(item.status)}`} />
          <span className="task-list-status task-list-status-label">
            {MEMORY_STATUS_LABELS[item.status]}
          </span>
          <span className="task-list-time">{formatDate(item.updated_at)}</span>
        </div>
        <div className="task-list-summary memory-list-summary">
          {item.statement ?? "Content withheld while quarantined"}
        </div>
        <div className="task-list-repo memory-list-meta">
          <span>{MEMORY_KIND_LABELS[item.kind]}</span>
          <span className="divider">·</span>
          <span>{item.tier}</span>
          <span className="divider">·</span>
          <span>{MEMORY_SENSITIVITY_LABELS[item.sensitivity]}</span>
          <span className="divider">·</span>
          {isMemoryRedacted(item) ? (
            <span>Redacted</span>
          ) : (
            <span>
              {item.evidence.length} {item.evidence.length === 1 ? "citation" : "citations"}
            </span>
          )}
        </div>
      </button>
    </article>
  );
}
