/**
 * End-to-end authority production → redemption eligibility (DAT-247).
 *
 * The chain under test is the one DAT-204's invitation redemption consumes:
 *
 *   provider (real HTTP) → adapter → collectRoster → reconcile → subject_authority
 *     → repositoryAccessFor → redemption 200 / 403
 *
 * DAT-204 is still blocked, so the exchange HTTP route does not exist yet.
 * `redemptionEligibility` below mirrors the contract it will call — the same
 * `repositoryAccessFor` read model — so the 200/403 outcomes are asserted
 * against the production fact, not against a mock of it.
 */

import { afterEach, describe, expect, test } from "vitest";

import { createStaticServiceCredentialStore } from "../src/provider-access/credentials.js";
import {
  ReconcileIncompleteError,
  reconcileIntegration,
} from "../src/provider-access/reconcile.js";
import {
  repositoryAccessFor,
  refreshSubjectAuthority,
} from "../src/provider-access/subject-refresh.js";
import { createIntegrationAdapter } from "../src/provider-access/adapters/index.js";
import { MissingPermissionError, ProviderUnavailableError } from "../src/provider-access/types.js";
import type { FakeProvider } from "./helpers/fake-provider.js";
import { exactRoutes, startFakeProvider } from "./helpers/fake-provider.js";
import {
  addMember,
  page,
  role,
  scriptedAdapter,
  setupFixture,
  type Fixture,
} from "./helpers/provider-access.js";

const SUBJECT = "4242";
const LOGIN = "octocat";
const SECRET = "ghs_service_token_e2e_77bd";
const CREDENTIAL_REF = "svc-source-1";
const CANONICAL = "github:Luthiel/AutoFixer";

const REPO_URL = "/repos/Luthiel/AutoFixer";
const COLLABORATORS_URL = "/repos/Luthiel/AutoFixer/collaborators?per_page=100&page=1";
const OWNERS_URL = "/orgs/Luthiel/members?role=admin&per_page=100&page=1";

const ORG_REPO = { id: 9001, owner: { id: 7, login: "Luthiel", type: "Organization" } };

const credentials = createStaticServiceCredentialStore({ [CREDENTIAL_REF]: SECRET });

let provider: FakeProvider | null = null;

afterEach(async () => {
  await provider?.close();
  provider = null;
});

function member(roleName: string) {
  return { id: Number(SUBJECT), login: LOGIN, role_name: roleName };
}

function reconcileDeps(fixture: Fixture) {
  return {
    access: fixture.access,
    identities: fixture.identity.identities,
    epoch: fixture.epoch,
    clock: () => fixture.clock.now,
    available_token_scope: [
      "metadata:read",
      "contents:read",
      "members:read",
      "administration:read",
    ],
  };
}

function realAdapter(fixture: Fixture, baseUrl: string) {
  return createIntegrationAdapter({
    integration: fixture.integration,
    canonical_repository_id: CANONICAL,
    credentials,
    api_base_url: baseUrl,
    resolve_login: (subject) => (subject === SUBJECT ? LOGIN : undefined),
  });
}

/**
 * Mirrors DAT-204's redemption gate: a current, freshly verified repository
 * authority is required; `removed` and "cannot tell" both fail closed.
 */
function redemptionEligibility(
  fixture: Fixture,
  subject: string,
): { status: 200 | 403; reason: string } {
  const view = repositoryAccessFor(fixture.access, fixture.scope, fixture.integration.id, subject, {
    now: fixture.clock.now,
    fresh_window_ms: 15 * 60 * 1000,
    stale_after_ms: 24 * 60 * 60 * 1000,
  });
  if (view.state === "removed") {
    return { status: 403, reason: "repository_access" };
  }
  if (!view.current) {
    return {
      status: 403,
      reason: view.state === "absent" ? "authority_unknown" : "authority_stale",
    };
  }
  return { status: 200, reason: "ok" };
}

async function seedMember(fixture: Fixture) {
  return addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });
}

