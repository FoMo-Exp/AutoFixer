import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, beforeEach } from "vitest";

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  createRepositories,
  migrate,
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  ControlPlaneRepositories,
  EnterpriseScope,
  WorkspaceScope,
} from "../src/control-plane/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let db: ControlPlaneDb;
let repos: ControlPlaneRepositories;

const ACTOR = "usr_admin";
const OTHER_ACTOR = "usr_other";

function enterpriseScope(enterpriseId: string, actorId = ACTOR): EnterpriseScope {
  return { enterprise_id: enterpriseId, actor_id: actorId };
}

function workspaceScope(
  enterpriseId: string,
  workspaceId: string,
  actorId = ACTOR,
): WorkspaceScope {
  return { enterprise_id: enterpriseId, workspace_id: workspaceId, actor_id: actorId };
}

/** Seed one enterprise with a provider instance; return the scope and provider ID. */
function bootstrap() {
  const { enterprise, admin_scope } = seedEnterprise(db, {
    enterprise_name: "Test Enterprise",
    enterprise_slug: "test-ent",
    admin_user_id: ACTOR,
  });
  const provider = seedProviderInstance(db, admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  return { enterprise, scope: admin_scope, providerId: provider.id };
}

beforeEach(() => {
  db = openControlPlaneDb(); // in-memory
  repos = createRepositories(db);
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe("Migrations", () => {
  test("creates all tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain("enterprise");
    expect(tables).toContain("provider_instance");
    expect(tables).toContain("workspace");
    expect(tables).toContain("team");
    expect(tables).toContain("membership");
    expect(tables).toContain("schema_migrations");
  });

  test("is idempotent — re-running does not error", () => {
    migrate(db);
    migrate(db);
    migrate(db);
    // Still functional after repeated migration runs.
    const { enterprise } = bootstrap();
    expect(enterprise.slug).toBe("test-ent");
  });

  test("preserves existing data across repeated migration runs", () => {
    const { enterprise } = bootstrap();
    migrate(db);
    migrate(db);
    const found = repos.enterprises.getById(enterprise.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("Test Enterprise");
  });

  test("records applied migration versions", () => {
    const rows = db.prepare("SELECT version FROM schema_migrations").all();
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Enterprise CRUD
// ---------------------------------------------------------------------------

describe("Enterprise", () => {
  test("creates an enterprise with audit fields", () => {
    const ent = repos.enterprises.create({
      name: "Acme",
      slug: "acme",
      actor_id: ACTOR,
    });
    expect(ent.id).toMatch(/^ent_/);
    expect(ent.name).toBe("Acme");
    expect(ent.slug).toBe("acme");
    expect(ent.version).toBe(1);
    expect(ent.created_by).toBe(ACTOR);
    expect(ent.updated_by).toBe(ACTOR);
    expect(ent.created_at).toBe(ent.updated_at);
  });

  test("rejects duplicate slug", () => {
    repos.enterprises.create({ name: "A", slug: "dup", actor_id: ACTOR });
    expect(() => repos.enterprises.create({ name: "B", slug: "dup", actor_id: ACTOR })).toThrow();
  });

  test("gets enterprise by id and slug", () => {
    const ent = repos.enterprises.create({ name: "Find", slug: "find", actor_id: ACTOR });
    expect(repos.enterprises.getById(ent.id)?.id).toBe(ent.id);
    expect(repos.enterprises.getBySlug("find")?.id).toBe(ent.id);
  });

  test("returns undefined for unknown id", () => {
    expect(repos.enterprises.getById("ent_nonexistent")).toBeUndefined();
  });

  test("update with correct version succeeds and bumps version", () => {
    const ent = repos.enterprises.create({ name: "Old", slug: "upd", actor_id: ACTOR });
    const updated = repos.enterprises.update(ent.id, { name: "New" }, 1);
    expect(updated.name).toBe("New");
    expect(updated.version).toBe(2);
  });

  test("update with stale version throws VersionConflictError", () => {
    const ent = repos.enterprises.create({ name: "X", slug: "stale", actor_id: ACTOR });
    repos.enterprises.update(ent.id, { name: "Y" }, 1);
    expect(() => repos.enterprises.update(ent.id, { name: "Z" }, 1)).toThrow(VersionConflictError);
  });

  test("lists enterprises in creation order", () => {
    repos.enterprises.create({ name: "First", slug: "first", actor_id: ACTOR });
    repos.enterprises.create({ name: "Second", slug: "second", actor_id: ACTOR });
    const list = repos.enterprises.list();
    expect(list.length).toBe(2);
    expect(list[0]?.name).toBe("First");
    expect(list[1]?.name).toBe("Second");
  });

  test("validates required fields", () => {
    expect(() => repos.enterprises.create({ name: "", slug: "s", actor_id: ACTOR })).toThrow(
      ValidationError,
    );
    expect(() => repos.enterprises.create({ name: "N", slug: "", actor_id: ACTOR })).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Provider Instance
// ---------------------------------------------------------------------------

describe("ProviderInstance", () => {
  test("creates a provider instance scoped to enterprise", () => {
    const { scope } = bootstrap();
    const pi = repos.providerInstances.getById(scope, repos.providerInstances.list(scope)[0]!.id);
    expect(pi).toBeDefined();
    expect(pi?.provider_type).toBe("github");
    expect(pi?.enterprise_id).toBe(scope.enterprise_id);
  });

  test("lists provider instances in scope", () => {
    const { scope } = bootstrap();
    repos.providerInstances.create(scope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.com",
    });
    const list = repos.providerInstances.list(scope);
    expect(list.length).toBe(2);
  });

  test("rejects cross-enterprise access", () => {
    const { providerId } = bootstrap();
    const otherScope = enterpriseScope("ent_other");
    expect(repos.providerInstances.getById(otherScope, providerId)).toBeUndefined();
    expect(repos.providerInstances.list(otherScope).length).toBe(0);
  });

  test("validates provider_type", () => {
    const { scope } = bootstrap();
    expect(() =>
      repos.providerInstances.create(scope, {
        provider_type: "bitbucket" as never,
        origin_url: "https://bitbucket.org",
      }),
    ).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Workspace: create, repository uniqueness
// ---------------------------------------------------------------------------

describe("Workspace", () => {
  test("creates a workspace with repository binding", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "My Workspace",
      repository_id: "repo_123",
      provider_instance_id: providerId,
    });
    expect(ws.id).toMatch(/^wsp_/);
    expect(ws.name).toBe("My Workspace");
    expect(ws.repository_id).toBe("repo_123");
    expect(ws.status).toBe("active");
    expect(ws.version).toBe(1);
  });

  test("repository_id is immutable — rename does not change it", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Before",
      repository_id: "repo_immutable",
      provider_instance_id: providerId,
    });
    const renamed = repos.workspaces.rename(scope, ws.id, "After", 1);
    expect(renamed.name).toBe("After");
    expect(renamed.repository_id).toBe("repo_immutable");
  });

  test("enforces one active workspace per repository per enterprise", () => {
    const { scope, providerId } = bootstrap();
    repos.workspaces.create(scope, {
      name: "First",
      repository_id: "repo_unique",
      provider_instance_id: providerId,
    });
    expect(() =>
      repos.workspaces.create(scope, {
        name: "Second",
        repository_id: "repo_unique",
        provider_instance_id: providerId,
      }),
    ).toThrow(ConflictError);
  });

  test("same repository in different enterprises is allowed", () => {
    const { providerId } = bootstrap();
    const ent2 = seedEnterprise(db, {
      enterprise_name: "Other",
      enterprise_slug: "other",
      admin_user_id: ACTOR,
    });
    const scope2 = ent2.admin_scope;
    const pi2 = seedProviderInstance(db, scope2, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    // Bootstrap enterprise
    const scope1 = repos.enterprises.getBySlug("test-ent")!;
    const ws1 = repos.workspaces.create(enterpriseScope(scope1.id), {
      name: "E1 WS",
      repository_id: "repo_shared",
      provider_instance_id: providerId,
    });
    const ws2 = repos.workspaces.create(scope2, {
      name: "E2 WS",
      repository_id: "repo_shared",
      provider_instance_id: pi2.id,
    });
    expect(ws1.repository_id).toBe("repo_shared");
    expect(ws2.repository_id).toBe("repo_shared");
  });

  test("archive frees repository for a new active workspace", () => {
    const { scope, providerId } = bootstrap();
    const ws1 = repos.workspaces.create(scope, {
      name: "Original",
      repository_id: "repo_reuse",
      provider_instance_id: providerId,
    });
    repos.workspaces.archive(scope, ws1.id, 1);
    // Now a new workspace can claim the same repository.
    const ws2 = repos.workspaces.create(scope, {
      name: "Successor",
      repository_id: "repo_reuse",
      provider_instance_id: providerId,
    });
    expect(ws2.status).toBe("active");
    expect(ws2.repository_id).toBe("repo_reuse");
  });

  test("restore re-enforces uniqueness — fails if another workspace took the repository", () => {
    const { scope, providerId } = bootstrap();
    const ws1 = repos.workspaces.create(scope, {
      name: "Archived",
      repository_id: "repo_conflict",
      provider_instance_id: providerId,
    });
    repos.workspaces.archive(scope, ws1.id, 1);
    // Another workspace takes the repository.
    repos.workspaces.create(scope, {
      name: "New",
      repository_id: "repo_conflict",
      provider_instance_id: providerId,
    });
    // Restoring the old one must fail.
    expect(() => repos.workspaces.restore(scope, ws1.id, 2)).toThrow(ConflictError);
  });

  test("restore succeeds when repository is free", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "To Restore",
      repository_id: "repo_free",
      provider_instance_id: providerId,
    });
    repos.workspaces.archive(scope, ws.id, 1);
    const restored = repos.workspaces.restore(scope, ws.id, 2);
    expect(restored.status).toBe("active");
    expect(restored.version).toBe(3);
  });

  test("restore on already-active workspace throws ConflictError", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Active",
      repository_id: "repo_active",
      provider_instance_id: providerId,
    });
    expect(() => repos.workspaces.restore(scope, ws.id, 1)).toThrow(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Workspace lifecycle: rename, transfer
// ---------------------------------------------------------------------------

describe("Workspace lifecycle", () => {
  test("rename only changes metadata", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Old Name",
      repository_id: "repo_meta",
      provider_instance_id: providerId,
    });
    const renamed = repos.workspaces.rename(scope, ws.id, "New Name", 1);
    expect(renamed.name).toBe("New Name");
    expect(renamed.repository_id).toBe(ws.repository_id);
    expect(renamed.provider_instance_id).toBe(ws.provider_instance_id);
    expect(renamed.status).toBe(ws.status);
  });

  test("transfer re-binds repository and provider instance", () => {
    const { scope, providerId } = bootstrap();
    const pi2 = repos.providerInstances.create(scope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.com",
    });
    const ws = repos.workspaces.create(scope, {
      name: "Transferable",
      repository_id: "repo_old",
      provider_instance_id: providerId,
    });
    const transferred = repos.workspaces.transfer(
      scope,
      ws.id,
      { repository_id: "repo_new", provider_instance_id: pi2.id },
      1,
    );
    expect(transferred.repository_id).toBe("repo_new");
    expect(transferred.provider_instance_id).toBe(pi2.id);
  });

  test("transfer rejects if new repository conflicts with existing active workspace", () => {
    const { scope, providerId } = bootstrap();
    repos.workspaces.create(scope, {
      name: "Holder",
      repository_id: "repo_taken",
      provider_instance_id: providerId,
    });
    const ws2 = repos.workspaces.create(scope, {
      name: "Mover",
      repository_id: "repo_free2",
      provider_instance_id: providerId,
    });
    expect(() =>
      repos.workspaces.transfer(
        scope,
        ws2.id,
        { repository_id: "repo_taken", provider_instance_id: providerId },
        1,
      ),
    ).toThrow(ConflictError);
  });

  test("transfer does not change enterprise", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Same Ent",
      repository_id: "repo_no_move",
      provider_instance_id: providerId,
    });
    const transferred = repos.workspaces.transfer(
      scope,
      ws.id,
      { repository_id: "repo_no_move_v2", provider_instance_id: providerId },
      1,
    );
    expect(transferred.enterprise_id).toBe(scope.enterprise_id);
  });

  test("rename with stale version throws VersionConflictError", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Versioned",
      repository_id: "repo_versioned",
      provider_instance_id: providerId,
    });
    repos.workspaces.rename(scope, ws.id, "First Rename", 1);
    expect(() => repos.workspaces.rename(scope, ws.id, "Second Rename", 1)).toThrow(
      VersionConflictError,
    );
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement
// ---------------------------------------------------------------------------

describe("Scope enforcement", () => {
  test("cross-enterprise workspace read is rejected (returns undefined)", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Private",
      repository_id: "repo_private",
      provider_instance_id: providerId,
    });
    const foreignScope = enterpriseScope("ent_attacker");
    expect(repos.workspaces.getById(foreignScope, ws.id)).toBeUndefined();
  });

  test("cross-enterprise workspace write is rejected (NotFoundError)", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Protected",
      repository_id: "repo_protected",
      provider_instance_id: providerId,
    });
    const foreignScope = enterpriseScope("ent_attacker");
    expect(() => repos.workspaces.rename(foreignScope, ws.id, "Hacked", 1)).toThrow(NotFoundError);
  });

  test("cross-workspace team read is rejected", () => {
    const { scope, providerId } = bootstrap();
    const ws1 = repos.workspaces.create(scope, {
      name: "WS1",
      repository_id: "repo_ws1",
      provider_instance_id: providerId,
    });
    const ws2 = repos.workspaces.create(scope, {
      name: "WS2",
      repository_id: "repo_ws2",
      provider_instance_id: providerId,
    });
    const ws1Scope = workspaceScope(scope.enterprise_id, ws1.id);
    const team = repos.teams.create(ws1Scope, {
      name: "Team A",
      leader_user_id: "usr_lead",
    });
    const ws2Scope = workspaceScope(scope.enterprise_id, ws2.id);
    expect(repos.teams.getById(ws2Scope, team.id)).toBeUndefined();
    expect(repos.teams.list(ws2Scope).length).toBe(0);
  });

  test("cross-workspace membership read is rejected", () => {
    const { scope, providerId } = bootstrap();
    const ws1 = repos.workspaces.create(scope, {
      name: "WS1",
      repository_id: "repo_m1",
      provider_instance_id: providerId,
    });
    const ws2 = repos.workspaces.create(scope, {
      name: "WS2",
      repository_id: "repo_m2",
      provider_instance_id: providerId,
    });
    const ws1Scope = workspaceScope(scope.enterprise_id, ws1.id);
    const membership = repos.memberships.create(ws1Scope, {
      user_id: "usr_member",
      role: "member",
    });
    const ws2Scope = workspaceScope(scope.enterprise_id, ws2.id);
    expect(repos.memberships.getById(ws2Scope, membership.id)).toBeUndefined();
    expect(repos.memberships.list(ws2Scope).length).toBe(0);
  });

  test("cross-enterprise workspace listing returns empty", () => {
    const { scope, providerId } = bootstrap();
    repos.workspaces.create(scope, {
      name: "Visible",
      repository_id: "repo_visible",
      provider_instance_id: providerId,
    });
    const foreignScope = enterpriseScope("ent_nobody");
    expect(repos.workspaces.list(foreignScope).length).toBe(0);
  });

  test("substituting enterprise ID in scope does not grant access", () => {
    const { enterprise, scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Target",
      repository_id: "repo_target",
      provider_instance_id: providerId,
    });
    // Attacker knows the real enterprise_id but tries to use their own scope.
    const attackerScope = enterpriseScope(enterprise.id, "usr_attacker");
    // Even with the correct enterprise_id, writes require actor authority at a
    // higher layer. The repository scope filter alone blocks cross-enterprise.
    const wrongEntScope = enterpriseScope("ent_forged");
    expect(repos.workspaces.getById(wrongEntScope, ws.id)).toBeUndefined();
    // Correct enterprise_id works (the repository trusts the scope's
    // enterprise_id — authority enforcement happens above the repository).
    expect(repos.workspaces.getById(attackerScope, ws.id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Team CRUD
// ---------------------------------------------------------------------------

describe("Team", () => {
  test("creates a team scoped to workspace", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_team",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const team = repos.teams.create(wsScope, {
      name: "Platform",
      leader_user_id: "usr_leader",
      responsibility: "Core infrastructure",
    });
    expect(team.id).toMatch(/^tem_/);
    expect(team.name).toBe("Platform");
    expect(team.leader_user_id).toBe("usr_leader");
    expect(team.responsibility).toBe("Core infrastructure");
    expect(team.workspace_id).toBe(ws.id);
    expect(team.version).toBe(1);
  });

  test("update team with correct version", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_tu",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const team = repos.teams.create(wsScope, { name: "T", leader_user_id: "u1" });
    const updated = repos.teams.update(wsScope, team.id, { name: "T2", leader_user_id: "u2" }, 1);
    expect(updated.name).toBe("T2");
    expect(updated.leader_user_id).toBe("u2");
    expect(updated.version).toBe(2);
  });

  test("update team with stale version throws", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_ts",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const team = repos.teams.create(wsScope, { name: "T", leader_user_id: "u1" });
    repos.teams.update(wsScope, team.id, { name: "T2" }, 1);
    expect(() => repos.teams.update(wsScope, team.id, { name: "T3" }, 1)).toThrow(
      VersionConflictError,
    );
  });

  test("remove team", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_tr",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const team = repos.teams.create(wsScope, { name: "T", leader_user_id: "u1" });
    repos.teams.remove(wsScope, team.id);
    expect(repos.teams.getById(wsScope, team.id)).toBeUndefined();
  });

  test("lists teams in workspace", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_tl",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    repos.teams.create(wsScope, { name: "A", leader_user_id: "u1" });
    repos.teams.create(wsScope, { name: "B", leader_user_id: "u2" });
    expect(repos.teams.list(wsScope).length).toBe(2);
  });

  test("validates required fields", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_tv",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    expect(() => repos.teams.create(wsScope, { name: "", leader_user_id: "u" })).toThrow(
      ValidationError,
    );
    expect(() => repos.teams.create(wsScope, { name: "T", leader_user_id: "" })).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Membership CRUD
