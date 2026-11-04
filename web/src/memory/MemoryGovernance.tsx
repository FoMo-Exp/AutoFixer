import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type {
  ForgePilotClient,
  MemoryGovernanceResult,
  MemoryItem,
  MemoryReasonCode,
  MemoryRestoreTarget,
} from "../api/client";
import { Select } from "../ui/Select";
import {
  describeMemoryGovernanceError,
  MEMORY_ACTION_DEFAULT_REASON,
  memoryActionOffers,
  memoryReasonLabel,
  MEMORY_GOVERNANCE_ACTIONS,
  MEMORY_SENSITIVITY_LABELS,
  MEMORY_STATUS_LABELS,
  memoryStatusTone,
} from "./memory-format";
import type { MemoryError, MemoryStanding } from "./memory-format";
import type { MemoryActionOffer } from "./memory-format";

/** Deprecate/quarantine/restore accept the DAT-235/DAT-251 vocabulary only. */
const GOVERNANCE_REASON_CODES: MemoryReasonCode[] = [
  "duplicate_content",
  "past_valid_to",
  "stale_fact",
  "unused_decay",
  "retirement_proposal",
  "security_report",
  "human_decision",
  "contradiction",
  "incorrect_content",
  "policy_violation",
  "secret_leak",
  "poisoning_suspected",
  "restore_after_review",
  "false_positive",
];

const RESTORE_TARGETS: Array<{ value: MemoryRestoreTarget; label: string }> = [
  { value: "proposed", label: "Proposed" },
  { value: "candidate", label: "Candidate" },
  { value: "deprecated", label: "Deprecated" },
];

interface MemoryGovernanceProps {
  client: ForgePilotClient;
  workspaceId: string;
  item: MemoryItem;
  standing: MemoryStanding;
  onApplied: (result: MemoryGovernanceResult) => void;
  /** Re-reads the item and its history after a conflict; never a blind retry. */
  onRefresh: () => Promise<void>;
  refreshing: boolean;
}

function targetLabel(offer: MemoryActionOffer, restoreTarget: MemoryRestoreTarget): string {
  if (offer.target === "choose") return MEMORY_STATUS_LABELS[restoreTarget];
  return MEMORY_STATUS_LABELS[offer.target];
}

/**
 * Named-human transitions for one item. The client mirrors the contract's
 * state machine to decide which affordances to show, but the service remains
 * the authority: a 409 is reported as a stale view with an explicit refresh,
 * never retried silently, and nothing renders as applied before the response.
 */
