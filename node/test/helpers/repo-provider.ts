/**
 * Repository-scoped fake provider for the DAT-247 consumer path (DAT-204).
 *
 * The invitation redemption point refresh calls DAT-247's
 * `refreshSubjectAuthority`, which uses the real GitHub adapter against the
 * integration's provider origin. This server is that origin for tests: it
 * answers the exact routes the adapter requests (metadata, single-subject
 * permission, roster pages) and records every request so tests can assert
 * the path and the service credential header.
 *
 * Exact request targets only — a substring match is what hid the DAT-204
 * regression the architect ruled on.
 */

import type { IncomingHttpHeaders } from "node:http";
import { startFakeProvider } from "./fake-provider.js";
import type { FakeProvider, RecordedRequest } from "./fake-provider.js";

export const REPO_OWNER = "Luthiel";
export const REPO_NAME = "AutoFixer";
export const REPO_PATH = `/repos/${REPO_OWNER}/${REPO_NAME}`;
export const REPO_METADATA_URL = REPO_PATH;
export const COLLABORATORS_URL = `${REPO_PATH}/collaborators?per_page=100&page=1`;
export const OWNERS_URL = `/orgs/${REPO_OWNER}/members?role=admin&per_page=100&page=1`;

export interface RepoMember {
  id: number;
  login: string;
  role_name: string;
}

export interface RepoProviderState {
  /**
   * Answer of the single-subject permission endpoint:
   * - `"granted"`: 200 with a member role (current access);
   * - `"none"`: 404 (provider positively says "not a member");
   * - `"unauthorized"`: 401 (the service credential lacks scope);
   * - `"unavailable"`: 500 (provider cannot answer).
   */
  permission: "granted" | "none" | "unauthorized" | "unavailable";
  /** Rows the roster endpoints return when the roster can be collected. */
  collaborators: RepoMember[];
  /** `"unavailable"` makes roster collection fail (an incomplete roster). */
  roster: "complete" | "unavailable";
}

export interface RepoProvider {
  base_url: string;
  state: RepoProviderState;
  fake: FakeProvider;
  requests(): RecordedRequest[];
  urls(): string[];
  close(): Promise<void>;
}

function githubRepository() {
  return {
    id: 9001,
    name: REPO_NAME,
    owner: { id: 7, login: REPO_OWNER, type: "Organization" },
  };
}

export async function startRepoProvider(
  overrides: Partial<RepoProviderState> = {},
): Promise<RepoProvider> {
  const state: RepoProviderState = {
    permission: "granted",
    collaborators: [{ id: 1001, login: "octo", role_name: "push" }],
    roster: "complete",
    ...overrides,
  };
  const fake = await startFakeProvider((request) => {
    if (request.method === "GET" && request.url === REPO_METADATA_URL) {
      return { status: 200, body: githubRepository() };
    }
    if (request.method === "GET" && request.url === COLLABORATORS_URL) {
      if (state.roster === "unavailable") {
        return { status: 500, body: { message: "provider unavailable" } };
      }
      return { status: 200, body: state.collaborators };
    }
    if (request.method === "GET" && request.url === OWNERS_URL) {
      return { status: 200, body: [] };
    }
    const permissionPrefix = `${REPO_PATH}/collaborators/`;
    if (
      request.method === "GET" &&
      request.url.startsWith(permissionPrefix) &&
      request.url.endsWith("/permission")
    ) {
      switch (state.permission) {
        case "none":
          return { status: 404, body: { message: "Not Found" } };
        case "unauthorized":
          return { status: 401, body: { message: "Bad credentials" } };
        case "unavailable":
          return { status: 500, body: { message: "provider unavailable" } };
        case "granted":
          return {
            status: 200,
            body: { permission: "push", role_name: "push", user: { id: 1, login: "octo" } },
          };
      }
    }
    return { status: 599, body: { error: `unexpected request ${request.method} ${request.url}` } };
  });
  return {
    base_url: fake.base_url,
    state,
    fake,
    requests: () => fake.requests,
    urls: () => fake.urls(),
    close: () => fake.close(),
  };
}

/** Lower-cased header lookup for credential assertions. */
export function headerOf(request: RecordedRequest, name: string): string | undefined {
  return (request.headers as IncomingHttpHeaders)[name] as string | undefined;
}