describe("reconcile → subject_authority → redemption", () => {
  test("a complete roster marks the subject active and fresh, so redemption is allowed", async () => {
    const fixture = setupFixture();
    const { userId } = await seedMember(fixture);
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [member("push")] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );

    const summary = await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    );
    expect(summary.status).toBe("completed");
    expect(summary.roster_size).toBe(1);
    expect(summary.members_added).toBe(1);

    // subject_authority carries state + verification time, bound to the user.
    const authority = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      SUBJECT,
    );
    expect(authority).toMatchObject({
      subject: SUBJECT,
      user_id: userId,
      state: "active",
      last_verified_at: fixture.clock.now.toISOString(),
    });

    expect(redemptionEligibility(fixture, SUBJECT)).toEqual({ status: 200, reason: "ok" });
    // The same fact satisfies the request-path gate for ordinary reads.
    expect(
      fixture.gate.authorize({ scope: fixture.scope, user_id: userId, action: "read" }).allowed,
    ).toBe(true);
  });

  test("dropping the subject from a complete roster revokes it, so redemption is 403", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [member("push")] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );
    await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    );
    expect(redemptionEligibility(fixture, SUBJECT).status).toBe(200);

    // The provider now reports an empty collaborator list — a complete roster.
    await provider.close();
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );
    const summary = await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    );
    expect(summary.status).toBe("completed");
    expect(summary.members_removed).toBe(1);
    expect(redemptionEligibility(fixture, SUBJECT)).toEqual({
      status: 403,
      reason: "repository_access",
    });
  });

  test("an unreachable provider keeps the last fact as stale — never removed", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [member("push")] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );
    await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    );

    await provider.close();
    provider = await startFakeProvider(exactRoutes({ [REPO_URL]: { status: 500, body: {} } }));

    const error = await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconcileIncompleteError);
    expect((error as ReconcileIncompleteError).code).toBe("PROVIDER_UNAVAILABLE");

    const authority = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      SUBJECT,
    );
    expect(authority?.state).toBe("stale");
    expect(authority?.state).not.toBe("removed");
    expect(redemptionEligibility(fixture, SUBJECT)).toEqual({
      status: 403,
      reason: "authority_stale",
    });
  });

  test("a missing scope is a permission failure, not an empty roster and not a removal", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 401, body: { message: "Bad credentials" } },
      }),
    );

    const deps = { ...reconcileDeps(fixture) };
    const error = await reconcileIntegration(
      deps,
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconcileIncompleteError);
    expect((error as ReconcileIncompleteError).code).toBe("PROVIDER_PERMISSION_MISSING");
    // Nothing was written: the subject was never verified, so no authority
    // row exists and redemption fails closed.
    expect(
      fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, SUBJECT),
    ).toBeUndefined();
    expect(redemptionEligibility(fixture, SUBJECT)).toEqual({
      status: 403,
      reason: "authority_unknown",
    });
  });

  test("an incomplete roster changes no authority", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);

    // First: a complete roster establishes the fact.
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [member("push")] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );
    await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    );
    const before = fixture.access.roster.listRoles(fixture.scope, fixture.integration.id);

    // Then: a truncated page must not touch it.
    const truncated = scriptedAdapter({
      pages: [
        page([role(SUBJECT, "direct_collaborator", "write", "repository:Luthiel/AutoFixer")], {
          truncated: true,
        }),
      ],
    });
    const error = await reconcileIntegration(
      { access: fixture.access, identities: fixture.identity.identities, epoch: fixture.epoch },
      fixture.scope,
      fixture.integration,
      truncated,
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconcileIncompleteError);
    expect((error as ReconcileIncompleteError).code).toBe("PROVIDER_ROSTER_INCOMPLETE");

    const after = fixture.access.roster.listRoles(fixture.scope, fixture.integration.id);
    expect(after).toEqual(before);
    expect(authorityState(fixture)).toBe("stale");
    expect(redemptionEligibility(fixture, SUBJECT).status).toBe(403);
  });

  test("without a service integration nobody has verifiable repository access", async () => {
    const fixture = setupFixture();
    const { userId } = await seedMember(fixture);
    fixture.access.integrations.setStatus(
      fixture.scope,
      fixture.integration.id,
      { install_status: "uninstalled", actor_id: "usr_operator" },
      fixture.integration.version,
    );

    const decision = fixture.gate.authorize({
      scope: fixture.scope,
      user_id: userId,
      action: "read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("authority_unknown");
    expect(decision.requires_reconciliation).toBe(true);
    expect(redemptionEligibility(fixture, SUBJECT)).toEqual({
      status: 403,
      reason: "authority_unknown",
    });
  });
});

