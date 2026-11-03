import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ProviderType } from "../control-plane/types.js";
import { normalizeProviderOrigin } from "./provider-origin.js";

/**
 * Provider OAuth (authorization code + PKCE) clients for GitHub and GitLab.
 *
 * Endpoints derive from the admin-approved provider-instance origin — never
 * from a caller-supplied URL. Access tokens live only for the token/userinfo
 * exchange inside this module: they are never persisted, logged, or returned.
 * Identity is matched later by (provider instance, stable subject id); the
 * profile's email is not even read.
 */

export interface OAuthAppCredentials {
  client_id: string;
  client_secret: string;
}

/** Keyed by normalized provider origin (`https://host`). */
export type OAuthCredentialsByOrigin = Map<string, OAuthAppCredentials>;

export interface ProviderProfile {
  /** Stable provider-assigned subject (numeric user id as a string). */
  subject: string;
  /** Provider handle; display-only, never a linking key. */
  login: string;
  display_name: string;
}

export interface AuthorizeParams {
  origin: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/** One provider request asking whether a subject can reach a repository. */
export interface RepositoryAccessRequest {
  url: string;
  headers: Record<string, string>;
}

export interface RepositoryAccessRequestInput {
  origin: string;
  accessToken: string;
  /** Immutable provider-assigned repository id of the workspace binding. */
  repositoryId: string;
  /** Stable provider subject whose current access is being verified. */
  subject: string;
}

export interface ProviderAdapter {
  authorizeUrl(params: AuthorizeParams): string;
  tokenUrl(origin: string): string;
  userUrl(origin: string): string;
  profileFromUser(payload: unknown): ProviderProfile;
  /**
   * Ask the provider whether `subject` can currently reach `repositoryId`,
   * authenticated with the subject's own access token.
   */
  repositoryAccessRequest(input: RepositoryAccessRequestInput): RepositoryAccessRequest;
  /**
   * Interpret the provider's answer: `true`/`false` is a verified fact;
   * `undefined` means the answer is not usable and no fact may be recorded
   * (fail closed).
   */
  repositoryAccessFromResponse(status: number): boolean | undefined;
}

/** A failure talking to the provider; surfaces as a retryable 502. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

function stringField(payload: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function profileFromPayload(payload: unknown): ProviderProfile {
  if (payload === null || typeof payload !== "object") {
    throw new ProviderError("provider user endpoint did not return an object");
  }
  const record = payload as Record<string, unknown>;
  const subject = stringField(record, "id");
  if (subject === "") {
    throw new ProviderError("provider user payload has no stable subject id");
  }
  const login = stringField(record, "login", "username");
  const name = stringField(record, "name");
  return {
    subject,
    login: login === "" ? subject : login,
    display_name: name === "" ? login : name,
  };
}

/**
 * Shared interpretation of a repository-access answer: 2xx is a verified
 * yes, 404 a verified no, everything else (401/403/5xx/…) is unusable and
 * must record no fact — fail closed.
 */
function repositoryAccessFromStatus(status: number): boolean | undefined {
  if (status >= 200 && status < 300) {
    return true;
  }
  if (status === 404) {
    return false;
  }
  return undefined;
}

/** github.com fronts its API on a separate host; GitHub Enterprise serves
 * the same API under the instance origin. */
function githubApiBase(origin: string): string {
  return origin === "https://github.com" ? "https://api.github.com" : `${origin}/api/v3`;
}

const githubAdapter: ProviderAdapter = {
  authorizeUrl(params) {
    const url = new URL(`${params.origin}/login/oauth/authorize`);
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },
  tokenUrl(origin) {
    return `${origin}/login/oauth/access_token`;
  },
  userUrl(origin) {
    return `${githubApiBase(origin)}/user`;
  },
  profileFromUser: profileFromPayload,
  repositoryAccessRequest(input) {
    // The subject's own view of the bound repository: 200 means they can
    // currently reach it, 404 means they cannot (a private-repo outsider
    // gets 404). Finer affiliation roles are DAT-203's roster normalization
    // and refine this same fact.
    return {
      url: `${githubApiBase(input.origin)}/repositories/${encodeURIComponent(input.repositoryId)}`,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
      },
    };
  },
  repositoryAccessFromResponse: repositoryAccessFromStatus,
};

const gitlabAdapter: ProviderAdapter = {
  authorizeUrl(params) {
    const url = new URL(`${params.origin}/oauth/authorize`);
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },
  tokenUrl(origin) {
    return `${origin}/oauth/token`;
  },
  userUrl(origin) {
    return `${origin}/api/v4/user`;
  },
  profileFromUser: profileFromPayload,
  repositoryAccessRequest(input) {
    // Project membership including inherited memberships: GitLab's precise
    // "is this subject currently a member of the bound project" answer.
    return {
      url: `${input.origin}/api/v4/projects/${encodeURIComponent(input.repositoryId)}/members/all/${encodeURIComponent(input.subject)}`,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
      },
    };
  },
  repositoryAccessFromResponse: repositoryAccessFromStatus,
};