// ---------------------------------------------------------------------------

describe("Membership", () => {
  test("creates a membership scoped to workspace", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_m",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const m = repos.memberships.create(wsScope, { user_id: "usr_dev", role: "member" });
    expect(m.id).toMatch(/^mbr_/);
    expect(m.user_id).toBe("usr_dev");
    expect(m.role).toBe("member");
    expect(m.workspace_id).toBe(ws.id);
  });

  test("rejects duplicate membership for same user in workspace", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_md",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    repos.memberships.create(wsScope, { user_id: "usr_dup", role: "member" });
    expect(() => repos.memberships.create(wsScope, { user_id: "usr_dup", role: "admin" })).toThrow(
      ConflictError,
    );
  });

  test("same user can be in multiple workspaces", () => {
    const { scope, providerId } = bootstrap();
    const ws1 = repos.workspaces.create(scope, {
      name: "WS1",
      repository_id: "repo_mu1",
      provider_instance_id: providerId,
    });
    const ws2 = repos.workspaces.create(scope, {
      name: "WS2",
      repository_id: "repo_mu2",
      provider_instance_id: providerId,
    });
    const scope1 = workspaceScope(scope.enterprise_id, ws1.id);
    const scope2 = workspaceScope(scope.enterprise_id, ws2.id);
    repos.memberships.create(scope1, { user_id: "usr_multi", role: "member" });
    repos.memberships.create(scope2, { user_id: "usr_multi", role: "admin" });
    expect(repos.memberships.getByUser(scope1, "usr_multi")?.role).toBe("member");
    expect(repos.memberships.getByUser(scope2, "usr_multi")?.role).toBe("admin");
  });

  test("updateRole with correct version", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_mr",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const m = repos.memberships.create(wsScope, { user_id: "usr_r", role: "viewer" });
    const updated = repos.memberships.updateRole(wsScope, m.id, "admin", 1);
    expect(updated.role).toBe("admin");
    expect(updated.version).toBe(2);
  });

  test("updateRole with stale version throws", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_ms",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const m = repos.memberships.create(wsScope, { user_id: "usr_s", role: "viewer" });
    repos.memberships.updateRole(wsScope, m.id, "member", 1);
    expect(() => repos.memberships.updateRole(wsScope, m.id, "admin", 1)).toThrow(
      VersionConflictError,
    );
  });

  test("remove membership", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_rm",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const m = repos.memberships.create(wsScope, { user_id: "usr_del", role: "member" });
    repos.memberships.remove(wsScope, m.id);
    expect(repos.memberships.getById(wsScope, m.id)).toBeUndefined();
  });

  test("validates role enum", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_v",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    expect(() =>
      repos.memberships.create(wsScope, { user_id: "u", role: "superuser" as never }),
    ).toThrow(ValidationError);
  });

  test("lists memberships in workspace", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "WS",
      repository_id: "repo_ml",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    repos.memberships.create(wsScope, { user_id: "u1", role: "owner" });
    repos.memberships.create(wsScope, { user_id: "u2", role: "member" });
    expect(repos.memberships.list(wsScope).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Two-workspace isolation (integration)
// ---------------------------------------------------------------------------

describe("Two-workspace isolation", () => {
  test("workspaces cannot see each other's teams or memberships", () => {
    const { scope, providerId } = bootstrap();
    const ws1 = repos.workspaces.create(scope, {
      name: "Workspace Alpha",
      repository_id: "repo_alpha",
      provider_instance_id: providerId,
    });
    const ws2 = repos.workspaces.create(scope, {
      name: "Workspace Beta",
      repository_id: "repo_beta",
      provider_instance_id: providerId,
    });

    const scope1 = workspaceScope(scope.enterprise_id, ws1.id);
    const scope2 = workspaceScope(scope.enterprise_id, ws2.id);

    // Populate both workspaces.
    repos.teams.create(scope1, { name: "Alpha Team", leader_user_id: "usr_a" });
    repos.teams.create(scope2, { name: "Beta Team", leader_user_id: "usr_b" });
    repos.memberships.create(scope1, { user_id: "usr_a", role: "owner" });
    repos.memberships.create(scope2, { user_id: "usr_b", role: "member" });

    // Cross-workspace reads return empty / undefined.
    expect(repos.teams.list(scope2).length).toBe(1); // Only Beta Team
    expect(repos.teams.list(scope2)[0]?.name).toBe("Beta Team");
    expect(repos.memberships.list(scope1).length).toBe(1); // Only usr_a
    expect(repos.memberships.list(scope1)[0]?.user_id).toBe("usr_a");
  });

  test("cross-enterprise isolation: all entity types", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Isolated",
      repository_id: "repo_iso",
      provider_instance_id: providerId,
    });
    const wsScope = workspaceScope(scope.enterprise_id, ws.id);
    const team = repos.teams.create(wsScope, { name: "T", leader_user_id: "u" });
    const membership = repos.memberships.create(wsScope, { user_id: "u", role: "member" });

    // Second enterprise
    const ent2 = seedEnterprise(db, {
      enterprise_name: "Attacker",
      enterprise_slug: "attacker",
      admin_user_id: OTHER_ACTOR,
    });
    const foreignScope = ent2.admin_scope;

    // All reads return empty/undefined for the foreign enterprise.
    expect(repos.workspaces.getById(foreignScope, ws.id)).toBeUndefined();
    expect(repos.workspaces.list(foreignScope).length).toBe(0);
    expect(
      repos.teams.getById(workspaceScope(foreignScope.enterprise_id, ws.id), team.id),
    ).toBeUndefined();
    expect(
      repos.memberships.getById(workspaceScope(foreignScope.enterprise_id, ws.id), membership.id),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Persistence: restart does not lose scope or uniqueness
// ---------------------------------------------------------------------------

describe("Persistence across restart", () => {
  test("data and constraints survive close/reopen", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cp-test-"));
    const dbPath = path.join(dir, "test.db");

    // First "process" — create data.
    const db1 = openControlPlaneDb({ path: dbPath });
    const repos1 = createRepositories(db1);
    const { enterprise: _enterprise, admin_scope } = seedEnterprise(db1, {
      enterprise_name: "Persistent",
      enterprise_slug: "persist",
      admin_user_id: ACTOR,
    });
    const pi = seedProviderInstance(db1, admin_scope, {
      provider_type: "github",
      origin_url: "https://github.com",
    });
    repos1.workspaces.create(admin_scope, {
      name: "Durable",
      repository_id: "repo_durable",
      provider_instance_id: pi.id,
    });
    db1.close();

    // Second "process" — reopen and verify.
    const db2 = openControlPlaneDb({ path: dbPath });
    const repos2 = createRepositories(db2);
    const ent = repos2.enterprises.getBySlug("persist");
    expect(ent).toBeDefined();
    const scope2 = enterpriseScope(ent!.id);
    const ws = repos2.workspaces.getByRepositoryId(scope2, "repo_durable");
    expect(ws).toBeDefined();
    expect(ws?.name).toBe("Durable");

    // Uniqueness constraint still enforced after restart.
    expect(() =>
      repos2.workspaces.create(scope2, {
        name: "Duplicate",
        repository_id: "repo_durable",
        provider_instance_id: pi.id,
      }),
    ).toThrow(ConflictError);
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// Optimistic concurrency: concurrent create/archive
// ---------------------------------------------------------------------------

describe("Concurrent operations", () => {
  test("rapid archive/restore cycles maintain version integrity", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Concurrent",
      repository_id: "repo_conc",
      provider_instance_id: providerId,
    });

    // Simulate a sequence of operations with incrementing versions.
    let version = 1;
    for (let i = 0; i < 5; i++) {
      const archived = repos.workspaces.archive(scope, ws.id, version);
      expect(archived.status).toBe("archived");
      version = archived.version;
      const restored = repos.workspaces.restore(scope, ws.id, version);
      expect(restored.status).toBe("active");
      version = restored.version;
    }
    expect(version).toBe(11); // 1 + 5*2
  });

  test("stale version on archive throws", () => {
    const { scope, providerId } = bootstrap();
    const ws = repos.workspaces.create(scope, {
      name: "Stale",
      repository_id: "repo_stale",
      provider_instance_id: providerId,
    });
    repos.workspaces.archive(scope, ws.id, 1);
    expect(() => repos.workspaces.archive(scope, ws.id, 1)).toThrow(VersionConflictError);
  });
});

// ---------------------------------------------------------------------------
// Seed idempotency
// ---------------------------------------------------------------------------

describe("Seed", () => {
  test("seedEnterprise is idempotent", () => {
    const first = seedEnterprise(db, {
      enterprise_name: "Idem",
      enterprise_slug: "idem",
      admin_user_id: ACTOR,
    });
    const second = seedEnterprise(db, {
      enterprise_name: "Idem Different Name",
      enterprise_slug: "idem",
      admin_user_id: OTHER_ACTOR,
    });
    expect(second.enterprise.id).toBe(first.enterprise.id);
    // The second call returns the existing enterprise — no duplicate is created.
    expect(repos.enterprises.list().length).toBe(1);
  });

  test("seedWorkspace creates workspace with binding", () => {
    const { scope, providerId } = bootstrap();
    const ws = seedWorkspace(db, scope, {
      name: "Seeded",
      repository_id: "repo_seeded",
      provider_instance_id: providerId,
    });
    expect(ws.name).toBe("Seeded");
    expect(ws.status).toBe("active");
  });
});