function authorityState(fixture: Fixture) {
  return fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, SUBJECT)?.state;
}

describe("gitlab ancestor invisibility degrades to stale, never to removals", () => {
  const GITLAB_CANONICAL = "gitlab:acme/platform/api";
  const GITLAB_PROJECT_URL = "/api/v4/projects/acme%2Fplatform%2Fapi";
  const GITLAB_PARENT_URL = "/api/v4/groups/acme";
  const GITLAB_PROJECT = {
    id: 414,
    path_with_namespace: "acme/platform/api",
    namespace: { id: 57, full_path: "acme/platform", kind: "group" },
  };

  function gitlabReconcileDeps(fixture: Fixture) {
    return {
      access: fixture.access,
      identities: fixture.identity.identities,
      epoch: fixture.epoch,
      clock: () => fixture.clock.now,
      available_token_scope: ["read_api"],
    };
  }

  function gitlabAdapter(fixture: Fixture, baseUrl: string) {
    return createIntegrationAdapter({
      integration: fixture.integration,
      canonical_repository_id: GITLAB_CANONICAL,
      credentials,
      provider_origin: baseUrl,
    });
  }

  function gitlabRoutes(groupMembers: Record<string, unknown>) {
    return exactRoutes({
      [GITLAB_PROJECT_URL]: { status: 200, body: GITLAB_PROJECT },
      [GITLAB_PARENT_URL]: { status: 200, body: { id: 12, full_path: "acme" } },
      "/api/v4/projects/414/members?per_page=100&page=1": {
        status: 200,
        body: [{ id: 900, username: "dev", access_level: 30, state: "active" }],
      },
      "/api/v4/groups/57/members?per_page=100&page=1": { status: 200, body: [] },
      "/api/v4/groups/12/members?per_page=100&page=1": { status: 200, body: [groupMembers] },
    });
  }

  test("a hidden ancestor group leaves the last fact stale and keeps the member", async () => {
    const fixture = setupFixture({ provider_type: "gitlab" });
    const { userId } = addMember(fixture, { subject: "902", login: "ancestor", role: "member" });
    provider = await startFakeProvider(
      gitlabRoutes({ id: 902, username: "ancestor", access_level: 20, state: "active" }),
    );
    const first = await reconcileIntegration(
      gitlabReconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      gitlabAdapter(fixture, provider.base_url),
    );
    expect(first.status).toBe("completed");
    expect(redemptionEligibility(fixture, "902")).toEqual({ status: 200, reason: "ok" });

    // The ancestor group becomes unreadable: its members can no longer be
    // enumerated, so the roster is not complete and nothing may be applied.
    await provider.close();
    provider = await startFakeProvider(
      exactRoutes({
        [GITLAB_PROJECT_URL]: { status: 200, body: GITLAB_PROJECT },
        [GITLAB_PARENT_URL]: { status: 404, body: { message: "404 Group Not Found" } },
      }),
    );

    const error = await reconcileIntegration(
      gitlabReconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      gitlabAdapter(fixture, provider.base_url),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconcileIncompleteError);
    expect((error as ReconcileIncompleteError).code).toBe("PROVIDER_PERMISSION_MISSING");

    const authority = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      "902",
    );
    expect(authority?.state).toBe("stale");
    expect(authority?.user_id).toBe(userId);
    expect(authority?.state).not.toBe("removed");
    expect(redemptionEligibility(fixture, "902")).toEqual({
      status: 403,
      reason: "authority_stale",
    });
  });
});

