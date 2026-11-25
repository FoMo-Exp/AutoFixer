import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  EnterpriseUser,
  EnterpriseUserStatus,
  IdentityClient,
  LoginProvider,
  Workspace,
} from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import {
  ENTERPRISE_ROLE_LABELS,
  ENTERPRISE_STATUS_LABELS,
  describeError,
  formatTimestamp,
} from "./identity-format";
import { Select } from "../ui/Select";
import { EnterpriseWorkspaceGrant } from "./EnterpriseWorkspaceGrant";

interface EnterpriseUsersPanelProps {
  client: IdentityClient;
  enterpriseId: string;
  workspaces: Workspace[];
  canAddUser: boolean;
  canSuspendUser: boolean;
  canRestoreUser: boolean;
  canChangeRole: boolean;
  canGrantWorkspace: boolean;
}

const STATUS_FILTERS: Array<{ value: "" | EnterpriseUserStatus; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "pending_claim", label: "Pending sign-in" },
  { value: "suspended", label: "Suspended" },
];

const ROLE_OPTIONS = [
  { value: "member", label: ENTERPRISE_ROLE_LABELS.member },
  { value: "admin", label: ENTERPRISE_ROLE_LABELS.admin },
];

export function EnterpriseUsersPanel({
  client,
  enterpriseId,
  workspaces,
  canAddUser,
  canSuspendUser,
  canRestoreUser,
  canChangeRole,
  canGrantWorkspace,
}: EnterpriseUsersPanelProps): ReactElement {
  const [users, setUsers] = useState<EnterpriseUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | EnterpriseUserStatus>("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<ErrorDescription>();
  const [notice, setNotice] = useState<string>();
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [subject, setSubject] = useState("");
  const [adding, setAdding] = useState(false);
  const [grantUserId, setGrantUserId] = useState<string>();
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      const requestId = ++requestRef.current;
      setLoading(true);
      try {
        const page = await client.listEnterpriseUsers(enterpriseId, {
          ...(status === "" ? {} : { status }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (requestRef.current !== requestId) return;
        setUsers((current) => (cursor === undefined ? page.items : [...current, ...page.items]));
        setNextCursor(page.next_cursor);
        setError(undefined);
      } catch (caught) {
        if (requestRef.current === requestId) setError(describeError(caught));
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    },
    [client, enterpriseId, status],
  );

  useEffect(() => {
    setUsers([]);
    setNextCursor(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!canAddUser) return;
    let active = true;
    void client
      .listLoginProviders()
      .then((items) => {
        if (!active) return;
        setProviders(items);
        setProviderId((current) => current || (items[0]?.provider_instance_id ?? ""));
      })
      .catch((caught) => {
        if (active) setError(describeError(caught));
      });
    return () => {
      active = false;
    };
  }, [canAddUser, client]);

  const providerLabels = useMemo(
    () =>
      new Map(
        providers.map((provider) => [
          provider.provider_instance_id,
          `${provider.provider_type} · ${provider.display_origin}`,
        ]),
      ),
    [providers],
  );

  const visibleUsers = query.trim()
    ? users.filter((user) => {
        const needle = query.trim().toLowerCase();
        return [user.display_name, user.login, user.subject, user.user_id].some((value) =>
          value?.toLowerCase().includes(needle),
        );
      })
    : users;

  function replaceUser(updated: EnterpriseUser): void {
    setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function changeRole(user: EnterpriseUser, role: string): Promise<void> {
    if (user.version === undefined || role === user.role) return;
    setBusyId(user.id);
    try {
      const updated = await client.setEnterpriseUserRole(enterpriseId, user.id, {
        role: role as EnterpriseUser["role"],
        version: user.version,
      });
      replaceUser(updated);
      setNotice(
        `${updated.display_name ?? updated.subject} is now ${ENTERPRISE_ROLE_LABELS[updated.role]}.`,
      );
      setError(undefined);
    } catch (caught) {
      const described = describeError(caught);
      // Reload first: the reload clears the notice, so the conflict must be
      // set afterwards or it never reaches the reader.
      if (described.code === "VERSION_CONFLICT") await load();
      setError(described);
    } finally {
      setBusyId(undefined);
    }
  }

  async function toggleStatus(user: EnterpriseUser): Promise<void> {
    if (user.version === undefined) return;
    setBusyId(user.id);
    try {
      const next = user.status === "suspended" ? "active" : "suspended";
      const updated = await client.setEnterpriseUserStatus(
        enterpriseId,
        user.id,
        next,
        user.version,
      );
      replaceUser(updated);
      setNotice(
        next === "suspended"
          ? `${updated.display_name ?? updated.subject} is suspended in this enterprise only.`
          : `${updated.display_name ?? updated.subject} is restored in this enterprise.`,
      );
      setError(undefined);
    } catch (caught) {
      const described = describeError(caught);
      // Reload first: the reload clears the notice, so the conflict must be
      // set afterwards or it never reaches the reader.
      if (described.code === "VERSION_CONFLICT") await load();
      setError(described);
    } finally {
      setBusyId(undefined);
    }
  }

  async function addUser(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAdding(true);
    try {
      const created = await client.addEnterpriseUser(enterpriseId, {
        provider_instance_id: providerId,
        subject: subject.trim(),
      });
      setNotice(
        created.created
          ? `Added ${created.enterprise_user.display_name ?? created.enterprise_user.subject}. They stay pending until they sign in.`
          : "That provider subject is already in this enterprise directory.",
      );
      setSubject("");
      setShowAdd(false);
      setError(undefined);
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="identity-panel">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {notice && (
        <p className="identity-panel-status" role="status">
          {notice}
        </p>
      )}
      <p className="identity-meta">
        This directory is enterprise-scoped. Suspending a person here never suspends their global
        account; a global suspension is a separate account action and stays unchanged.
      </p>
      {canAddUser && (
        <div className="identity-form-actions">
          <button
            className="button button-small button-secondary"
            onClick={() => setShowAdd((current) => !current)}
            aria-expanded={showAdd}
          >
            {showAdd ? "Close add form" : "Add person"}
          </button>
        </div>
      )}
      {canAddUser && showAdd && (
        <form className="identity-form" onSubmit={(event) => void addUser(event)}>
          <div className="identity-form-grid">
            <label>
              <span className="label-text">Approved provider instance</span>
              <Select
                value={providerId}
                options={providers.map((provider) => ({
                  value: provider.provider_instance_id,
                  label:
                    providerLabels.get(provider.provider_instance_id) ??
                    provider.provider_instance_id,
                }))}
                onChange={setProviderId}
                ariaLabel="Provider instance"
              />
            </label>
            <label>
              <span className="label-text">Stable provider subject</span>
              <input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="e.g. 424242"
                required
                maxLength={256}
              />
            </label>
          </div>
          <span className="identity-meta">
            The stable provider subject (for example the numeric GitHub user ID) is the only match
            key. Email, login, and display name are never used to claim an account.
          </span>
          <div className="identity-form-actions">
            <button
              className="button button-small button-primary"
              type="submit"
              disabled={adding || providerId === "" || subject.trim() === ""}
            >
              {adding ? "Adding…" : "Add to enterprise"}
            </button>
          </div>
        </form>
      )}
      <div className="identity-form-grid">
        <label>
          <span className="label-text">Status</span>
          <Select
            value={status}
            options={STATUS_FILTERS}
            onChange={(value) => setStatus(value as "" | EnterpriseUserStatus)}
            ariaLabel="Directory status"
          />
        </label>
        <label>
          <span className="label-text">Search loaded people</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, login, subject, or account id"
          />
        </label>
      </div>
      <div className="identity-list-heading">
        <span className="eyebrow">Enterprise people</span>
        <span className="event-count">{visibleUsers.length}</span>
      </div>
      {loading && users.length === 0 ? (
        <p className="card-empty">Loading enterprise directory…</p>
      ) : visibleUsers.length === 0 ? (
        <p className="card-empty">
          {query.trim() === ""
            ? "No people match this status filter."
            : "No loaded entry matches this search."}
        </p>
      ) : (
        <ul className="identity-list">
          {visibleUsers.map((user) => {
            const label = user.display_name ?? user.login ?? `Subject ${user.subject}`;
            const expanded = grantUserId === user.id;
            return (
              <li className="identity-row" key={user.id}>
                <div className="identity-row-main">
                  <div className="identity-row-title">
                    <strong>{label}</strong>
                    <span className="mono identity-id">{user.subject}</span>
                    <span className={`identity-badge identity-badge-${user.status}`}>
                      {ENTERPRISE_STATUS_LABELS[user.status]}
                    </span>
                    <span className="identity-badge">{ENTERPRISE_ROLE_LABELS[user.role]}</span>
                  </div>
                  <span className="identity-meta">
                    {providerLabels.get(user.provider_instance_id) ??
                      `${user.provider_type} · ${user.provider_instance_id}`}
                    {user.login ? ` · @${user.login}` : ""}
                    {user.claimed_at
                      ? ` · Signed in ${formatTimestamp(user.claimed_at)}`
                      : " · No account yet"}
                    {user.suspended_at ? ` · Suspended ${formatTimestamp(user.suspended_at)}` : ""}
                  </span>
                  <span className="identity-meta mono">{user.user_id ?? "No account id yet"}</span>
                </div>
                <div className="identity-row-actions">
                  {canChangeRole ? (
                    <Select
                      value={user.role}
                      options={ROLE_OPTIONS}
                      onChange={(value) => void changeRole(user, value)}
                      disabled={busyId === user.id || user.status === "pending_claim"}
                      ariaLabel={`Enterprise role for ${label}`}
                      className="identity-role-select"
                    />
                  ) : (
                    <span className="identity-badge">{ENTERPRISE_ROLE_LABELS[user.role]}</span>
                  )}
                  {user.status === "pending_claim" && (
                    <span className="identity-meta">Role changes after sign-in</span>
                  )}
                  {canGrantWorkspace && user.user_id !== null && (
                    <button
                      className="button button-small button-quiet"
                      aria-expanded={expanded}
                      onClick={() => setGrantUserId(expanded ? undefined : user.id)}
                    >
                      Workspace access
                    </button>
                  )}
                  {user.status === "active" && canSuspendUser && (
                    <button
                      className="button button-small button-quiet identity-destructive"
                      disabled={busyId === user.id}
                      onClick={() => void toggleStatus(user)}
                    >
                      Suspend in enterprise
                    </button>
                  )}
                  {user.status === "suspended" && canRestoreUser && (
                    <button
                      className="button button-small button-secondary"
                      disabled={busyId === user.id}
                      onClick={() => void toggleStatus(user)}
                    >
                      Restore in enterprise
                    </button>
                  )}
                </div>
                {expanded && user.user_id !== null && (
                  <EnterpriseWorkspaceGrant
                    client={client}
                    enterpriseId={enterpriseId}
                    user={user}
                    workspaces={workspaces}
                    onGranted={(workspaceName) => {
                      setNotice(`${label} was granted access to ${workspaceName}.`);
                      setError(undefined);
                    }}
                    onError={(caught) => setError(describeError(caught))}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor && (
        <button
          className="button button-small button-quiet identity-load-more"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? "Loading…" : "Load more people"}
        </button>
      )}
      {query.trim() !== "" && nextCursor && (
        <p className="identity-meta">Search covers loaded entries only; load more to widen it.</p>
      )}
    </div>
  );
}
