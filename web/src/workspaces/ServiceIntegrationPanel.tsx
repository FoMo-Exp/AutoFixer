import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type {
  IdentityClient,
  InitializeServiceIntegrationBody,
  ServiceIntegration,
  ServiceIntegrationStatus,
  ServicePermissionVisibility,
  Workspace,
} from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import { describeError, formatTimestamp } from "./identity-format";

interface ServiceIntegrationPanelProps {
  client: IdentityClient;
  workspace: Workspace;
  /**
   * Enterprise-administrator authority projected from the session. The server
   * remains the authority: a stale projection still renders its 403.
   */
  canConfigure: boolean;
}

const STATUS_LABELS: Record<ServiceIntegrationStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  uninstalled: "Uninstalled",
};

const VISIBILITY_LABELS: Record<ServicePermissionVisibility, string> = {
  full: "Full",
  partial: "Partial",
  none: "None",
};

interface CredentialRefs {
  source: string;
  checkout: string;
  delivery: string;
}

const EMPTY_REFS: CredentialRefs = { source: "", checkout: "", delivery: "" };

/**
 * The contract's credential reference shape: 1-200 characters, starting with a
 * letter or digit, then letters, digits, `.`, `_`, `:`, `/`, or `-`.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** Same well-known token prefixes the server refuses before storing a value. */
const SECRET_LIKE_PATTERN = /^(gh[pousr]_|github_pat_|glpat-|xox[abposr]-)/i;

/**
 * Local guard so a pasted secret never leaves the renderer. The server repeats
 * these checks; this one only mirrors its published reference shape.
 */
export function credentialRefIssue(value: string, required: boolean): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return required ? "Enter a credential reference." : undefined;
  }
  if (trimmed.length > 200) return "Use at most 200 characters.";
  if (!REFERENCE_PATTERN.test(trimmed)) {
    return "Use letters, digits, and . _ : / - only, starting with a letter or digit.";
  }
  if (SECRET_LIKE_PATTERN.test(trimmed)) {
    return "This looks like a secret value. Enter its credential reference name instead.";
  }
  return undefined;
}

function IntegrationFacts({ integration }: { integration: ServiceIntegration }): ReactElement {
  const statusClass =
    integration.install_status === "active"
      ? "identity-badge identity-badge-active"
      : "identity-badge identity-badge-warn";
  const visibilityClass =
    integration.permission_visibility === "full"
      ? "identity-badge identity-badge-active"
      : "identity-badge identity-badge-warn";
  const capabilities = [
    { key: "source", label: "Source" },
    { key: "checkout", label: "Checkout" },
    { key: "delivery", label: "Delivery" },
  ] as const;

  return (
    <ul className="identity-list" aria-label="Service integration">
      <li className="identity-row">
        <div className="identity-row-main">
          <span className="identity-meta">Repository</span>
          <div className="identity-row-title">
            <strong>{integration.repository_name}</strong>
            <span className="mono identity-id">{integration.repository_id}</span>
          </div>
        </div>
        <div className="identity-row-actions">
          <span className={statusClass}>{STATUS_LABELS[integration.install_status]}</span>
        </div>
      </li>
      <li className="identity-row">
        <div className="identity-row-main">
          <span className="identity-meta">Provider instance</span>
          <span className="mono identity-id">{integration.provider_instance_id}</span>
        </div>
        <div className="identity-row-actions">
          <span className={visibilityClass}>
            {`Visibility: ${VISIBILITY_LABELS[integration.permission_visibility]}`}
          </span>
        </div>
      </li>
      <li className="identity-row">
        <div className="identity-row-main">
          <span className="identity-meta">Configured credential capabilities</span>
          <div className="identity-row-title">
            {capabilities.map((capability) => (
              <span
                className={
                  integration.credentials[capability.key]
                    ? "identity-badge identity-badge-active"
                    : "identity-badge"
                }
                key={capability.key}
              >
                {`${capability.label}: ${integration.credentials[capability.key] ? "configured" : "not configured"}`}
              </span>
            ))}
          </div>
        </div>
      </li>
      <li className="identity-row">
        <div className="identity-row-main">
          <span className="identity-meta">Updated</span>
          <span className="identity-meta">
            {`${formatTimestamp(integration.updated_at)} · version ${integration.version}`}
          </span>
        </div>
      </li>
    </ul>
  );
}

