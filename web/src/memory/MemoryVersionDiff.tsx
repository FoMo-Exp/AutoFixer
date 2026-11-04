import { useState } from "react";
import type { ReactElement } from "react";
import type { MemoryItemVersions, MemoryItemVersion } from "../api/client";
import { formatDate } from "../ui/format";
import { Select } from "../ui/Select";
import { diffLines, diffWords } from "./memory-diff";
import type { DiffRow } from "./memory-diff";
import { MEMORY_SENSITIVITY_LABELS } from "./memory-format";
import type { MemoryError } from "./memory-format";

interface MemoryVersionDiffProps {
  versions: MemoryItemVersions | undefined;
  versionsCount: number;
  loading: boolean;
  error: MemoryError | undefined;
  /** Quarantined items never render version content, even if a response carries it. */
  redacted: boolean;
  onRetry: () => void;
}

function versionChoice(version: MemoryItemVersion): string {
  return String(version.version);
}

function DiffText({
  rows,
  side,
  empty,
}: {
  rows: DiffRow[];
  side: "base" | "target";
  empty: string;
}): ReactElement {
  if (rows.length === 0 || rows.every((row) => row.text === "")) {
    return <p className="card-empty compact">{empty}</p>;
  }
  return (
    <div className={`memory-diff-text memory-diff-${side}`}>
      {rows.map((row, index) => (
        <span
          key={`${row.kind}:${index}`}
          className={row.kind === "same" ? undefined : `memory-diff-${row.kind}`}
        >
          {row.text}
        </span>
      ))}
    </div>
  );
}

function VersionFacts({ version }: { version: MemoryItemVersion }): ReactElement {
  return (
    <dl className="memory-diff-meta">
      <div>
        <dt className="field-label">Sensitivity</dt>
        <dd className={version.sensitivity === "restricted" ? "sensitivity-restricted" : undefined}>
          {MEMORY_SENSITIVITY_LABELS[version.sensitivity]}
        </dd>
      </div>
      <div>
        <dt className="field-label">Created</dt>
        <dd>{formatDate(version.created_at)}</dd>
      </div>
      <div>
        <dt className="field-label">Created by</dt>
        <dd className="mono">{version.created_by}</dd>
      </div>
      <div>
        <dt className="field-label">Content hash</dt>
        <dd className="mono memory-hash">{version.content_hash}</dd>
      </div>
    </dl>
  );
}

/**
 * Side-by-side content diff between two versions the service returned. Each
 * version is filtered by its own sensitivity server-side, so a version above
 * the caller's ceiling is simply absent rather than blanked in place.
 */
