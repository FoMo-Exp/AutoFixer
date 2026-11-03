/**
 * Canonical repository identifiers (DAT-247).
 *
 * A repository-scoped service integration addresses exactly one repository
 * through a provider-qualified canonical id:
 *
 * - `github:<owner>/<repo>`
 * - `gitlab:<namespace>/<project>` (namespaces may be nested)
 *
 * The provider prefix is **addressing metadata only**. It never appears in a
 * provider API path: the GitHub adapter turns `github:Luthiel/AutoFixer` into
 * `/repos/Luthiel/AutoFixer`, and the GitLab adapter turns
 * `gitlab:acme/platform/api` into `/projects/acme%2Fplatform%2Fapi`. Passing
 * the raw canonical id through would request `/repositories/github:...`,
 * which no provider serves — the exact defect DAT-204's login-time probe
 * shipped.
 *
 * Parsing is strict on purpose: a malformed id must fail at construction
 * time, never degrade into a request that silently returns "no access".
 */

import type { ProviderType } from "../control-plane/types.js";
import { ProviderIntegrationError } from "./types.js";

/** A canonical repository id that cannot address a provider repository. */
export class InvalidRepositoryIdError extends ProviderIntegrationError {
  constructor(message: string) {
    super("REPOSITORY_ID_INVALID", message);
  }
}

export interface CanonicalRepositoryId {
  provider: ProviderType;
  /** GitHub owner, or the GitLab top-level namespace group. */
  owner: string;
  /** Repository name, or the GitLab project name under its namespace. */
  name: string;
  /** `owner/repo` or `namespace/project` without the provider prefix. */
  path: string;
  /** The full canonical id, prefix included. */
  canonical: string;
}

const PROVIDER_PREFIX = /^(github|gitlab):/;

/**
 * Characters a path segment may not contain. `/` is the separator and is
 * handled by splitting; the rest could escape a path segment (`?`, `#`, `\`),
 * smuggle a pre-encoded separator (`%`), or break HTTP headers (whitespace,
 * control characters).
 */
// eslint-disable-next-line no-control-regex -- control characters in an id must be rejected
const FORBIDDEN_SEGMENT = /[\u0000-\u001f\u007f\s#?\\%]/;
const DOT_SEGMENTS = new Set([".", ".."]);

function assertSegment(segment: string, canonical: string): void {
  if (segment === "") {
    throw new InvalidRepositoryIdError(
      `repository id ${JSON.stringify(canonical)} has an empty path segment`,
    );
  }
  if (DOT_SEGMENTS.has(segment)) {
    throw new InvalidRepositoryIdError(
      `repository id ${JSON.stringify(canonical)} contains a relative path segment ${JSON.stringify(segment)}`,
    );
  }
  if (FORBIDDEN_SEGMENT.test(segment)) {
    throw new InvalidRepositoryIdError(
      `repository id ${JSON.stringify(canonical)} contains an invalid character in ${JSON.stringify(segment)}`,
    );
  }
}

/**
 * Parse a provider-qualified canonical repository id. Rejects unqualified ids,
 * wrong arity (GitHub is exactly `owner/repo`), empty segments, dot segments,
 * and characters that would escape the generated API path.
 */
export function parseCanonicalRepositoryId(raw: string): CanonicalRepositoryId {
  const match = PROVIDER_PREFIX.exec(raw);
  if (!match) {
    throw new InvalidRepositoryIdError(
      `repository id ${JSON.stringify(raw)} is not provider-qualified (expected github:<owner>/<repo> or gitlab:<namespace>/<project>)`,
    );
  }
  const provider = match[1] as ProviderType;
  const path = raw.slice(match[0].length);
  const segments = path.split("/");
  const [owner, ...rest] = segments;
  if (owner === undefined || rest.length === 0) {
    throw new InvalidRepositoryIdError(
      `repository id ${JSON.stringify(raw)} must name a repository inside an owner or namespace`,
    );
  }
  if (provider === "github" && segments.length !== 2) {
    throw new InvalidRepositoryIdError(
      `github repository id ${JSON.stringify(raw)} must be github:<owner>/<repo> (exactly one slash after the prefix)`,
    );
  }
  for (const segment of segments) {
    assertSegment(segment, raw);
  }
  return {
    provider,
    owner,
    name: rest.join("/"),
    path,
    canonical: `${provider}:${path}`,
  };
}

/** Build and validate a canonical id from a provider type and `owner/repo` path. */
export function canonicalRepositoryId(provider: ProviderType, path: string): CanonicalRepositoryId {
  return parseCanonicalRepositoryId(`${provider}:${path}`);
}

/**
 * `owner/repo` URL path for GitHub. Each segment is encoded separately: a
 * GitHub owner and repository name are each a single path segment, so the
 * separator must stay literal.
 */
export function githubRepositoryPath(coords: CanonicalRepositoryId): string {
  if (coords.provider !== "github") {
    throw new InvalidRepositoryIdError(`expected a github repository id, got ${coords.canonical}`);
  }
  return `${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.name)}`;
}

/**
 * `namespace/project` URL path for GitLab. GitLab addresses the whole project
 * path as ONE path segment, so the slashes are percent-encoded while the
 * `gitlab:` prefix stays absent.
 */
export function gitlabProjectPath(coords: CanonicalRepositoryId): string {
  if (coords.provider !== "gitlab") {
    throw new InvalidRepositoryIdError(`expected a gitlab repository id, got ${coords.canonical}`);
  }
  return encodeURIComponent(coords.path);
}
