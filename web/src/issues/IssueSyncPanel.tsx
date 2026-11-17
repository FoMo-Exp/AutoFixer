import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { ForgePilotClient, Issue, IssueSyncComment, IssueSyncVersion } from "../api/client";
import { CreateIdempotencyKeys } from "../api/idempotency";
import { formatDate } from "../ui/format";
import { describeIssueError } from "./errors";

export function IssueSyncPanel({
  client,
  workspaceId,
  issue,
  canMutate,
  onChanged,
}: {
  client: ForgePilotClient;
  workspaceId: string;
  issue: Issue;
  canMutate: boolean;
  onChanged: () => void;
}): ReactElement {
  const [versions, setVersions] = useState<IssueSyncVersion[]>([]);
  const [comments, setComments] = useState<IssueSyncComment[]>([]);
  const [title, setTitle] = useState(issue.summary);
  const [description, setDescription] = useState(issue.description ?? "");
  const [labels, setLabels] = useState(issue.labels?.join(", ") ?? "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const keys = useRef(new CreateIdempotencyKeys());

  useEffect(() => {
    if (!issue.provider) return;
    let active = true;
    void Promise.all([
      client.getIssueVersions(workspaceId, issue.issue_id),
      client.getIssueComments(workspaceId, issue.issue_id),
    ])
      .then(([nextVersions, nextComments]) => {
        if (!active) return;
        setVersions(nextVersions);
        setComments(nextComments);
      })
      .catch((caught: unknown) => {
        if (active) setError(describeIssueError(caught).message);
      });
    return () => {
      active = false;
    };
  }, [client, workspaceId, issue.issue_id, issue.updated_at]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const input = {
        title: title.trim(),
        description,
        labels: labels
          .split(/[\n,]/u)
          .map((value) => value.trim())
          .filter(Boolean),
      };
      await client.updateIssueContent(
        workspaceId,
        issue.issue_id,
        input,
        keys.current.forInput({ issue: issue.issue_id, input }),
      );
      keys.current.complete({ issue: issue.issue_id, input });
      onChanged();
    } catch (caught) {
      setError(describeIssueError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!comment.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const intent = { issue: issue.issue_id, comment: comment.trim() };
      await client.addIssueComment(
        workspaceId,
        issue.issue_id,
        comment.trim(),
        keys.current.forInput(intent),
      );
      keys.current.complete(intent);
      setComment("");
      setComments(await client.getIssueComments(workspaceId, issue.issue_id));
      onChanged();
    } catch (caught) {
      setError(describeIssueError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  async function rollback(version: IssueSyncVersion): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const intent = { issue: issue.issue_id, rollback: version.version_id };
      await client.rollbackIssueContent(
        workspaceId,
        issue.issue_id,
        version.version_id,
        keys.current.forInput(intent),
      );
      keys.current.complete(intent);
      setTitle(version.content.title);
      setDescription(version.content.description);
      setLabels(version.content.labels.join(", "));
      setVersions(await client.getIssueVersions(workspaceId, issue.issue_id));
      onChanged();
    } catch (caught) {
      setError(describeIssueError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="issue-sync-panel" aria-label="Provider issue synchronization">
      <header className="issue-sync-panel-heading">
        <h3>Provider issue</h3>
        {issue.provider ? (
          <a href={issue.provider.url} target="_blank" rel="noreferrer">
            {issue.provider.provider_type} #{issue.provider.issue_number} · {issue.provider.state}
          </a>
        ) : (
          <span>Sync {issue.sync_state}</span>
        )}
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {issue.provider && (
        <>
          <form className="issue-sync-edit" onSubmit={(event) => void save(event)}>
            <label className="field-label" htmlFor="sync-issue-title">
              Title
              <input
                id="sync-issue-title"
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={!canMutate || busy}
              />
            </label>
            <label className="field-label" htmlFor="sync-issue-description">
              Description
              <textarea
                id="sync-issue-description"
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={!canMutate || busy}
              />
            </label>
            <label className="field-label" htmlFor="sync-issue-labels">
              Labels
              <input
                id="sync-issue-labels"
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
                disabled={!canMutate || busy}
              />
            </label>
            <div className="issue-sync-panel-actions">
              <button
                className="button button-quiet button-small"
                type="button"
                disabled={!canMutate || busy}
                onClick={() => {
                  const input = {
                    state:
                      issue.provider?.state === "open" ? ("closed" as const) : ("open" as const),
                  };
                  const intent = { issue: issue.issue_id, input };
                  void client
                    .updateIssueContent(
                      workspaceId,
                      issue.issue_id,
                      input,
                      keys.current.forInput(intent),
                    )
                    .then(() => {
                      keys.current.complete(intent);
                      onChanged();
                    })
                    .catch((caught: unknown) => setError(describeIssueError(caught).message));
                }}
              >
                {issue.provider.state === "open" ? "Close provider issue" : "Reopen provider issue"}
              </button>
              <button
                className="button button-primary button-small"
                type="submit"
                disabled={!canMutate || busy || !title.trim()}
              >
                {busy ? "Saving…" : "Save fields"}
              </button>
            </div>
          </form>
          <form className="issue-sync-comment-form" onSubmit={(event) => void submitComment(event)}>
            <label className="field-label" htmlFor="sync-issue-comment">
              Comment
              <textarea
                id="sync-issue-comment"
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                disabled={!canMutate || busy}
              />
            </label>
            <button
              className="button button-quiet button-small"
              type="submit"
              disabled={!canMutate || busy || !comment.trim()}
            >
              Add comment
            </button>
          </form>
          <div className="issue-sync-comments">
            {comments.map((item) => (
              <article className="issue-sync-comment" key={item.id}>
                <div>
                  <strong>{item.author}</strong>
                  <span>
                    {item.source} · {formatDate(item.created_at)}
                  </span>
                </div>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
          <details className="issue-sync-history">
            <summary>Version history ({versions.length})</summary>
            {versions
              .slice(0, -1)
              .reverse()
              .map((version) => (
                <div className="issue-sync-version" key={version.version_id}>
                  <span>
                    v{version.sequence} · {version.source} · {formatDate(version.recorded_at)}
                  </span>
                  {canMutate && (
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      disabled={busy}
                      onClick={() => void rollback(version)}
                    >
                      Restore
                    </button>
                  )}
                </div>
              ))}
          </details>
        </>
      )}
    </section>
  );
}
