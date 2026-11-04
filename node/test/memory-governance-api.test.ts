import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createRepositories, seedWorkspace } from "../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../src/control-plane/index.js";
import { createMemoryLifecycleStore } from "../src/memory/index.js";
import type {
  MemoryGovernanceResult,
  MemoryItemEventsView,
  MemoryItemVersionsView,
  MemoryItemView,
  MemoryItemsPage,
} from "../src/memory/index.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import { getJson, postJson } from "./helpers/http.js";

/**
 * DAT-251 HTTP contract: the memory governance surface. These tests drive the
 * real orchestrator, session store, scoped memory repositories, lifecycle
 * store, and route handler. No dsh process is needed — governance never
 * executes anything.
 *
 * The permission matrix is exercised cell by cell: owner, admin, team leader
 * for its own and another team, member, viewer, agent credential, and a
 * cross-workspace id. Redaction, per-version sensitivity, the audit timeline,
 * transitions, and concurrency are each asserted on the real wire bodies.
 */

const MISSING_DSH = {
  socketPath: path.join(process.env["TMPDIR"] ?? "/tmp", "dat-251-no-such-dsh.sock"),
};

let app: AuthApp;
let session: LoggedInSession;
let db: ControlPlaneDb;
let scope: WorkspaceScope;
let lifecycle: ReturnType<typeof createMemoryLifecycleStore>;
let teamAlphaId: string;
let teamBetaId: string;
let foreignWorkspaceId: string;

interface ItemOptions {
  kind?: "fact" | "lesson" | "policy";
  teamId?: string;
  sensitivity?: "internal" | "confidential" | "restricted";
  statement?: string;
  evidence?: boolean;
  status?: "proposed" | "candidate" | "active";
}

function memoryUrl(suffix: string, workspaceId = app.workspaceId): string {
  return `${app.base}/api/v1/workspaces/${workspaceId}/memory/${suffix}`;
}

function itemUrl(itemId: string, suffix = ""): string {
  return memoryUrl(`items/${itemId}${suffix === "" ? "" : `/${suffix}`}`);
}

function sessionHeaders(): Record<string, string> {
  return cookieSessionHeaders(session);
}

function setRole(role: "owner" | "admin" | "member" | "viewer"): void {
  const repos = createRepositories(db);
  const membership = repos.memberships.getByUser(scope, session.userId);
  if (membership === undefined) {
    repos.memberships.create(scope, { user_id: session.userId, role });
    return;
  }
  repos.memberships.updateRole(scope, membership.id, role, membership.version);
}

function repos() {
  return createRepositories(db);
}

/**
 * Build one item and walk it to the requested status through the storage state
 * machine (create -> candidate -> active), so the fixture respects the real
 * transitions and evidence rule.
 */
function createItem(options: ItemOptions = {}): string {
  const memory = app.orchestrator.memoryRepositories;
  if (memory === undefined) {
    throw new Error("memory repositories are not wired");
  }
  const kind = options.kind ?? "fact";
  const created = memory.items.create(scope, {
    kind,
    scope: options.teamId !== undefined ? { team_id: options.teamId } : {},
    statement: options.statement ?? `DAT-251 fixture ${kind}`,
    preconditions: options.statement === undefined ? [] : ["reviewed in a test"],
    provenance: { author_type: "human" },
    trust: "human",
    sensitivity: options.sensitivity ?? "internal",
    valid_from: "2026-11-01T00:00:00.000Z",
    valid_to: null,
  });
  if (options.evidence !== false) {
    memory.evidence.add(scope, created.item.id, {
      evidence_type: "reviewer_decision",
      reference: "pr:dat-251",
    });
  }
  const target = options.status ?? "candidate";
  if (target === "candidate" || target === "active") {
    memory.items.setStatus(scope, created.item.id, "candidate", 1);
  }
  if (target === "active") {
    memory.items.setStatus(scope, created.item.id, "active", 1);
  }
  return created.item.id;
}

function transition(itemId: string, action: string, body: Record<string, unknown>) {
  return postJson<MemoryGovernanceResult & { error?: { code: string; details: unknown } }>(
    itemUrl(itemId, action),
    body,
    sessionHeaders(),
  );
}

async function detail(itemId: string): Promise<MemoryItemView> {
  const response = await getJson<MemoryItemView>(itemUrl(itemId), sessionHeaders());
  expect(response.status).toBe(200);
  return response.body;
}

