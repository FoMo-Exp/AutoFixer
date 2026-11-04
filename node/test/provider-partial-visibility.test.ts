/**
 * Partial permission visibility in reconciliation (DAT-248).
 *
 * A `partial` roster is a successful fetch, not a complete truth: at least one
 * access path cannot be enumerated. Absence from it must therefore never
 * become `removed` — the stored authority and its capability grants survive,
 * the authority is marked `stale` (sensitive actions then require a
 * per-subject verification), and provenance rows are not pruned either. Only
 * `full` visibility may turn absence into removal.
 *
 * The effective visibility of one run is the more restrictive of the
 * integration record and the adapter declaration, so neither side can widen
 * the guarantee the other refuses to give.
 */

import { describe, expect, test } from "vitest";

import {
  ReconcileIncompleteError,
  reconcileIntegration,
} from "../src/provider-access/reconcile.js";
import { refreshSubjectAuthority } from "../src/provider-access/subject-refresh.js";
import type { RawProviderRole } from "../src/provider-access/types.js";
import {
  addMember,
  page,
  role,
  scriptedAdapter,
  setupFixture,
  verifyAuthority,
  type Fixture,
} from "./helpers/provider-access.js";

const SUBJECT = "4242";
const LOGIN = "octocat";
const REPO_ID = "github:repo:9001";
const NOW = "2026-11-03T12:00:00.000Z";
const LATER = "2026-11-03T13:00:00.000Z";

function reconcileDeps(fixture: Fixture) {
  return {
    access: fixture.access,
    identities: fixture.identity.identities,
    epoch: fixture.epoch,
    clock: () => fixture.clock.now,
  };
}

function rosterPage(entries: RawProviderRole[]) {
  return page(entries);
}

function reconcile(fixture: Fixture, adapter = scriptedAdapter()) {
  return reconcileIntegration(reconcileDeps(fixture), fixture.scope, fixture.integration, adapter);
}

function authorityOf(fixture: Fixture, subject: string) {
  return fixture.access.roster.getAuthority(fixture.scope, fixture.integration.id, subject);
}

function deliveryGrant(fixture: Fixture, userId: string) {
  return fixture.access.grants.grant(fixture.scope, fixture.integration.id, {
    grantee_user_id: userId,
    capability: "delivery_write",
    branch_scope: "main",
    expires_at: "2026-11-04T12:00:00.000Z",
    actor_id: fixture.scope.actor_id,
  });
}

describe("partial visibility keeps unobserved authority", () => {
  test("an absent subject keeps its fact and grants, marked stale instead of removed", async () => {
    const fixture = setupFixture();
    const { userId } = addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });
    const grant = deliveryGrant(fixture, userId);

    // First run: the subject is enumerated, so authority is active and fresh.
    const first = await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "partial",
        pages: [rosterPage([role(SUBJECT, "direct_collaborator", "write", REPO_ID)])],
      }),
    );
    expect(first.status).toBe("completed");
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("active");

    // Second run: the subject is not enumerated at all. Under `full` this is
    // removal; under `partial` it is simply outside this roster's coverage.
    fixture.clock.now = new Date(LATER);
    const second = await reconcile(fixture, scriptedAdapter({ visibility: "partial" }));

    expect(second.status).toBe("completed");
    expect(second.visibility).toBe("partial");
    expect(second.members_removed).toBe(0);
    expect(second.authority_unobserved).toBe(1);
    expect(second.revocations).toEqual([]);

    const authority = authorityOf(fixture, SUBJECT);
    expect(authority?.state).toBe("stale");
    expect(authority?.state).not.toBe("removed");
    expect(authority?.user_id).toBe(userId);

    // Capability grants are revoked only by an actual revocation.
    expect(fixture.access.grants.getById(fixture.scope, grant.id)?.revoked_at ?? null).toBeNull();
    expect(
      fixture.access.grants.listLive(fixture.scope, fixture.integration.id, {
        capability: "delivery_write",
        now: LATER,
      }),
    ).toHaveLength(1);
  });

  test("subjects the partial roster does observe are verified active and fresh", async () => {
    const fixture = setupFixture({ permission_visibility: "partial" });
    addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });
    addMember(fixture, { subject: "5252", login: "other", role: "member" });

    const summary = await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "partial",
        pages: [rosterPage([role(SUBJECT, "direct_collaborator", "write", REPO_ID)])],
      }),
    );

    expect(summary.visibility).toBe("partial");
    expect(summary.authority_unobserved).toBe(0);
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("active");
  });

  test("provenance rows are not pruned from a partial roster", async () => {
    const fixture = setupFixture();
    addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });

    // Established provenance: a team-inherited grant.
    await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "full",
        pages: [rosterPage([role(SUBJECT, "inherited_role", "write", "team:11")])],
      }),
    );
    expect(
      fixture.access.roster
        .listRoles(fixture.scope, fixture.integration.id)
        .map((row) => row.authority_ref),
    ).toEqual(["team:11"]);

    // The partial roster sees the same subject through another source. A full
    // roster would prune the vanished provenance key; a partial one must not —
    // it does not claim to have seen every key.
    const summary = await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "partial",
        pages: [rosterPage([role(SUBJECT, "effective_access", "write", REPO_ID)])],
      }),
    );

    expect(summary.roles_pruned).toBe(0);
    expect(
      fixture.access.roster
        .listRoles(fixture.scope, fixture.integration.id)
        .map((row) => row.authority_ref)
        .sort(),
    ).toEqual([REPO_ID, "team:11"].sort());
  });
});