export function MemoryGovernance({
  client,
  workspaceId,
  item,
  standing,
  onApplied,
  onRefresh,
  refreshing,
}: MemoryGovernanceProps): ReactElement {
  const [pending, setPending] = useState<MemoryActionOffer>();
  const [reason, setReason] = useState<MemoryReasonCode>("human_decision");
  const [restoreTarget, setRestoreTarget] = useState<MemoryRestoreTarget>("candidate");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MemoryError & { stale: boolean }>();
  const [applied, setApplied] = useState<MemoryGovernanceResult>();

  const offers = memoryActionOffers(item.status, standing.canGovern, item.sensitivity);

  // A different status or version invalidates an open confirmation and a
  // previous failure: the summary shown must match this view. The applied
  // banner survives its own status change so the operator sees the result,
  // and is cleared only when a new action starts or the item changes.
  useEffect(() => {
    setPending(undefined);
    setFailure(undefined);
  }, [item.item_id, item.status, item.current_version]);

  useEffect(() => {
    setApplied(undefined);
  }, [item.item_id]);

  function begin(offer: MemoryActionOffer): void {
    setPending(offer);
    const defaultReason = MEMORY_ACTION_DEFAULT_REASON[offer.action];
    if (defaultReason !== "human_approved") setReason(defaultReason);
    setRestoreTarget("candidate");
    setFailure(undefined);
    setApplied(undefined);
  }

  async function confirm(): Promise<void> {
    if (!pending) return;
    const version = item.current_version;
    setBusy(true);
    try {
      let result: MemoryGovernanceResult;
      if (pending.action === "promote") {
        result = await client.promoteMemoryItem(workspaceId, item.item_id, {
          version,
          expected_version: version,
        });
      } else if (pending.action === "deprecate") {
        result = await client.deprecateMemoryItem(workspaceId, item.item_id, {
          version,
          expected_version: version,
          reason_code: reason,
        });
      } else if (pending.action === "quarantine") {
        result = await client.quarantineMemoryItem(workspaceId, item.item_id, {
          version,
          expected_version: version,
          reason_code: reason,
        });
      } else {
        result = await client.restoreMemoryItem(workspaceId, item.item_id, {
          version,
          expected_version: version,
          target_status: restoreTarget,
          reason_code: reason,
        });
      }
      setApplied(result);
      setPending(undefined);
      setFailure(undefined);
      onApplied(result);
    } catch (caught) {
      setFailure(describeMemoryGovernanceError(caught, pending.action));
    } finally {
      setBusy(false);
    }
  }

  async function refreshAfterConflict(): Promise<void> {
    setBusy(true);
    try {
      await onRefresh();
      setPending(undefined);
      setFailure(undefined);
    } catch (caught) {
      setFailure(describeMemoryGovernanceError(caught, pending?.action ?? "promote"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card memory-card" aria-labelledby="memory-governance-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Named human action</span>
          <h3 id="memory-governance-heading">Governance</h3>
        </div>
        <div className="memory-governance-state">
          <span className={`stage-pip stage-tone-${memoryStatusTone(item.status)}`} />
          <span>{MEMORY_STATUS_LABELS[item.status]}</span>
          <span className={`role-chip sensitivity-${item.sensitivity}`}>
            {MEMORY_SENSITIVITY_LABELS[item.sensitivity]}
          </span>
        </div>
      </div>

      <p className="memory-governance-note">
        {standing.note}
        {standing.role !== undefined && (
          <span className="memory-governance-role"> Role: {standing.role}.</span>
        )}
      </p>

      {applied && (
        <div className="memory-governance-result" role="status">
          <strong>{MEMORY_GOVERNANCE_ACTIONS[applied.action]} applied.</strong>{" "}
          {MEMORY_STATUS_LABELS[applied.from_status]} → {MEMORY_STATUS_LABELS[applied.to_status]} ·
          v{applied.item_version}
          {applied.reason_code !== null && ` · ${memoryReasonLabel(applied.reason_code)}`}
        </div>
      )}

      {failure && (
        <div className="inline-error" role="alert">
          <span>
            {failure.code}: {failure.message}
          </span>
          {failure.stale && (
            <button
              type="button"
              className="button button-small button-quiet"
              onClick={() => void refreshAfterConflict()}
              disabled={busy || refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh item"}
            </button>
          )}
        </div>
      )}

      {!standing.canGovern ? null : offers.length === 0 ? (
        <p className="card-empty compact">
          {item.status === "retired"
            ? "Retired is terminal; the contract defines no further transition."
            : "No governance action is available for this item's current status."}
        </p>
      ) : pending === undefined ? (
        <div className="memory-governance-actions">
          {offers.map((offer) => (
            <button
              key={offer.action}
              type="button"
              className={`button button-small ${
                offer.action === "quarantine" ? "button-danger" : "button-quiet"
              }`}
              onClick={() => begin(offer)}
            >
              {offer.label}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="memory-governance-form"
          aria-label={`Confirm ${MEMORY_GOVERNANCE_ACTIONS[pending.action].toLowerCase()}`}
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <h4>{MEMORY_GOVERNANCE_ACTIONS[pending.action]} item</h4>
          <dl className="memory-governance-summary">
            <div>
              <dt className="field-label">Current status</dt>
              <dd>{MEMORY_STATUS_LABELS[item.status]}</dd>
            </div>
            <div>
              <dt className="field-label">Target status</dt>
              <dd>
                {pending.target === "choose" ? (
                  <Select
                    value={restoreTarget}
                    options={RESTORE_TARGETS}
                    onChange={(value) => setRestoreTarget(value as MemoryRestoreTarget)}
                  />
                ) : (
                  targetLabel(pending, restoreTarget)
                )}
              </dd>
            </div>
            <div>
              <dt className="field-label">Version</dt>
              <dd className="mono">v{item.current_version}</dd>
            </div>
            <div>
              <dt className="field-label">Expected version</dt>
              <dd className="mono">v{item.current_version} · from this view</dd>
            </div>
          </dl>

          {pending.needsReason && (
            <label className="memory-governance-reason">
              <span className="field-label">Reason code</span>
              <Select
                value={reason}
                options={GOVERNANCE_REASON_CODES.map((code) => ({
                  value: code,
                  label: `${memoryReasonLabel(code)} · ${code}`,
                }))}
                onChange={(value) => setReason(value as MemoryReasonCode)}
              />
            </label>
          )}

          <div className="memory-governance-buttons">
            <button type="submit" className="button button-small button-primary" disabled={busy}>
              {busy ? "Applying…" : `Confirm ${MEMORY_GOVERNANCE_ACTIONS[pending.action]}`}
            </button>
            <button
              type="button"
              className="button button-small button-quiet"
              onClick={() => setPending(undefined)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          <p className="memory-governance-hint">
            The service validates the transition, the exact version, and the fixed reason. A
            conflict is reported with a refresh; it is never retried silently.
          </p>
        </form>
      )}
    </section>
  );
}