beforeAll(async () => {
  app = await startAuthApp({ dsh: MISSING_DSH as never });
  db = app.orchestrator.controlPlane as ControlPlaneDb;
  scope = {
    enterprise_id: app.enterpriseId,
    workspace_id: app.workspaceId,
    actor_id: "usr_seed",
  };
  lifecycle = createMemoryLifecycleStore(db);
  session = await webLogin(app);
  setRole("owner");

  const control = repos();
  const alpha = control.teams.create(scope, {
    name: "Alpha",
    leader_user_id: session.userId,
  });
  teamAlphaId = alpha.id;
  const beta = control.teams.create(scope, {
    name: "Beta",
    leader_user_id: "usr_someone_else",
  });
  teamBetaId = beta.id;

  // A second workspace in the same enterprise, so a cross-workspace id is a
  // real id in a real workspace the caller can still not reach.
  const foreign = seedWorkspace(
    db,
    { enterprise_id: app.enterpriseId, actor_id: "usr_seed" },
    {
      name: "Other Workspace",
      repository_id: "repo-other",
      provider_instance_id: app.providerInstanceId,
    },
  );
  foreignWorkspaceId = foreign.id;
});

afterAll(async () => {
  await app?.stop();
});

describe("browse filters and detail", () => {
  test("keeps the DAT-236 browse contract when no filter is sent", async () => {
    const itemId = createItem({ statement: "keep the old browse shape" });
    const response = await getJson<MemoryItemsPage>(memoryUrl("items"), sessionHeaders());
    expect(response.status).toBe(200);
    const item = response.body.items.find((entry) => entry.item_id === itemId);
    expect(item).toBeDefined();
    // DAT-236 fields keep their type and meaning.
    expect(item?.statement).toBe("keep the old browse shape");
    expect(item?.current_version).toBe(1);
    expect(item?.evidence.length).toBeGreaterThan(0);
    // DAT-251 adds optional fields without changing existing ones.
    expect(item?.statement_redacted).toBe(false);
    expect(item?.provenance?.author_type).toBe("human");
    expect(item?.review).toBeNull();
  });

  test("filters by team, trust, and sensitivity without widening the ceiling", async () => {
    const alphaItem = createItem({ teamId: teamAlphaId, statement: "alpha team item" });
    const betaItem = createItem({ teamId: teamBetaId, statement: "beta team item" });

    const byTeam = await getJson<MemoryItemsPage>(
      memoryUrl(`items?team_id=${teamAlphaId}`),
      sessionHeaders(),
    );
    expect(byTeam.status).toBe(200);
    const ids = byTeam.body.items.map((entry) => entry.item_id);
    expect(ids).toContain(alphaItem);
    expect(ids).not.toContain(betaItem);

    const byTrust = await getJson<MemoryItemsPage>(
      memoryUrl("items?trust=agent"),
      sessionHeaders(),
    );
    expect(byTrust.status).toBe(200);
    expect(byTrust.body.items.every((entry) => entry.trust === "agent")).toBe(true);

    setRole("member");
    const acrossCeiling = await getJson<MemoryItemsPage>(
      memoryUrl("items?sensitivity=confidential"),
      sessionHeaders(),
    );
    // The filter narrows; it never widens what a member may read.
    expect(acrossCeiling.body.items).toHaveLength(0);
    setRole("owner");
  });

  test("serves one item, and hides restricted items from this surface entirely", async () => {
    const itemId = createItem({ statement: "deep link me" });
    expect((await detail(itemId)).statement).toBe("deep link me");

    const restrictedId = createItem({
      sensitivity: "restricted",
      statement: "restricted material",
    });
    const hidden = await getJson<{ error: { code: string } }>(
      itemUrl(restrictedId),
      sessionHeaders(),
    );
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("NOT_FOUND");

    const promoteRestricted = await transition(restrictedId, "promote", {
      version: 1,
      expected_version: 1,
    });
    expect(promoteRestricted.status).toBe(404);
  });

  test("a cross-workspace item id answers 404, not 403", async () => {
    const memory = app.orchestrator.memoryRepositories;
    if (memory === undefined) {
      throw new Error("memory repositories are not wired");
    }
    const foreignScope: WorkspaceScope = {
      enterprise_id: app.enterpriseId,
      workspace_id: foreignWorkspaceId,
      actor_id: "usr_seed",
    };
    const foreign = memory.items.create(foreignScope, {
      kind: "fact",
      scope: {},
      statement: "another workspace's private memory",
      provenance: { author_type: "human" },
      trust: "human",
      sensitivity: "internal",
      valid_from: "2026-11-01T00:00:00.000Z",
      valid_to: null,
    });

    const read = await getJson<{ error: { code: string } }>(
      itemUrl(foreign.item.id),
      sessionHeaders(),
    );
    expect(read.status).toBe(404);

    const write = await transition(foreign.item.id, "quarantine", {
      version: 1,
      expected_version: 1,
      reason_code: "security_report",
    });
    expect(write.status).toBe(404);
  });
});