describe("per-subject refresh before a sensitive action", () => {
  test("a fresh provider confirmation makes the subject active and fresh immediately", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        "/repos/Luthiel/AutoFixer/collaborators/octocat": { status: 200, body: member("push") },
      }),
    );

    const result = await refreshSubjectAuthority(
      {
        access: fixture.access,
        identities: fixture.identity.identities,
        epoch: fixture.epoch,
        clock: () => fixture.clock.now,
      },
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
      SUBJECT,
    );

    expect(result.state).toBe("active");
    expect(result.verified_at).toBe(fixture.clock.now.toISOString());
    expect(redemptionEligibility(fixture, SUBJECT)).toEqual({ status: 200, reason: "ok" });
    // The per-subject query is the exact collaborator path, not a roster sweep.
    expect(provider.urls()).toEqual([REPO_URL, "/repos/Luthiel/AutoFixer/collaborators/octocat"]);
  });

  test("a provider 404 removes authority and revokes capabilities", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [member("push")] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );
    await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    );
    expect(redemptionEligibility(fixture, SUBJECT).status).toBe(200);

    await provider.close();
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        "/repos/Luthiel/AutoFixer/collaborators/octocat": { status: 404, body: {} },
      }),
    );

    const result = await refreshSubjectAuthority(
      { access: fixture.access, epoch: fixture.epoch, clock: () => fixture.clock.now },
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
      SUBJECT,
    );
    expect(result.state).toBe("removed");
    expect(result.revocation?.authority_state).toBe("removed");
    expect(redemptionEligibility(fixture, SUBJECT)).toEqual({
      status: 403,
      reason: "repository_access",
    });
  });

  test("a provider outage leaves stored authority untouched", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);
    provider = await startFakeProvider(
      exactRoutes({
        [REPO_URL]: { status: 200, body: ORG_REPO },
        [COLLABORATORS_URL]: { status: 200, body: [member("push")] },
        [OWNERS_URL]: { status: 200, body: [] },
      }),
    );
    await reconcileIntegration(
      reconcileDeps(fixture),
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
    );
    const before = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      SUBJECT,
    );

    await provider.close();
    provider = await startFakeProvider(exactRoutes({ [REPO_URL]: { status: 429, body: {} } }));

    const error = await refreshSubjectAuthority(
      { access: fixture.access, epoch: fixture.epoch, clock: () => fixture.clock.now },
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
      SUBJECT,
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProviderUnavailableError);

    const after = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      SUBJECT,
    );
    expect(after).toEqual(before);
    expect(after?.state).toBe("active");
  });

  test("an unbound subject is a visibility gap, not a removal", async () => {
    const fixture = setupFixture();
    provider = await startFakeProvider(
      exactRoutes({ [REPO_URL]: { status: 200, body: ORG_REPO } }),
    );

    const error = await refreshSubjectAuthority(
      { access: fixture.access, epoch: fixture.epoch, clock: () => fixture.clock.now },
      fixture.scope,
      fixture.integration,
      realAdapter(fixture, provider.base_url),
      "9999",
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MissingPermissionError);
    expect(
      fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, "9999"),
    ).toBeUndefined();
  });
});

describe("pagination-limit failures stay incomplete", () => {
  test("a roster that exceeds the declared page budget is an incomplete roster", async () => {
    const fixture = setupFixture();
    await seedMember(fixture);
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      role(String(5000 + index), "direct_collaborator", "read", "repository:Luthiel/AutoFixer"),
    );
    const adapter = scriptedAdapter({
      pages: [page(fullPage, { has_more: true, next_cursor: "1" })],
      pages_max: 1,
    });

    const error = await reconcileIntegration(
      { access: fixture.access, identities: fixture.identity.identities, epoch: fixture.epoch },
      fixture.scope,
      fixture.integration,
      adapter,
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ReconcileIncompleteError);
    expect((error as ReconcileIncompleteError).summary.failure_code).toBe(
      "PROVIDER_ROSTER_INCOMPLETE",
    );
    expect((error as ReconcileIncompleteError).message).toContain("pagination_limit");
    // Nothing was written from the partial roster.
    expect(
      fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, SUBJECT),
    ).toBeUndefined();
  });
});
