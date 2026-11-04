import type { ReactElement, ReactNode } from "react";
import type { SecurityErrorDescription } from "./security-format";

/**
 * One redacted error surface for the security screens. It prints only what the
 * stable envelope carries: code, safe message, request/trace reference, retry
 * hint, and the single authorized next action. It never echoes a payload.
 */
export function SecurityErrorNotice({
  error,
  onDismiss,
}: {
  error: SecurityErrorDescription;
  onDismiss?: () => void;
}): ReactElement {
  return (
    <div className="inline-error identity-error" role="alert">
      <span>
        <strong>{error.code}</strong> {error.message}
        {error.retryAfterSeconds !== undefined && ` Retry in ${error.retryAfterSeconds}s.`}
        {error.requestId && <span className="mono error-case">Request {error.requestId}</span>}
        {error.traceRef && <span className="mono error-case">Trace {error.traceRef}</span>}
        {error.nextAction && <span className="security-next-action">Next: {error.nextAction}</span>}
      </span>
      {onDismiss && (
        <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

/** Loading/empty/permission state with an optional bounded retry affordance. */
export function SecurityEmptyState({
  icon = "⌁",
  children,
  action,
}: {
  icon?: string;
  children: ReactNode;
  action?: ReactElement;
}): ReactElement {
  return (
    <div className="empty-sidebar">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <p>{children}</p>
      {action}
    </div>
  );
}