export function ServiceIntegrationPanel({
  client,
  workspace,
  canConfigure,
}: ServiceIntegrationPanelProps): ReactElement {
  const [integration, setIntegration] = useState<ServiceIntegration>();
  const [loading, setLoading] = useState(true);
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [deactivated, setDeactivated] = useState(false);
  const [pendingDeactivate, setPendingDeactivate] = useState(false);
  const [refs, setRefs] = useState<CredentialRefs>(EMPTY_REFS);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CredentialRefs, string>>>({});
  const [error, setError] = useState<ErrorDescription>();
  const [notice, setNotice] = useState<string>();
  const requestRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const current = await client.getServiceIntegration(workspace.enterprise_id, workspace.id);
      if (requestRef.current !== requestId) return;
      setIntegration(current);
      setDeactivated(false);
      setResolved(true);
      setError(undefined);
    } catch (caught) {
      if (requestRef.current !== requestId) return;
      const described = describeError(caught);
      setIntegration(undefined);
      if (described.code === "SERVICE_INTEGRATION_NOT_FOUND") {
        // No active integration is the empty state, not a failure.
        setResolved(true);
        setError(undefined);
        return;
      }
      setResolved(false);
      if (described.code === "FORBIDDEN") setDenied(true);
      setError(described);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [client, workspace.enterprise_id, workspace.id]);

  useEffect(() => {
    setIntegration(undefined);
    setDeactivated(false);
    setResolved(false);
    setDenied(false);
    setPendingDeactivate(false);
    setRefs(EMPTY_REFS);
    setFieldErrors({});
    setError(undefined);
    setNotice(undefined);
    void load();
  }, [load]);

  async function initialize(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const issues: Partial<Record<keyof CredentialRefs, string>> = {};
    const source = credentialRefIssue(refs.source, true);
    const checkout = credentialRefIssue(refs.checkout, false);
    const delivery = credentialRefIssue(refs.delivery, false);
    if (source) issues.source = source;
    if (checkout) issues.checkout = checkout;
    if (delivery) issues.delivery = delivery;
    setFieldErrors(issues);
    if (Object.keys(issues).length > 0) return;

    const body: InitializeServiceIntegrationBody = {
      source_credential_ref: refs.source.trim(),
      ...(refs.checkout.trim() === "" ? {} : { checkout_credential_ref: refs.checkout.trim() }),
      ...(refs.delivery.trim() === "" ? {} : { delivery_credential_ref: refs.delivery.trim() }),
    };
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await client.initializeServiceIntegration(
        workspace.enterprise_id,
        workspace.id,
        body,
      );
      setIntegration(result);
      setDeactivated(false);
      setResolved(true);
      setRefs(EMPTY_REFS);
      setFieldErrors({});
      setError(undefined);
      setNotice("Service integration is active for this workspace.");
    } catch (caught) {
      const described = describeError(caught);
      // A different active configuration exists; show the server's row so the
      // operator can deactivate it instead of retrying blindly. The reload
      // clears the error, so the conflict message is restored after it.
      if (described.code === "SERVICE_INTEGRATION_EXISTS") await load();
      setError(described);
      if (described.code === "FORBIDDEN") setDenied(true);
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(): Promise<void> {
    setBusy(true);
    setNotice(undefined);
    try {
      await client.deactivateServiceIntegration(workspace.enterprise_id, workspace.id);
      setIntegration(undefined);
      setPendingDeactivate(false);
      setDeactivated(true);
      setError(undefined);
      setNotice(
        "Service integration deactivated. Ordinary workspace requests now fail closed until it is initialized again.",
      );
    } catch (caught) {
      const described = describeError(caught);
      setError(described);
      if (described.code === "FORBIDDEN") setDenied(true);
    } finally {
      setBusy(false);
    }
  }

  const active = integration?.install_status === "active";
  const archived = workspace.status === "archived";
  const blocked =
    error !== undefined &&
    (error.code === "FORBIDDEN" ||
      error.code === "NOT_FOUND" ||
      error.code === "WORKSPACE_ARCHIVED" ||
      error.code === "SERVICE_INTEGRATION_BINDING_INVALID");
  const mayConfigure = canConfigure && !denied && !archived && !blocked && resolved;

  return (
    <div className="identity-panel">
      {!canConfigure && (
        <p className="identity-panel-status">
          Read-only. Enterprise administrator authority is required to change the service
          integration.
        </p>
      )}
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {notice && (
        <p className="identity-panel-status" role="status">
          {notice}
        </p>
      )}
      {loading && integration === undefined ? (
        <p className="card-empty">Loading service integration…</p>
      ) : (
        <>
          {integration ? (
            <IntegrationFacts integration={integration} />
          ) : (
            <p className="identity-panel-status">
              {deactivated
                ? "Deactivated. The workspace keeps a fail-closed authority marker; ordinary requests are refused until the integration is initialized again."
                : "No active service integration. Until one is initialized, ordinary workspace requests fail closed."}
            </p>
          )}
          {integration && integration.install_status !== "active" && (
            <p className="identity-panel-status">
              Inactive. Ordinary workspace requests fail closed.
            </p>
          )}
          {archived && (
            <p className="identity-panel-status">
              This workspace is archived, so it cannot carry a service integration.
            </p>
          )}
          {active
            ? mayConfigure &&
              (pendingDeactivate ? (
                <div className="identity-form-actions">
                  <span className="identity-meta">
                    Ordinary workspace requests fail closed until re-initialization.
                  </span>
                  <button
                    className="button button-small button-danger"
                    disabled={busy}
                    onClick={() => void deactivate()}
                  >
                    {busy ? "Deactivating…" : "Confirm deactivate"}
                  </button>
                  <button
                    className="button button-small button-quiet"
                    disabled={busy}
                    onClick={() => setPendingDeactivate(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="identity-form-actions">
                  <button
                    className="button button-small button-danger"
                    disabled={busy}
                    onClick={() => setPendingDeactivate(true)}
                  >
                    Deactivate
                  </button>
                </div>
              ))
            : mayConfigure && (
                <form className="identity-form" onSubmit={(event) => void initialize(event)}>
                  <span className="eyebrow">Initialize service integration</span>
                  <div className="identity-form-grid">
                    <label>
                      <span className="label-text">Source credential reference</span>
                      <input
                        value={refs.source}
                        maxLength={200}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={fieldErrors.source ? "true" : undefined}
                        onChange={(event) => {
                          setRefs((current) => ({ ...current, source: event.target.value }));
                          setFieldErrors((current) => ({ ...current, source: undefined }));
                        }}
                      />
                      {fieldErrors.source && (
                        <span className="identity-field-error" role="alert">
                          {fieldErrors.source}
                        </span>
                      )}
                    </label>
                    <label>
                      <span className="label-text">Checkout credential reference (optional)</span>
                      <input
                        value={refs.checkout}
                        maxLength={200}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={fieldErrors.checkout ? "true" : undefined}
                        onChange={(event) => {
                          setRefs((current) => ({ ...current, checkout: event.target.value }));
                          setFieldErrors((current) => ({ ...current, checkout: undefined }));
                        }}
                      />
                      {fieldErrors.checkout && (
                        <span className="identity-field-error" role="alert">
                          {fieldErrors.checkout}
                        </span>
                      )}
                    </label>
                    <label>
                      <span className="label-text">Delivery credential reference (optional)</span>
                      <input
                        value={refs.delivery}
                        maxLength={200}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={fieldErrors.delivery ? "true" : undefined}
                        onChange={(event) => {
                          setRefs((current) => ({ ...current, delivery: event.target.value }));
                          setFieldErrors((current) => ({ ...current, delivery: undefined }));
                        }}
                      />
                      {fieldErrors.delivery && (
                        <span className="identity-field-error" role="alert">
                          {fieldErrors.delivery}
                        </span>
                      )}
                    </label>
                  </div>
                  <div className="identity-form-actions">
                    <button
                      className="button button-small button-primary"
                      type="submit"
                      disabled={busy}
                    >
                      {busy ? "Initializing…" : "Initialize integration"}
                    </button>
                    <span className="identity-meta">
                      Credential references only; secrets are rejected.
                    </span>
                  </div>
                </form>
              )}
        </>
      )}
    </div>
  );
}