describe("permission matrix", () => {
  test("owner and admin govern the workspace", async () => {
    for (const role of ["owner", "admin"] as const) {
      setRole(role);
      const itemId = createItem({ statement: `${role} governs` });
      const response = await transition(itemId, "deprecate", {
        version: 1,
        expected_version: 1,
        reason_code: "human_decision",
      });
      expect(response.status).toBe(200);
      expect(response.body.to_status).toBe("deprecated");
    }
    setRole("owner");
  });

  test("a team leader governs its own team but not another team or a workspace item", async () => {
    setRole("member"); // team leadership grants governance, not workspace authority
    const ownTeamItem = createItem({ teamId: teamAlphaId, statement: "alpha lead item" });
    const otherTeamItem = createItem({ teamId: teamBetaId, statement: "beta item" });
    const workspaceItem = createItem({ statement: "workspace-wide item" });

    const own = await transition(ownTeamItem, "deprecate", {
      version: 1,
      expected_version: 1,
      reason_code: "stale_fact",
    });
    expect(own.status).toBe(200);

    for (const itemId of [otherTeamItem, workspaceItem]) {
      const denied = await transition(itemId, "deprecate", {
        version: 1,
        expected_version: 1,
        reason_code: "stale_fact",
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe("FORBIDDEN");
    }
    setRole("owner");
  });

  test("member and viewer are read-only", async () => {
    // A workspace-wide item: the session user leads Alpha, so a team item
    // would be governable on leadership alone.
    const itemId = createItem({ statement: "read-only item" });
    for (const role of ["member", "viewer"] as const) {
      setRole(role);
      const denied = await transition(itemId, "quarantine", {
        version: 1,
        expected_version: 1,
        reason_code: "security_report",
      });
      expect(denied.status).toBe(403);
      // Reads still work.
      expect((await detail(itemId)).item_id).toBe(itemId);
    }
    setRole("owner");
  });

  test("an agent credential cannot govern memory", async () => {
    const itemId = createItem({ statement: "agent credential target" });
    const response = await postJson<{ error: { code: string } }>(
      itemUrl(itemId, "promote"),
      { version: 1, expected_version: 1 },
      { Authorization: `Bearer ${app.orchestrator.apiToken}` },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

describe("state machine", () => {
  test("promotes a candidate to active with the approver's exact-version stamp", async () => {
    const factId = createItem({ statement: "promote me" });
    const promoted = await transition(factId, "promote", { version: 1, expected_version: 1 });
    expect(promoted.status).toBe(200);
    expect(promoted.body.from_status).toBe("candidate");
    expect(promoted.body.to_status).toBe("active");
    expect(promoted.body.reason_code).toBe("human_approved");
    expect(promoted.body.item.status).toBe("active");

    const lessonId = createItem({ kind: "lesson", statement: "procedural lesson" });
    const lesson = await transition(lessonId, "promote", { version: 1, expected_version: 1 });
    expect(lesson.status).toBe(200);
    // Procedural content reaches active with a named review stamp on v1.
    expect(lesson.body.item.review?.approver_id).toBe(session.userId);

    const policyId = createItem({ kind: "policy", statement: "institutional policy" });
    const policy = await transition(policyId, "promote", { version: 1, expected_version: 1 });
    expect(policy.status).toBe(200);
    expect(policy.body.item.kind).toBe("policy");
  });

  test("rejects promote from a non-candidate state", async () => {
    const activeId = createItem({ status: "active", statement: "already active" });
    const response = await transition(activeId, "promote", { version: 1, expected_version: 1 });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("INVALID_TRANSITION");
  });

  test("refuses to promote without evidence", async () => {
    const bareId = createItem({ evidence: false, statement: "no evidence" });
    const response = await transition(bareId, "promote", { version: 1, expected_version: 1 });
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe("PRECONDITION_FAILED");
  });

  test("quarantines any non-terminal state and refuses retired", async () => {
    const activeId = createItem({ status: "active" });
    const quarantined = await transition(activeId, "quarantine", {
      version: 1,
      expected_version: 1,
      reason_code: "poisoning_suspected",
    });
    expect(quarantined.status).toBe(200);
    expect(quarantined.body.to_status).toBe("quarantined");

    const memory = app.orchestrator.memoryRepositories;
    if (memory === undefined) {
      throw new Error("memory repositories are not wired");
    }
    const retiredId = createItem({ status: "active" });
    memory.items.setStatus(scope, retiredId, "deprecated", 1);
    memory.items.setStatus(scope, retiredId, "retired", 1);
    const denied = await transition(retiredId, "quarantine", {
      version: 1,
      expected_version: 1,
      reason_code: "security_report",
    });
    expect(denied.status).toBe(409);
    expect(denied.body.error?.code).toBe("INVALID_TRANSITION");
  });

  test("restores only quarantined items, never to active", async () => {
    const quarantinedId = createItem({ status: "active", statement: "restore me" });
    await transition(quarantinedId, "quarantine", {
      version: 1,
      expected_version: 1,
      reason_code: "false_positive",
    });
    const restored = await transition(quarantinedId, "restore", {
      version: 1,
      expected_version: 1,
      target_status: "candidate",
      reason_code: "restore_after_review",
    });
    expect(restored.status).toBe(200);
    expect(restored.body.to_status).toBe("candidate");

    const notQuarantined = createItem({ status: "active" });
    const denied = await transition(notQuarantined, "restore", {
      version: 1,
      expected_version: 1,
      target_status: "candidate",
      reason_code: "restore_after_review",
    });
    expect(denied.status).toBe(409);
    expect(denied.body.error?.code).toBe("INVALID_TRANSITION");

    const activeTarget = createItem({ status: "active" });
    await transition(activeTarget, "quarantine", {
      version: 1,
      expected_version: 1,
      reason_code: "false_positive",
    });
    const toActive = await transition(activeTarget, "restore", {
      version: 1,
      expected_version: 1,
      target_status: "active",
      reason_code: "restore_after_review",
    });
    expect(toActive.status).toBe(400);
    expect(toActive.body.error?.code).toBe("INVALID_REQUEST");
  });

  test("rejects stale versions and unknown reason codes", async () => {
    const itemId = createItem({ statement: "concurrency" });
    const stale = await transition(itemId, "promote", { version: 1, expected_version: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("VERSION_CONFLICT");

    const badReason = await transition(itemId, "deprecate", {
      version: 1,
      expected_version: 1,
      reason_code: "because I said so",
    });
    expect(badReason.status).toBe(400);
    expect(badReason.body.error?.code).toBe("INVALID_REQUEST");

    const extraField = await transition(itemId, "deprecate", {
      version: 1,
      expected_version: 1,
      reason_code: "human_decision",
      note: "free text is not part of this contract",
    });
    expect(extraField.status).toBe(400);
  });
});

describe("quarantine redaction", () => {
  test("never serves a quarantined item's content anywhere", async () => {
    const secret = "top secret statement that must never be served";
    const itemId = createItem({ status: "active", statement: secret });
    const quarantined = await transition(itemId, "quarantine", {
      version: 1,
      expected_version: 1,
      reason_code: "secret_leak",
    });
    expect(quarantined.status).toBe(200);
    const bodies: unknown[] = [quarantined.body];

    const item = await detail(itemId);
    bodies.push(item);
    expect(item.statement).toBeNull();
    expect(item.statement_redacted).toBe(true);
    expect(item.preconditions).toEqual([]);
    for (const evidence of item.evidence) {
      expect(evidence.reference.startsWith("sha256:")).toBe(true);
      expect(evidence.reference).not.toContain("pr:dat-251");
    }

    const list = await getJson<MemoryItemsPage>(
      memoryUrl(`items?status=quarantined`),
      sessionHeaders(),
    );
    bodies.push(list.body);
    const listed = list.body.items.find((entry) => entry.item_id === itemId);
    expect(listed?.statement).toBeNull();
    expect(listed?.statement_redacted).toBe(true);

    const versions = await getJson<MemoryItemVersionsView>(
      itemUrl(itemId, "versions"),
      sessionHeaders(),
    );
    bodies.push(versions.body);
    expect(versions.body.versions.length).toBeGreaterThan(0);
    for (const version of versions.body.versions) {
      expect(version.statement).toBeNull();
      expect(version.statement_redacted).toBe(true);
      expect(version.preconditions).toEqual([]);
    }

    const events = await getJson<MemoryItemEventsView>(itemUrl(itemId, "events"), sessionHeaders());
    bodies.push(events.body);
    expect(events.body.events.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("pr:dat-251");
  });
});

describe("per-version sensitivity and the audit timeline", () => {
  test("hides a historical version above the caller's ceiling", async () => {
    const memory = app.orchestrator.memoryRepositories;
    if (memory === undefined) {
      throw new Error("memory repositories are not wired");
    }
    const created = memory.items.create(scope, {
      kind: "fact",
      scope: {},
      statement: "confidential v1 secret",
      provenance: { author_type: "human" },
      trust: "human",
      sensitivity: "confidential",
      valid_from: "2026-11-01T00:00:00.000Z",
      valid_to: null,
    });
    memory.evidence.add(scope, created.item.id, {
      evidence_type: "pr",
      reference: "pr:dat-251-history",
    });
    memory.items.addVersion(
      scope,
      created.item.id,
      {
        kind: "fact",
        scope: {},
        statement: "internal v2",
        provenance: { author_type: "human" },
        trust: "human",
        sensitivity: "internal",
        valid_from: "2026-11-02T00:00:00.000Z",
        valid_to: null,
      },
      1,
    );

    setRole("owner");
    const asOwner = await getJson<MemoryItemVersionsView>(
      itemUrl(created.item.id, "versions"),
      sessionHeaders(),
    );
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.versions.map((version) => version.version)).toEqual([1, 2]);

    setRole("member");
    const asMember = await getJson<MemoryItemVersionsView>(
      itemUrl(created.item.id, "versions"),
      sessionHeaders(),
    );
    expect(asMember.status).toBe(200);
    // v1 is confidential: entirely absent, not blanked.
    expect(asMember.body.versions.map((version) => version.version)).toEqual([2]);
    expect(JSON.stringify(asMember.body)).not.toContain("confidential v1 secret");

    const memberEvents = await getJson<MemoryItemEventsView>(
      itemUrl(created.item.id, "events"),
      sessionHeaders(),
    );
    expect(memberEvents.status).toBe(200);
    expect(memberEvents.body.events.every((event) => event.item_version !== 1)).toBe(true);
    setRole("owner");
  });

  test("merges events, promotion decisions, and consolidation ops into a safe timeline", async () => {
    const itemId = createItem({ statement: "timeline item" });
    await transition(itemId, "promote", { version: 1, expected_version: 1 });

    lifecycle.startConsolidationRun(scope, "mcr_dat_251", "2026-11-03T00:00:00.000Z");
    lifecycle.recordConsolidationOp(
      scope,
      "mcr_dat_251",
      {
        op: "deprecate",
        item_id: itemId,
        target_item_id: null,
        item_version: 1,
        reason_code: "stale_fact",
        applied: true,
        detail: { evidence_folded: 2 },
      },
      "2026-11-03T00:00:01.000Z",
    );
    lifecycle.finishConsolidationRun(
      scope,
      {
        run_id: "mcr_dat_251",
        status: "completed",
        started_at: "2026-11-03T00:00:00.000Z",
        finished_at: "2026-11-03T00:00:02.000Z",
        items_scanned: 1,
        counts_recomputed: 1,
        ops: [],
        ops_applied: 1,
        ops_skipped: 0,
        budget_exhausted: false,
      },
      "completed",
    );

    const response = await getJson<MemoryItemEventsView>(
      itemUrl(itemId, "events"),
      sessionHeaders(),
    );
    expect(response.status).toBe(200);
    const events = response.body.events;
    const sources = new Set(events.map((event) => event.source));
    expect(sources.has("memory_event")).toBe(true);
    expect(sources.has("promotion_decision")).toBe(true);
    expect(sources.has("consolidation_op")).toBe(true);

    for (const event of events) {
      expect(event.at).toBeTruthy();
      expect(event.actor.id.length).toBeGreaterThan(0);
      expect(["user", "system"]).toContain(event.actor.type);
      expect(event.action.length).toBeGreaterThan(0);
    }

    const promoted = events.find(
      (event) => event.source === "memory_event" && event.to_status === "active",
    );
    expect(promoted?.from_status).toBe("candidate");
    expect(promoted?.reason_code).toBe("human_approved");

    const decision = events.find((event) => event.source === "promotion_decision");
    expect(decision?.detail?.["reasons"]).toBe("human_approved");

    const consolidation = events.find((event) => event.source === "consolidation_op");
    expect(consolidation?.action).toBe("deprecate");
    expect(consolidation?.reason_code).toBe("stale_fact");
    expect(consolidation?.detail?.["evidence_folded"]).toBe(2);

    // Ascending, append-only timeline.
    const times = events.map((event) => event.at);
    expect([...times].sort((left, right) => left.localeCompare(right))).toEqual(times);
    // No free text and no memory content in any detail value.
    for (const event of events) {
      for (const value of Object.values(event.detail ?? {})) {
        if (typeof value === "string") {
          expect(value).not.toMatch(/\s/);
        }
      }
    }
  });
});