describe("effective visibility is the more restrictive declaration", () => {
  test("an integration recorded as partial keeps that guarantee even if the adapter claims full", async () => {
    const fixture = setupFixture({ permission_visibility: "partial" });
    addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });

    await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "full",
        pages: [rosterPage([role(SUBJECT, "direct_collaborator", "write", REPO_ID)])],
      }),
    );
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("active");

    const summary = await reconcile(fixture, scriptedAdapter({ visibility: "full" }));

    expect(summary.visibility).toBe("partial");
    expect(summary.members_removed).toBe(0);
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("stale");
  });

  test("an adapter that can only prove a partial roster bounds a full integration", async () => {
    const fixture = setupFixture({ permission_visibility: "full" });
    const { userId } = addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });
    deliveryGrant(fixture, userId);

    await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "full",
        pages: [rosterPage([role(SUBJECT, "direct_collaborator", "write", REPO_ID)])],
      }),
    );

    const summary = await reconcile(fixture, scriptedAdapter({ visibility: "partial" }));

    expect(summary.visibility).toBe("partial");
    expect(summary.members_removed).toBe(0);
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("stale");
    expect(
      fixture.access.grants.listLive(fixture.scope, fixture.integration.id, {
        grantee_user_id: userId,
        now: LATER,
      }),
    ).toHaveLength(1);
  });

  test("an integration that cannot verify permissions makes the run incomplete and removes nobody", async () => {
    const fixture = setupFixture({ permission_visibility: "none" });
    const { userId } = addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });
    verifyAuthority(fixture, SUBJECT, userId, NOW);

    const error = await reconcile(fixture, scriptedAdapter({ visibility: "full" })).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ReconcileIncompleteError);
    expect((error as ReconcileIncompleteError).code).toBe("PROVIDER_PERMISSION_MISSING");
    expect((error as ReconcileIncompleteError).summary.visibility).toBe("none");
    expect((error as ReconcileIncompleteError).summary.members_removed).toBe(0);

    const authority = authorityOf(fixture, SUBJECT);
    expect(authority?.state).toBe("stale");
    expect(authority?.state).not.toBe("removed");
  });
});

describe("full visibility still removes absent subjects", () => {
  test("the same absence becomes a revocation when the roster claims completeness", async () => {
    const fixture = setupFixture();
    const { userId } = addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });
    const grant = deliveryGrant(fixture, userId);

    const first = await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "full",
        pages: [rosterPage([role(SUBJECT, "direct_collaborator", "write", REPO_ID)])],
      }),
    );
    expect(first.members_added).toBe(1);

    const summary = await reconcile(fixture, scriptedAdapter({ visibility: "full" }));

    expect(summary.visibility).toBe("full");
    expect(summary.members_removed).toBe(1);
    expect(summary.authority_unobserved).toBe(0);
    expect(summary.revocations).toHaveLength(1);
    // Removal is a fact: the authority row stays, in the terminal state.
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("removed");
    expect(
      fixture.access.roster
        .listRoles(fixture.scope, fixture.integration.id)
        .filter((row) => row.subject === SUBJECT),
    ).toEqual([]);
    expect(fixture.access.grants.getById(fixture.scope, grant.id)?.revoked_at).not.toBeNull();
  });
});

describe("a partial roster is not the only way to establish a removal", () => {
  test("a per-subject verification still revokes what the provider positively denies", async () => {
    const fixture = setupFixture({ permission_visibility: "partial" });
    const { userId } = addMember(fixture, { subject: SUBJECT, login: LOGIN, role: "member" });
    const grant = deliveryGrant(fixture, userId);

    await reconcile(
      fixture,
      scriptedAdapter({
        visibility: "partial",
        pages: [rosterPage([role(SUBJECT, "direct_collaborator", "write", REPO_ID)])],
      }),
    );
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("active");

    // `partial` stops batch reconciliation from turning absence into removal.
    // A per-subject query that positively answers "no permission" is still a
    // completed fact, so it revokes — the gap must not become permanent.
    const refreshed = await refreshSubjectAuthority(
      {
        access: fixture.access,
        epoch: fixture.epoch,
        identities: fixture.identity.identities,
        clock: () => fixture.clock.now,
      },
      fixture.scope,
      fixture.integration,
      scriptedAdapter({ visibility: "partial", effective: { [SUBJECT]: null } }),
      SUBJECT,
    );

    expect(refreshed.state).toBe("removed");
    expect(authorityOf(fixture, SUBJECT)?.state).toBe("removed");
    expect(fixture.access.grants.getById(fixture.scope, grant.id)?.revoked_at).not.toBeNull();
  });
});
