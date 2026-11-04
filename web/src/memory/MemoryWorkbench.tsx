import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  ForgePilotClient,
  MemoryItem,
  MemoryKind,
  MemoryStatus,
  MemoryTier,
  Workspace,
} from "../api/client";
import { formatDate } from "../ui/format";
import { redactText } from "../ui/redaction";
import { Select } from "../ui/Select";
import { MemoryItemDetail } from "./MemoryItemDetail";
import {
  describeMemoryError,
  MEMORY_KIND_LABELS,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_STATUS_LABELS,
  memoryStatusTone,
} from "./memory-format";
import type { MemoryError } from "./memory-format";

type KindFilter = "all" | MemoryKind;
type StatusFilter = "all" | MemoryStatus;
type TierFilter = "all" | MemoryTier;

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

/**
 * Identity of one browse query: workspace plus the three contract filters.
 * A page is only rendered while it belongs to the currently selected query, so
 * switching workspace can never show the previous workspace's items, not even
 * for the render before the new request settles.
 */
function memoryQueryKey(
  workspaceId: string | undefined,
  kind: KindFilter,
  status: StatusFilter,
  tier: TierFilter,
): string {
  return [workspaceId ?? "", kind, status, tier].join("\u0000");
}

/**
 * Read-only workspace memory browse. The panel is deliberately read-only: the
 * merged contract exposes no promotion, deprecation, quarantine, or diff route,
 * so this surface never offers one.
 */
export function MemoryWorkbench({ client }: { client: ForgePilotClient }): ReactElement {
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
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<{ key: string; error: MemoryError } | undefined>(
    undefined,
  );
  const [listToken, setListToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRequestRef = useRef(0);

  const queryKey = memoryQueryKey(workspaceId, kind, status, tier);
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
    const key = memoryQueryKey(workspaceId, kind, status, tier);
    setListLoading(true);
    client
      .listMemoryItems(workspaceId, {
        ...(kind === "all" ? {} : { kind }),
        ...(status === "all" ? {} : { status }),
        ...(tier === "all" ? {} : { tier }),
      })
      .then((next) => {
        if (!active || requestId !== listRequestRef.current) return;
        setPage({ key, items: next.items, nextCursor: next.next_cursor });
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
  }, [client, workspaceId, kind, status, tier, listToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!workspaceId || !nextCursor || loadingMore) return;
    const requestId = listRequestRef.current;
    const key = memoryQueryKey(workspaceId, kind, status, tier);
    setLoadingMore(true);
    try {
      const next = await client.listMemoryItems(workspaceId, {
        ...(kind === "all" ? {} : { kind }),
        ...(status === "all" ? {} : { status }),
        ...(tier === "all" ? {} : { tier }),
        cursor: nextCursor,
      });
      if (requestId !== listRequestRef.current) return;
      setPage((current) => {
        if (current.key !== key) return current;
        const known = new Set(current.items.map((item) => item.item_id));
        return {
          key,
          items: [...current.items, ...next.items.filter((item) => !known.has(item.item_id))],
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
  }, [client, workspaceId, nextCursor, loadingMore, kind, status, tier]);

  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === "active");
  const selectedWorkspace = activeWorkspaces.find((workspace) => workspace.id === workspaceId);
  const filtersActive = kind !== "all" || status !== "all" || tier !== "all";

  function selectItem(item: MemoryItem): void {
    if (!workspaceId) return;
    setSelection({ workspaceId, item });
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

  function resetFilters(): void {
    setKind("all");
    setStatus("all");
    setTier("all");
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
              <strong>Read-only, workspace-scoped</strong>
              <span>
                The service omits items above your role&apos;s sensitivity ceiling; this view never
                fabricates or counts them.
              </span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        {selectedItem ? (
          <MemoryItemDetail key={selectedItem.item_id} item={selectedItem} onBack={backToList} />
        ) : (
          <section className="welcome-panel memory-welcome">
            <button type="button" className="detail-back" onClick={backToList}>
              ← Memory
            </button>
            <span className="eyebrow">Workspace memory</span>
            <h2>Read what the workspace remembers before you trust it.</h2>
            <p>
              Lessons, playbooks, facts, and policy are reference data with their evidence and
              applicability attached. Nothing here can promote, deprecate, or quarantine an item;
              governance actions live in a separate contract.
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
        <div className="task-list-summary memory-list-summary">{item.statement}</div>
        <div className="task-list-repo memory-list-meta">
          <span>{MEMORY_KIND_LABELS[item.kind]}</span>
          <span className="divider">·</span>
          <span>{item.tier}</span>
          <span className="divider">·</span>
          <span>{MEMORY_SENSITIVITY_LABELS[item.sensitivity]}</span>
          <span className="divider">·</span>
          <span>
            {item.evidence.length} {item.evidence.length === 1 ? "citation" : "citations"}
          </span>
        </div>
      </button>
    </article>
  );
}
