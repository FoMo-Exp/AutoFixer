import type { ReactElement } from "react";
import { capabilityReasonLabel } from "./projection";
import type { CapabilityFailure, CapabilityLoadStatus } from "./use-capabilities";
import type { CapabilityModule } from "./projection";
import { MODULE_LABELS } from "./projection";

/**
 * Fail-closed screens for the capability projection. They never reuse a
 * previous workspace's data or offer a control whose action the projection
 * denied.
 */
export function CapabilityUnavailableScreen({
  status,
  error,
  workspaceName,
  refreshing,
  onRetry,
}: {
  status: CapabilityLoadStatus;
  error?: CapabilityFailure;
  workspaceName?: string;
  refreshing: boolean;
  onRetry: () => void;
}): ReactElement {
  const loading = status === "loading" || (status === "ready" && refreshing);
  const title = loading
    ? "Verifying workspace capabilities"
    : "Workspace capabilities are unavailable";
  const message = loading
    ? "Module entries load only after the service verifies the repository capability intersection."
    : (error?.message ??
      "The capability projection could not be read, so no module data is shown.");
  return (
    <main className="workspace-home" aria-labelledby="capability-unavailable-title">
      <section className="workspace-home-card">
        <span className="eyebrow">Fail closed</span>
        <h1 id="capability-unavailable-title">{title}</h1>
        <p>{workspaceName ? `${workspaceName}: ${message}` : message}</p>
        {error && error.code !== "CAPABILITY_UNAVAILABLE" && (
          <p className="identity-meta mono">
            {error.code}
            {error.status > 0 ? ` · HTTP ${error.status}` : ""}
          </p>
        )}
        <div className="workspace-home-actions">
          <button className="button button-secondary" onClick={onRetry} disabled={loading}>
            {loading ? "Verifying…" : "Retry capability check"}
          </button>
        </div>
      </section>
    </main>
  );
}

export function ModuleDeniedScreen({
  module,
  reason,
  onHome,
}: {
  module: CapabilityModule;
  reason: string | null;
  onHome: () => void;
}): ReactElement {
  return (
    <main className="workspace-home" aria-labelledby="module-denied-title">
      <section className="workspace-home-card">
        <span className="eyebrow">Module unavailable</span>
        <h1 id="module-denied-title">{MODULE_LABELS[module]}</h1>
        <p>{capabilityReasonLabel(reason)}</p>
        <p className="identity-meta">
          The service still checks every request. This entry is hidden for this session and is
          re-read when the window regains focus or the projection expires.
        </p>
        <div className="workspace-home-actions">
          <button className="button button-secondary" onClick={onHome}>
            Back to workspace home
          </button>
        </div>
      </section>
    </main>
  );
}

export function ModuleNoDataScreen({
  module,
  reason,
  onRetry,
}: {
  module: CapabilityModule;
  reason: string | null;
  onRetry: () => void;
}): ReactElement {
  return (
    <main className="workspace-home" aria-labelledby="module-nodata-title">
      <section className="workspace-home-card">
        <span className="eyebrow">No verified data</span>
        <h1 id="module-nodata-title">{MODULE_LABELS[module]}</h1>
        <p>{capabilityReasonLabel(reason)}</p>
        <p className="identity-meta">
          The module stays visible because your role can enter it, but no read request is issued
          until the service can verify the repository capability set.
        </p>
        <div className="workspace-home-actions">
          <button className="button button-secondary" onClick={onRetry}>
            Re-check capabilities
          </button>
        </div>
      </section>
    </main>
  );
}
