import { useId } from "react";
import type { ReactElement } from "react";
import { shortId } from "../ui/format";
import type { TaskTargetView } from "./task-target";
import {
  hasTrustedBaseline,
  singleCandidate,
  targetBlockedMessage,
  targetLabel,
} from "./task-target";

interface TaskTargetFieldProps {
  view: TaskTargetView;
  selectedBindingId: string;
  conflict?: string;
  onSelect: (bindingId: string) => void;
  onRetry: () => void;
}

/**
 * The create dialog's repository scope. A multi-repository workspace offers
 * every active binding as an explicit radio choice (never a default) and
 * disables targets this build cannot pin; a single-repository workspace keeps
 * the read-only legacy pair taken from the trusted baseline. Every state that
 * makes creation impossible says why and leaves the submit button disabled.
 */
export function TaskTargetField({
  view,
  selectedBindingId,
  conflict,
  onSelect,
  onRetry,
}: TaskTargetFieldProps): ReactElement {
  const groupName = useId();

  if (view.status === "loading") {
    return (
      <p className="field-hint" role="status">
        Loading repository targets…
      </p>
    );
  }

  if (view.status === "error" || view.list === undefined) {
    return (
      <div className="inline-error target-notice" role="alert">
        <span>{view.error ?? "Repository targets are unavailable."}</span>
        <button type="button" onClick={onRetry} aria-label="Retry loading repository targets">
          Retry
        </button>
      </div>
    );
  }

  const list = view.list;
  const single = singleCandidate(list);
  const blocked = list.usable ? undefined : targetBlockedMessage(list.blocked_reason);

  return (
    <div className="target-field">
      {conflict && (
        <p className="inline-error target-notice" role="alert">
          {conflict}
        </p>
      )}
      {blocked && (
        <p className="target-notice" role="status">
          {blocked}
        </p>
      )}
      {list.targets.length === 0 ? (
        <p className="target-notice" role="status">
          No selectable repository target.
        </p>
      ) : list.selection_required ? (
        <fieldset className="target-fieldset">
          <legend>
            Repository target <span className="required-dot">*</span>
          </legend>
          <div className="target-options">
            {list.targets.map((candidate) => {
              const trusted = hasTrustedBaseline(candidate);
              const selectable = trusted && list.usable;
              return (
                <label
                  key={candidate.binding_id}
                  className={`target-option${selectedBindingId === candidate.binding_id ? " selected" : ""}${selectable ? "" : " disabled"}`}
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={candidate.binding_id}
                    checked={selectedBindingId === candidate.binding_id}
                    disabled={!selectable}
                    onChange={() => onSelect(candidate.binding_id)}
                  />
                  <span className="target-option-body">
                    <span className="target-option-name">{targetLabel(candidate)}</span>
                    {candidate.repository_name !== null && (
                      <span className="target-option-meta mono">{candidate.repository_id}</span>
                    )}
                    {trusted ? (
                      <span className="target-option-meta mono">
                        {candidate.baseline.base_ref} @ {shortId(candidate.baseline.base_sha, 12)}
                      </span>
                    ) : (
                      <span className="target-option-meta">No trusted baseline</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <div className="form-grid">
          <label>
            Repository
            <input value={single ? targetLabel(single) : ""} readOnly />
          </label>
          <label>
            Base ref
            <input
              value={
                single && hasTrustedBaseline(single) ? single.baseline.base_ref : "Unavailable"
              }
              readOnly
            />
          </label>
        </div>
      )}
    </div>
  );
}
