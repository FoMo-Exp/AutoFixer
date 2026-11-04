import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ForgePilotClient, SecurityCase, SecurityCaseState, Workspace } from "../api/client";
import type { WorkspaceSession } from "../api/identity";
import { isEnterpriseAdmin } from "../workspaces/identity-format";
import { Select } from "../ui/Select";
import { SecurityCaseDetail } from "./SecurityCaseDetail";
import { SecurityRulesPanel } from "./SecurityRulesPanel";
import { SecurityAuditPanel } from "./SecurityAuditPanel";
import { SecurityEmptyState, SecurityErrorNotice } from "./SecurityNotice";
import {
  describeSecurityError,
  formatSecurityTime,
  SECURITY_CASE_STATE_LABELS,
  SECURITY_CASE_STATE_OPTIONS,
  SECURITY_CASE_STATE_TONES,
} from "./security-format";
import type { SecurityErrorDescription } from "./security-format";

type SecuritySection = "cases" | "rules" | "audit";
type CaseStateFilter = SecurityCaseState | "all";

const SECTION_LABELS: Record<SecuritySection, string> = {
  cases: "Cases",
  rules: "Rules",
  audit: "Audit",
};

interface CaseSelection {
  workspaceId: string;
  caseId: string;
  seed: SecurityCase;
}

/**
 * ADR-0005 security surface: redacted case inbox, disposition desk, versioned
 * rule corrections, and the audited trail. The surface deliberately offers no
 * "send anyway", retry-now, or administrator override control: the only way
 * out of a block is handling, independent review, and a complete recheck.
 */