export const providerAdapters: Record<ProviderType, ProviderAdapter> = {
  github: githubAdapter,
  gitlab: gitlabAdapter,
};

/** 128+ bits of URL-safe randomness for state/binding/secret material. */
export function randomUrlSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function pkcePair(): PkcePair {
  const verifier = randomUrlSecret(32);
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/**
 * Load per-origin OAuth application credentials from the protected file
 * (`{"https://host": {"client_id": …, "client_secret": …}}`).
 *
 * Same boundary as the gateway credential file: owner-only permissions, no
 * symlinks, one fd for check and read. The file is the only holder of client
 * secrets — they never reach the database, renderer, or logs.
 */
export function readOAuthCredentialsFile(file: string): OAuthCredentialsByOrigin {
  const flags =
    fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`refusing to read OAuth credentials from non-regular file ${file}`);
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(
        `OAuth credentials file ${path.basename(file)} must have owner-only permissions (0600)`,
      );
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        "OAuth credentials file must be a JSON object of provider origin -> {client_id, client_secret}",
      );
    }
    const credentials: OAuthCredentialsByOrigin = new Map();
    for (const [origin, entry] of Object.entries(parsed)) {
      const record = entry as { client_id?: unknown; client_secret?: unknown };
      if (
        typeof record.client_id !== "string" ||
        record.client_id === "" ||
        typeof record.client_secret !== "string" ||
        record.client_secret === ""
      ) {
        throw new Error(
          "OAuth credentials entries must map an origin to client_id and client_secret",
        );
      }
      credentials.set(normalizeProviderOrigin(origin), {
        client_id: record.client_id,
        client_secret: record.client_secret,
      });
    }
    return credentials;
  } finally {
    fs.closeSync(fd);
  }
}

export interface ProviderOAuthOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout for provider calls. */
  timeoutMs?: number;
}

export interface ExchangeCodeInput {
  adapter: ProviderAdapter;
  origin: string;
  credentials: OAuthAppCredentials;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface FetchProfileInput {
  adapter: ProviderAdapter;
  origin: string;
  accessToken: string;
}

export interface ProbeRepositoryAccessInput extends RepositoryAccessRequestInput {
  adapter: ProviderAdapter;
}

/**
 * Stateless provider HTTP client. Holds no token beyond the call it makes:
 * `exchangeCode` returns the access token for exactly one `fetchProfile` use.
 */
export class ProviderOAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ProviderOAuthOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<string> {
    const body = new URLSearchParams({
      client_id: input.credentials.client_id,
      client_secret: input.credentials.client_secret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.codeVerifier,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(input.adapter.tokenUrl(input.origin), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        // Never follow redirects: a 302/307/308 would forward the client
        // secret, authorization code, and PKCE verifier to whatever target
        // the (possibly compromised or re-bound) provider names — and that
        // target could be an internal address outside the approved origin.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderError("provider token endpoint request failed");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("provider token endpoint returned non-JSON output");
    }
    const record = (payload ?? {}) as Record<string, unknown>;
    const token = record["access_token"];
    if (!response.ok || typeof token !== "string" || token.length === 0) {
      // Never echo provider output: it can contain the request secret.
      throw new ProviderError(`provider token exchange failed (${response.status})`);
    }
    return token;
  }

  async fetchProfile(input: FetchProfileInput): Promise<ProviderProfile> {
    let response: Response;
    try {
      response = await this.fetchImpl(input.adapter.userUrl(input.origin), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.accessToken}`,
        },
        // Same rule as the token call: never follow redirects — the bearer
        // access token must not reach another origin or an internal address.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderError("provider user endpoint request failed");
    }
    if (!response.ok) {
      throw new ProviderError(`provider user endpoint failed (${response.status})`);
    }
    return input.adapter.profileFromUser(await response.json());
  }

  /**
   * Ask the provider whether the subject can currently reach the repository.
   *
   * Tri-state: `true`/`false` is a verified answer; `undefined` means the
   * check could not run (transport failure or unusable status) and no fact
   * may be recorded — callers fail closed. Never throws and never lets the
   * access token leave this call (redirects are refused, same as above).
   */
  async probeRepositoryAccess(input: ProbeRepositoryAccessInput): Promise<boolean | undefined> {
    const request = input.adapter.repositoryAccessRequest(input);
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: "GET",
        headers: request.headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return undefined;
    }
    return input.adapter.repositoryAccessFromResponse(response.status);
  }
}