export function MemoryVersionDiff({
  versions,
  versionsCount,
  loading,
  error,
  redacted,
  onRetry,
}: MemoryVersionDiffProps): ReactElement {
  const [baseChoice, setBaseChoice] = useState<string>();
  const [targetChoice, setTargetChoice] = useState<string>();

  const list = versions?.versions ?? [];

  if (redacted) {
    return (
      <section className="card memory-card" aria-labelledby="memory-versions-heading">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Immutable history</span>
            <h3 id="memory-versions-heading">Versions and diff</h3>
          </div>
        </div>
        <p className="card-empty">
          Version content is withheld while the item is quarantined. Restore can return the item to
          proposed, candidate, or deprecated; quarantine content has no read route in this contract.
        </p>
      </section>
    );
  }

  const target =
    list.find((version) => versionChoice(version) === targetChoice) ?? list[list.length - 1];
  const base =
    list.find((version) => versionChoice(version) === baseChoice) ??
    list[list.length - 2] ??
    list[0];

  const hiddenCount = Math.max(0, versionsCount - list.length);

  return (
    <section className="card memory-card" aria-labelledby="memory-versions-heading">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Immutable history</span>
          <h3 id="memory-versions-heading">Versions and diff</h3>
        </div>
        <span className="task-count">{list.length}</span>
      </div>

      {error ? (
        <div className="inline-error" role="alert">
          <span>
            {error.code}: {error.message}
          </span>
          <button type="button" className="button button-quiet button-small" onClick={onRetry}>
            Retry versions
          </button>
        </div>
      ) : loading && versions === undefined ? (
        <p className="card-empty">Reading version history…</p>
      ) : list.length === 0 ? (
        <p className="card-empty">
          No version content is available within your sensitivity ceiling. Version history is
          filtered per version, so a higher-sensitivity version is absent rather than blanked.
        </p>
      ) : (
        <>
          {hiddenCount > 0 && (
            <p className="memory-history-note" role="status">
              {hiddenCount} {hiddenCount === 1 ? "version is" : "versions are"} above your
              sensitivity ceiling and are not shown.
            </p>
          )}

          <ol className="memory-version-list" aria-label="Returned versions">
            {list.map((version) => (
              <li key={version.version} className="memory-version-row">
                <span className="mono">v{version.version}</span>
                <span>{formatDate(version.created_at)}</span>
                <span>{MEMORY_SENSITIVITY_LABELS[version.sensitivity]}</span>
                <span className="mono memory-hash">{version.content_hash.slice(0, 12)}</span>
              </li>
            ))}
          </ol>

          {list.length === 1 || !base || !target ? (
            <p className="card-empty">
              Only one version is available within your sensitivity ceiling, so there is nothing to
              compare yet.
            </p>
          ) : (
            <>
              <div className="memory-diff-picker">
                <label className="memory-diff-field">
                  <span className="field-label">Compare version</span>
                  <Select
                    value={versionChoice(base)}
                    options={list.map((version) => ({
                      value: versionChoice(version),
                      label: `v${version.version} · ${formatDate(version.created_at)}`,
                    }))}
                    onChange={(value) => setBaseChoice(value)}
                  />
                </label>
                <label className="memory-diff-field">
                  <span className="field-label">With version</span>
                  <Select
                    value={versionChoice(target)}
                    options={list.map((version) => ({
                      value: versionChoice(version),
                      label: `v${version.version} · ${formatDate(version.created_at)}`,
                    }))}
                    onChange={(value) => setTargetChoice(value)}
                  />
                </label>
              </div>

              {base.version === target.version ? (
                <p className="card-empty">Select two different versions to see a content diff.</p>
              ) : (
                <div className="memory-diff" aria-label="Version content diff">
                  <section className="memory-diff-column" aria-labelledby="memory-diff-base">
                    <header>
                      <h4 id="memory-diff-base">v{base.version}</h4>
                      <span className="memory-diff-legend">Removed content is highlighted.</span>
                    </header>
                    <h5>Statement</h5>
                    {base.statement_redacted || base.statement === null ? (
                      <p className="card-empty compact">Content withheld for this version.</p>
                    ) : (
                      <DiffText
                        rows={diffWords(base.statement, target.statement ?? "").base}
                        side="base"
                        empty="No statement on this version."
                      />
                    )}
                    <h5>Preconditions</h5>
                    {base.preconditions.length === 0 ? (
                      <p className="card-empty compact">No precondition on this version.</p>
                    ) : (
                      <ul className="memory-preconditions memory-diff-lines">
                        {diffLines(base.preconditions, target.preconditions).base.map(
                          (row, index) => (
                            <li key={`${row.kind}:${index}`} className={`memory-diff-${row.kind}`}>
                              {row.text}
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                    <VersionFacts version={base} />
                  </section>

                  <section className="memory-diff-column" aria-labelledby="memory-diff-target">
                    <header>
                      <h4 id="memory-diff-target">v{target.version}</h4>
                      <span className="memory-diff-legend">New content is highlighted.</span>
                    </header>
                    <h5>Statement</h5>
                    {target.statement_redacted || target.statement === null ? (
                      <p className="card-empty compact">Content withheld for this version.</p>
                    ) : (
                      <DiffText
                        rows={diffWords(base.statement ?? "", target.statement).target}
                        side="target"
                        empty="No statement on this version."
                      />
                    )}
                    <h5>Preconditions</h5>
                    {target.preconditions.length === 0 ? (
                      <p className="card-empty compact">No precondition on this version.</p>
                    ) : (
                      <ul className="memory-preconditions memory-diff-lines">
                        {diffLines(base.preconditions, target.preconditions).target.map(
                          (row, index) => (
                            <li key={`${row.kind}:${index}`} className={`memory-diff-${row.kind}`}>
                              {row.text}
                            </li>
                          ),
                        )}
                      </ul>
                    )}
                    <VersionFacts version={target} />
                  </section>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