export function SecurityWorkbench({
  client,
  session,
}: {
  client: ForgePilotClient;
  session: WorkspaceSession | undefined;
}): ReactElement {
  const [section, setSection] = useState<SecuritySection>("cases");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<SecurityErrorDescription>();
  const [workspaceToken, setWorkspaceToken] = useState(0);

  const [stateFilter, setStateFilter] = useState<CaseStateFilter>("all");
  const [runId, setRunId] = useState("");
  const [runDraft, setRunDraft] = useState("");
  const [cases, setCases] = useState<SecurityCase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<SecurityErrorDescription>();
  const [listToken, setListToken] = useState(0);
  const listRequestRef = useRef(0);

  const [selection, setSelection] = useState<CaseSelection>();
  const selectedCase =
    selection && selection.workspaceId === workspaceId
      ? (cases.find((entry) => entry.case_id === selection.caseId) ?? selection.seed)
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
        if (active) setWorkspaceError(describeSecurityError(caught));
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceToken]);

  useEffect(() => {
    if (!workspaceId) {
      setCases([]);
      setNextCursor(null);
      return;
    }
    let active = true;
    const requestId = ++listRequestRef.current;
    setListLoading(true);
    client
      .listSecurityCases(workspaceId, {
        ...(stateFilter === "all" ? {} : { state: stateFilter }),
        ...(runId ? { run_id: runId } : {}),
      })
      .then((page) => {
        if (!active || requestId !== listRequestRef.current) return;
        setCases(page.items);
        setNextCursor(page.next_cursor);
        setListError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || requestId !== listRequestRef.current) return;
        setListError(describeSecurityError(caught));
      })
      .finally(() => {
        if (active && requestId === listRequestRef.current) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, stateFilter, runId, listToken]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!workspaceId || !nextCursor || loadingMore) return;
    const requestId = listRequestRef.current;
    setLoadingMore(true);
    try {
      const page = await client.listSecurityCases(workspaceId, {
        ...(stateFilter === "all" ? {} : { state: stateFilter }),
        ...(runId ? { run_id: runId } : {}),
        cursor: nextCursor,
      });
      if (requestId !== listRequestRef.current) return;
      setCases((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (caught) {
      if (requestId === listRequestRef.current) setListError(describeSecurityError(caught));
    } finally {
      setLoadingMore(false);
    }
  }, [client, workspaceId, stateFilter, runId, nextCursor, loadingMore]);

  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === "active");
  const selectedWorkspace = activeWorkspaces.find((workspace) => workspace.id === workspaceId);
  const canAdminister = Boolean(
    selectedWorkspace && isEnterpriseAdmin(session, selectedWorkspace.enterprise_id),
  );

  function changeWorkspace(nextWorkspaceId: string): void {
    setWorkspaceId(nextWorkspaceId);
    setSelection(undefined);
  }

  function handleChanged(next: SecurityCase): void {
    setCases((current) => current.map((entry) => (entry.case_id === next.case_id ? next : entry)));
    if (selection?.caseId === next.case_id && workspaceId) {
      setSelection({ workspaceId, caseId: next.case_id, seed: next });
    }
  }

  return (
    <div className="security-surface">
      <div className="security-section-bar">
        <nav className="surface-nav" aria-label="Security views">
          {(Object.keys(SECTION_LABELS) as SecuritySection[]).map((entry) => (
            <button
              key={entry}
              type="button"
              className={`surface-tab ${section === entry ? "surface-tab-active" : ""}`}
              aria-current={section === entry ? "page" : undefined}
              onClick={() => setSection(entry)}
            >
              {SECTION_LABELS[entry]}
            </button>
          ))}
        </nav>
        <div className="security-section-meta">
          {activeWorkspaces.length > 1 && (
            <div className="workspace-picker security-workspace-picker">
              <label className="field-label" htmlFor="security-workspace">
                Workspace scope
              </label>
              <Select
                id="security-workspace"
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
              <span className="mono">{selectedWorkspace.name}</span>
              <span className={`role-chip role-${selectedWorkspace.role}`}>
                {selectedWorkspace.role}
              </span>
              <span className={`role-chip ${canAdminister ? "role-admin" : "role-viewer"}`}>
                {canAdminister ? "enterprise security administrator" : "duty enforced by service"}
              </span>
            </div>
          )}
        </div>
      </div>

      {workspaceError && (
        <div className="security-workspace-state">
          <SecurityErrorNotice
            error={workspaceError}
            onDismiss={() => setWorkspaceError(undefined)}
          />
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={() => setWorkspaceToken((value) => value + 1)}
          >
            Retry workspaces
          </button>
        </div>
      )}

      {!workspaceError && !workspaceLoading && !workspaceId && (
        <div className="security-workspace-state">
          <SecurityEmptyState>
            No active workspace is visible to this credential, so no security surface is readable.
          </SecurityEmptyState>
        </div>
      )}

      {workspaceId && section === "cases" && (
        <div className="workspace security-workspace" data-view={selectedCase ? "detail" : "list"}>
          <aside className="sidebar security-sidebar">
            <div className="sidebar-heading">
              <div>
                <span className="eyebrow">Redacted inbox</span>
                <h1>Security cases</h1>
              </div>
              <div className="memory-heading-actions">
                <span className="task-count">{cases.length}</span>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  aria-label="Refresh security cases"
                  disabled={listLoading}
                  onClick={() => setListToken((value) => value + 1)}
                >
                  ↻
                </button>
              </div>
            </div>

            <div className="memory-filters" role="group" aria-label="Case filters">
              <div className="memory-filter">
                <label className="field-label" htmlFor="security-state-filter">
                  State
                </label>
                <Select
                  id="security-state-filter"
                  value={stateFilter}
                  onChange={(value) => {
                    setStateFilter(value as CaseStateFilter);
                    setSelection(undefined);
                  }}
                  options={[{ value: "all", label: "All states" }, ...SECURITY_CASE_STATE_OPTIONS]}
                />
              </div>
              <div className="memory-filter">
                <label className="field-label" htmlFor="security-run-filter">
                  Run id
                </label>
                <form
                  className="security-inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setRunId(runDraft.trim());
                    setSelection(undefined);
                  }}
                >
                  <input
                    id="security-run-filter"
                    className="security-input mono"
                    placeholder="run_…"
                    value={runDraft}
                    onChange={(event) => setRunDraft(event.target.value)}
                  />
                  <button type="submit" className="button button-quiet button-small">
                    Apply
                  </button>
                </form>
              </div>
            </div>

            <div className="task-list" data-scroll="normal">
              {workspaceLoading ? (
                <SecurityEmptyState>Resolving workspace scope…</SecurityEmptyState>
              ) : listError ? (
                <SecurityEmptyState
                  icon="!"
                  action={
                    listError.retryable ? (
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        onClick={() => setListToken((value) => value + 1)}
                      >
                        Retry
                      </button>
                    ) : undefined
                  }
                >
                  {listError.code}: {listError.message}
                </SecurityEmptyState>
              ) : cases.length === 0 ? (
                <SecurityEmptyState>
                  {listLoading
                    ? "Reading security cases…"
                    : "No security case matches this scope and filter."}
                </SecurityEmptyState>
              ) : (
                <>
                  {cases.map((entry) => (
                    <article
                      key={entry.case_id}
                      className={`task-list-item security-case-item ${
                        selectedCase?.case_id === entry.case_id ? "task-list-item-selected" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="task-list-open"
                        onClick={() =>
                          setSelection({
                            workspaceId,
                            caseId: entry.case_id,
                            seed: entry,
                          })
                        }
                      >
                        <div className="task-list-item-topline">
                          <span
                            className={`stage-pip stage-tone-${SECURITY_CASE_STATE_TONES[entry.state]}`}
                          />
                          <span className="task-list-status task-list-status-label">
                            {SECURITY_CASE_STATE_LABELS[entry.state]}
                          </span>
                          <span className="task-list-time">
                            {formatSecurityTime(entry.updated_at)}
                          </span>
                        </div>
                        <div className="task-list-summary mono">{entry.case_id}</div>
                        <div className="task-list-repo">
                          <span>{entry.blocks[0]?.reason ?? "no block reason reported"}</span>
                          <span className="divider">·</span>
                          <span className="mono">run {entry.scope.run_id}</span>
                        </div>
                      </button>
                    </article>
                  ))}
                  {nextCursor && (
                    <button
                      type="button"
                      className="button button-quiet button-small load-more"
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                    >
                      {loadingMore ? "Loading…" : "Load more cases"}
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
                  <strong>Fail-closed</strong>
                  <span>
                    No per-call exception · quarantine needs a grant · every view is audited
                  </span>
                </div>
              </div>
            </div>
          </aside>

          <main className="main-panel">
            {selectedCase ? (
              <SecurityCaseDetail
                key={`${workspaceId}:${selectedCase.case_id}`}
                client={client}
                workspaceId={workspaceId}
                caseId={selectedCase.case_id}
                seed={selectedCase}
                userId={session?.user.id}
                canAdminister={canAdminister}
                onBack={() => setSelection(undefined)}
                onChanged={handleChanged}
              />
            ) : (
              <section className="welcome-panel security-welcome">
                <span className="eyebrow">Handling desk</span>
                <h2>Handle the block; never send around it.</h2>
                <p>
                  Cases expose redacted status, the block reason, and the audited history. Raw
                  quarantined context is a separate, granted, audited inspection. Recovery is one
                  independently approved recheck of the complete rebuilt request.
                </p>
                <div className="welcome-principles">
                  <span>Redacted by default</span>
                  <span>Separated duties</span>
                  <span>Complete recheck</span>
                </div>
              </section>
            )}
          </main>
        </div>
      )}

      {workspaceId && section === "rules" && (
        <SecurityRulesPanel
          client={client}
          workspaceId={workspaceId}
          userId={session?.user.id}
          canAdminister={canAdminister}
        />
      )}

      {workspaceId && section === "audit" && (
        <main className="main-panel security-audit-surface">
          <SecurityAuditPanel
            client={client}
            workspaceId={workspaceId}
            canAdminister={canAdminister}
          />
        </main>
      )}
    </div>
  );
}
