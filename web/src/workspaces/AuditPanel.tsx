import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { AuthAuditRecord, IdentityClient, Workspace } from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import { describeError, formatTimestamp } from "./identity-format";

interface AuditPanelProps {
  client: IdentityClient;
  workspace: Workspace;
}

const AUDIT_LIMIT = 50;

export function AuditPanel({ client, workspace }: AuditPanelProps): ReactElement {
  const [records, setRecords] = useState<AuthAuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorDescription>();
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setRecords([]);
    setLoading(true);
    client
      .listAuthAudit(workspace.enterprise_id, AUDIT_LIMIT)
      .then((page) => {
        if (requestRef.current !== requestId) return;
        setRecords(page.items);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (requestRef.current === requestId) setError(describeError(caught));
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
    return () => {
      requestRef.current += 1;
    };
  }, [client, workspace.enterprise_id]);

  return (
    <div className="identity-panel">
      {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}
      {loading && records.length === 0 ? (
        <p className="card-empty">Loading audit records…</p>
      ) : records.length === 0 ? (
        <p className="card-empty">No audit records for this enterprise.</p>
      ) : (
        <ul className="identity-list">
          {records.map((record) => (
            <li className="identity-row" key={record.id}>
              <div className="identity-row-main">
                <div className="identity-row-title">
                  <strong>{record.event}</strong>
                  <span className="mono identity-id">{record.id}</span>
                </div>
                <span className="identity-meta">
                  {`${formatTimestamp(record.at)} · ${record.actor_kind}`}
                  {record.actor_user_id ? ` · actor ${record.actor_user_id}` : ""}
                  {record.subject_user_id ? ` · subject ${record.subject_user_id}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
