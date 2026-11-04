import type { ReactElement } from "react";
import type { ErrorDescription } from "./identity-format";

interface ErrorNoticeProps {
  error: ErrorDescription;
  onDismiss?: () => void;
}

export function ErrorNotice({ error, onDismiss }: ErrorNoticeProps): ReactElement {
  return (
    <div className="inline-error identity-error" role="alert">
      <span>
        {error.message}
        {error.retryAfterSeconds !== undefined && ` Retry in ${error.retryAfterSeconds}s.`}
        {error.requestId && <span className="mono error-case">Case {error.requestId}</span>}
      </span>
      {onDismiss && (
        <button aria-label="Dismiss error" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
