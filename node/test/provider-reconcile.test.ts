import { beforeEach, describe, expect, test } from "vitest";

import {
  ReconcileIncompleteError,
  applyProviderEvent,
  reconcileIntegration,
} from "../src/provider-access/reconcile.js";
import type {
  ProviderEvent,
  ProviderEventType,
} from "../src/control-plane/provider-access-types.js";
import {
  NOW,
  addMember,
  page,
  role,
  scriptedAdapter,
  setupFixture,
  type Fixture,
} from "./helpers/provider-access.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = setupFixture();
});

const DEPS = () => ({
  access: fixture.access,
  identities: fixture.identity.identities,
  epoch: fixture.epoch,
  clock: () => fixture.clock.now,
});

function event(
  eventType: ProviderEventType,
  payload: Record<string, unknown>,
  deliveryId?: string,
): ProviderEvent {
  return {
    id: "evt_in",
    enterprise_id: fixture.scope.enterprise_id,
    provider_instance_id: fixture.providerInstanceId,
    integration_id: fixture.integration.id,
    repository_id: fixture.integration.repository_id,
    event_type: eventType,
    payload,
    delivery_id: deliveryId ?? null,
    received_at: NOW,
    processed_at: null,
  };
}

describe("periodic reconciliation", () => {
  test("a complete roster verifies authority and records provenance", async () => {
    const adapter = scriptedAdapter({
      pages: [
        page(
          [
            role("7001", "org_owner", "owner", "org:700"),
            role("7002", "inherited_role", "write", "team:42", { inherited_from: "org:700" }),
          ],
          { has_more: true, next_cursor: "1" },
        ),
        page([role("7003", "direct_collaborator", "read", "github:repo:9001")]),
      ],
    });
    const summary = await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      adapter,
      {
        now: new Date(NOW),
      },
    );

    expect(summary.status).toBe("completed");
    expect(summary.pages_seen).toBe(2);
    expect(summary.roster_size).toBe(3);
    expect(summary.members_added).toBe(3);

    const roles = fixture.access.roster.listRoles(fixture.scope, fixture.integration.id);
    expect(roles.map((row) => row.source_kind).sort()).toEqual([
      "direct_collaborator",
      "inherited_role",
      "org_owner",
    ]);
    // Org-owned repository: the org is the authority, never a repo owner user.
    const orgRow = roles.find((row) => row.source_kind === "org_owner");
    expect(orgRow?.authority_ref).toBe("org:700");
    expect(
      roles.some(
        (row) => row.provider_role === "owner" && row.source_kind === "direct_collaborator",
      ),
    ).toBe(false);

    for (const subject of ["7001", "7002", "7003"]) {
      expect(
        fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, subject)?.state,
      ).toBe("active");
    }
  });

  test("member removal on reconcile revokes authority and capability grants", async () => {
    const { userId } = addMember(fixture, { subject: "7010", login: "gone", role: "member" });
    // Initial verified roster: two members.
    await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [
          page([
            role("7010", "direct_collaborator", "write", "github:repo:9001"),
            role("7011", "direct_collaborator", "read", "github:repo:9001"),
          ]),
        ],
      }),
      { now: new Date(NOW) },
    );
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "delivery_write",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });

    // Provider now reports only 7011.
    const summary = await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [page([role("7011", "direct_collaborator", "read", "github:repo:9001")])],
      }),
      { now: new Date("2026-11-03T12:30:00.000Z") },
    );

    expect(summary.members_removed).toBe(1);
    expect(summary.revocations).toHaveLength(1);
    expect(summary.revocations[0]?.stopped_actions).toEqual([
      "read",
      "stream",
      "artifact_read",
      "approval",
      "write",
    ]);

    const authority = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      "7010",
    );
    expect(authority?.state).toBe("removed");
    // Capability grants died with the authority.
    const live = fixture.access.grants.listLive(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      now: "2026-11-03T12:31:00.000Z",
    });
    expect(live).toHaveLength(0);
  });

  test("stale authority: an incomplete roster run marks authority stale and removes nobody", async () => {
    await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [page([role("7020", "direct_collaborator", "write", "github:repo:9001")])],
      }),
      { now: new Date(NOW) },
    );

    // Next run fails to complete (truncated pagination).
    const failing = scriptedAdapter({
      pages: [
        page([role("7021", "direct_collaborator", "read", "github:repo:9001")], {
          truncated: true,
        }),
      ],
    });
    await expect(
      reconcileIntegration(DEPS(), fixture.scope, fixture.integration, failing, {
        now: new Date("2026-11-03T12:30:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ReconcileIncompleteError);

    // The recorded member is stale — not removed, not silently allowed for
    // sensitive actions — and the failed fetch changed no roster row.
    const authority = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      "7020",
    );
    expect(authority?.state).toBe("stale");
    expect(
      fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, "7021"),
    ).toBeUndefined();
    const roles = fixture.access.roster.listRoles(fixture.scope, fixture.integration.id);
    expect(roles.map((row) => row.subject)).toEqual(["7020"]);

    const runs = fixture.access.reconcileRuns.list(fixture.scope, fixture.integration.id);
    expect(runs[0]?.status).toBe("incomplete");
    expect(runs[0]?.failure_code).toBe("PROVIDER_ROSTER_INCOMPLETE");
  });

  test("missing effective-permission visibility fails the run explicitly", async () => {
    const run = reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({ visibility: "none" }),
      { now: new Date(NOW) },
    );
    await expect(run).rejects.toMatchObject({ code: "PROVIDER_PERMISSION_MISSING" });
    const runs = fixture.access.reconcileRuns.list(fixture.scope, fixture.integration.id);
    expect(runs[0]?.status).toBe("incomplete");
    expect(runs[0]?.failure_code).toBe("PROVIDER_PERMISSION_MISSING");
  });

  test("incomplete pagination never applies the partial page it did fetch", async () => {
    const adapter = scriptedAdapter({
      pages_max: 1,
      pages: [
        page([role("7030", "direct_collaborator", "write", "github:repo:9001")], {
          has_more: true,
          next_cursor: "1",
        }),
      ],
    });
    await expect(
      reconcileIntegration(DEPS(), fixture.scope, fixture.integration, adapter, {
        now: new Date(NOW),
      }),
    ).rejects.toBeInstanceOf(ReconcileIncompleteError);
    // Page one's member was never written.
    expect(fixture.access.roster.listRoles(fixture.scope, fixture.integration.id)).toHaveLength(0);
    expect(fixture.access.roster.listAuthority(fixture.scope, fixture.integration.id)).toHaveLength(
      0,
    );
  });

  test("a normalization refusal aborts the run like an incomplete roster", async () => {
    const adapter = scriptedAdapter({
      pages: [page([role("7040", "direct_collaborator", "owner", "github:repo:9001")])],
    });
    await expect(
      reconcileIntegration(DEPS(), fixture.scope, fixture.integration, adapter, {
        now: new Date(NOW),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ROLE_INVALID" });
    expect(fixture.access.roster.listRoles(fixture.scope, fixture.integration.id)).toHaveLength(0);
  });
});

describe("provider event sync", () => {
  test("member_removed revokes authority and grants in the same call", async () => {
    const { userId } = addMember(fixture, { subject: "8001", login: "removed", role: "admin" });
    await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [page([role("8001", "direct_collaborator", "admin", "github:repo:9001")])],
      }),
      { now: new Date(NOW) },
    );
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "checkout_read",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });

    const result = applyProviderEvent(
      DEPS(),
      fixture.scope,
      fixture.integration,
      event("member_removed", { subject: "8001" }, "delivery-1"),
    );

    expect(result.applied).toBe(true);
    expect(result.revocation?.authority_state).toBe("removed");
    expect(result.revocation?.revoked_grants).toHaveLength(1);
    // The roster row is gone and the authority record is terminal.
    expect(fixture.access.roster.listRoles(fixture.scope, fixture.integration.id)).toHaveLength(0);
    expect(
      fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, "8001")?.state,
    ).toBe("removed");
  });

  test("replayed events are idempotent on the provider delivery id", () => {
    const first = applyProviderEvent(
      DEPS(),
      fixture.scope,
      fixture.integration,
      event(
        "member_added",
        {
          subject: "8002",
          login: "new",
          source_kind: "direct_collaborator",
          provider_role: "read",
          authority_ref: "github:repo:9001",
        },
        "delivery-2",
      ),
    );
    const replay = applyProviderEvent(
      DEPS(),
      fixture.scope,
      fixture.integration,
      event(
        "member_added",
        {
          subject: "8002",
          login: "new",
          source_kind: "direct_collaborator",
          provider_role: "read",
          authority_ref: "github:repo:9001",
        },
        "delivery-2",
      ),
    );
    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.duplicate).toBe(true);
    // Applied exactly once.
    expect(fixture.access.roster.listRoles(fixture.scope, fixture.integration.id)).toHaveLength(1);
  });

  test("rename is metadata only: authority and credentials are untouched", async () => {
    await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [page([role("8010", "direct_collaborator", "write", "github:repo:9001")])],
      }),
      { now: new Date(NOW) },
    );
    const before = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      "8010",
    );

    applyProviderEvent(
      DEPS(),
      fixture.scope,
      fixture.integration,
      event("repository_renamed", { repository_name: "Luthiel/AutoFixer-2" }, "delivery-3"),
    );

    const integration = fixture.access.integrations.getById(fixture.scope, fixture.integration.id);
    expect(integration?.repository_name).toBe("Luthiel/AutoFixer-2");
    expect(integration?.repository_id).toBe(fixture.integration.repository_id);
    // Credential references unchanged.
    expect(integration?.source_credential_ref).toBe(fixture.integration.source_credential_ref);
    expect(integration?.checkout_credential_ref).toBe(fixture.integration.checkout_credential_ref);
    expect(integration?.delivery_credential_ref).toBe(fixture.integration.delivery_credential_ref);
    // Authority untouched by a rename.
    const after = fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, "8010");
    expect(after?.state).toBe("active");
    expect(after?.last_verified_at).toBe(before?.last_verified_at);
  });

  test("transfer rebinds the repository, resets authority, and never expands credentials", async () => {
    const { userId } = addMember(fixture, { subject: "8020", login: "moved", role: "member" });
    await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [page([role("8020", "direct_collaborator", "write", "github:repo:9001")])],
      }),
      { now: new Date(NOW) },
    );
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "delivery_write",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });

    const result = applyProviderEvent(
      DEPS(),
      fixture.scope,
      fixture.integration,
      event(
        "repository_transferred",
        {
          repository_id: "github:repo:9002",
          repository_name: "NewOrg/AutoFixer",
        },
        "delivery-4",
      ),
    );

    expect(result.authority_reset).toBe(1);
    const integration = fixture.access.integrations.getById(fixture.scope, fixture.integration.id);
    expect(integration?.repository_id).toBe("github:repo:9002");
    // Transfer never silently expands or replaces credentials.
    expect(integration?.source_credential_ref).toBe(fixture.integration.source_credential_ref);
    expect(integration?.checkout_credential_ref).toBe(fixture.integration.checkout_credential_ref);
    expect(integration?.delivery_credential_ref).toBe(fixture.integration.delivery_credential_ref);

    // Authority requires revalidation: unknown blocks every action...
    const authority = fixture.access.roster.getAuthority(
      fixture.scope,
      fixture.integration.id,
      "8020",
    );
    expect(authority?.state).toBe("unknown");
    // ...and write capability is gone until re-granted after validation.
    const live = fixture.access.grants.listLive(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      now: "2026-11-03T12:31:00.000Z",
    });
    expect(live).toHaveLength(0);
  });

  test("integration suspension stops everything and revokes all grants", async () => {
    const { userId } = addMember(fixture, { subject: "8030", login: "halted", role: "member" });
    await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [page([role("8030", "direct_collaborator", "write", "github:repo:9001")])],
      }),
      { now: new Date(NOW) },
    );
    fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
      grantee_user_id: userId,
      capability: "checkout_read",
      expires_at: "2026-11-03T13:00:00.000Z",
      actor_id: "usr_operator",
    });

    applyProviderEvent(
      DEPS(),
      fixture.scope,
      fixture.integration,
      event("integration_suspended", {}, "delivery-5"),
    );

    const integration = fixture.access.integrations.getById(fixture.scope, fixture.integration.id);
    expect(integration?.install_status).toBe("suspended");
    expect(
      fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, "8030")?.state,
    ).toBe("unknown");
    expect(
      fixture.access.grants.listLive(fixture.scope, fixture.integration.id, {
        grantee_user_id: userId,
        now: "2026-11-03T12:31:00.000Z",
      }),
    ).toHaveLength(0);
  });

  test("role_changed updates the provenance row and re-verifies", async () => {
    await reconcileIntegration(
      DEPS(),
      fixture.scope,
      fixture.integration,
      scriptedAdapter({
        pages: [page([role("8040", "direct_collaborator", "read", "github:repo:9001")])],
      }),
      { now: new Date(NOW) },
    );

    applyProviderEvent(
      DEPS(),
      fixture.scope,
      fixture.integration,
      event(
        "role_changed",
        {
          subject: "8040",
          login: "login-8040",
          source_kind: "direct_collaborator",
          provider_role: "maintain",
          authority_ref: "github:repo:9001",
        },
        "delivery-6",
      ),
    );

    const roles = fixture.access.roster.listRoles(fixture.scope, fixture.integration.id);
    expect(roles).toHaveLength(1);
    expect(roles[0]?.provider_role).toBe("maintain");
    expect(
      fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, "8040")?.state,
    ).toBe("active");
  });
});
