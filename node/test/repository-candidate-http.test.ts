/**
 * Approved-repository discovery API (DAT-289, ADR-0011), exercised over real
 * HTTP against the running service.
 *
 * The acceptance boundary these tests pin down:
 *
 * - only a repository manager — the same rule the preview/confirm/commit
 *   surface applies — can enumerate candidates, and the disclosure carries no
 *   credential reference and no provider subject;
 * - a candidate names exactly the provider instance, the repository-scoped
 *   active service integration and the immutable repository id a DAT-286
 *   proposal needs, and nothing else is authority;
 * - the list is bounded and says so: the source it could not use is reported,
 *   repositories already bound (active or retired) are excluded and counted,
 *   and a restricted installation is returned with its named restriction
 *   instead of being hidden or labelled approvable;
 * - another enterprise's installation is never a candidate, and the request
 *   cannot address another enterprise's workspace;
 * - discovery writes nothing and opens nothing: the multi-repository gate stays
 *   closed, and a candidate that stops being valid between discovery and
 *   submission is refused by the preview and the confirmation.
 *
 * Every response is validated against the generated OpenAPI schemas with
 * closed objects. Set `AUTOFIXER_CAPTURE_FIXTURES=1` to refresh the committed
 * real-response fixtures under `docs/fixtures/repository-candidate-api-v1/`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  MULTI_REPOSITORY_GATE_KEY,
  createIdentityRepositories,
  createProviderAccessRepositories,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../src/control-plane/index.js";
import type {
  ControlPlaneDb,
  EnterpriseScope,
  IdentityRepositories,
  PermissionVisibility,
  ProviderAccessRepositories,
  ProviderType,
  WorkspaceRepositorySetRepository,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import { buildOpenApiDocument } from "../src/api/openapi.js";
import { cookieSessionHeaders, startAuthApp, webLogin } from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { startDshServer } from "./helpers/dsh-server.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { getJson, postJson, setAuthToken } from "./helpers/http.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "repository-candidate-api-v1");
const CAPTURE = process.env["AUTOFIXER_CAPTURE_FIXTURES"] === "1";

const DEFAULT_REPOSITORY = "github:FoMo-Exp/AutoFixer";
const DAY_MS = 24 * 60 * 60 * 1000;

const document = buildOpenApiDocument();
const schemas = document.components.schemas as Record<string, unknown>;

function closedCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(closedCopy);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = closedCopy(item);
  }
  if (
    copy["type"] === "object" &&
    copy["properties"] &&
    copy["additionalProperties"] === undefined
  ) {
    copy["additionalProperties"] = false;
  }
  return copy;
}

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema({
  $id: "urn:forgepilot:repository-candidate-contract",
  components: closedCopy({ schemas }),
} as Record<string, unknown>);

function expectContract(schemaName: string, body: unknown): void {
  const validate = ajv.getSchema(
    `urn:forgepilot:repository-candidate-contract#/components/schemas/${schemaName}`,
  );
  if (!validate) {
    throw new Error(`no contract schema ${schemaName}`);
  }
  const valid = validate(body);
  expect(valid, `${schemaName}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GENERATED_ID = /^(ent|wsp|mbr|usr|sint|pri|wrb|rsc|aud|pdi|rec)_/;

/**
 * Normalize a captured response into a stable exemplar: generated ids keep
 * their prefix and first-seen order, timestamps collapse to ordered instants.
 * The shape is untouched, so the committed fixture stays reviewable and the
 * schema check stays honest.
 */
function normalizeCaptured(
  value: unknown,
  ids = new Map<string, string>(),
  times = new Map<string, string>(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCaptured(item, ids, times));
  }
  if (typeof value === "string") {
    if (ISO_TIMESTAMP.test(value)) {
      const existing = times.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const replacement = `2026-11-26T12:${String(times.size * 5).padStart(2, "0")}:00.000Z`;
      times.set(value, replacement);
      return replacement;
    }
    const match = GENERATED_ID.exec(value);
    if (match !== null) {
      const existing = ids.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const replacement = `${match[1]}_captured_${ids.size + 1}`;
      ids.set(value, replacement);
      return replacement;
    }
    return value;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = normalizeCaptured(item, ids, times);
    }
    return copy;
  }
  return value;
}

/** Capture a real response for the committed fixture set (opt-in). */
function capture(file: string, body: unknown): void {
  if (!CAPTURE) {
    return;
  }
  fs.mkdirSync(fixtureDir, { recursive: true });
  const normalized = normalizeCaptured(body);
  fs.writeFileSync(path.join(fixtureDir, file), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let dsh: DshServerHandle;
const apps: AuthApp[] = [];

beforeAll(async () => {
  // Session cookies only: strip any bearer token a previous suite installed.
  setAuthToken("");
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 180_000);

afterAll(async () => {
  await dsh.stop();
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

function nowIso(): string {
  return new Date().toISOString();
}

function enableGate(db: ControlPlaneDb): void {
  db.prepare(
    `INSERT INTO deployment_feature_gate
       (key, min_schema_version, state, reason, created_at, created_by)
     VALUES (?, ?, 'enabled', ?, ?, ?)`,
  ).run(
    MULTI_REPOSITORY_GATE_KEY,
    CURRENT_SCHEMA_VERSION,
    "test fixture: a build that enforces the whole set",
    nowIso(),
    "usr_auth_system",
  );
}

interface CandidatePage {
  enterprise_id: string;
  workspace_id: string;
  set_version: number;
  discovered_at: string;
  coverage: {
    completeness: string;
    sources: string[];
    unsupported_sources: string[];
    limits: string[];
  };
  items: Candidate[];
  next_cursor: string | null;
  totals: { discovered: number; proposable: number; restricted: number; already_bound: number };
}

interface Candidate {
  provider_instance_id: string;
  provider_type: string;
  installation_ref: string;
  repository_id: string;
  repository_name: string | null;
  install_status: string;
  permission_visibility: string;
  verification: {
    subjects: number;
    latest_verified_at: string | null;
    freshness: string;
    last_reconcile_at: string | null;
    last_failure: string | null;
  };
  proposable: boolean;
  restriction_reasons: string[];
}

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

interface Fixture {
  app: AuthApp;
  db: ControlPlaneDb;
  actor: LoggedInSession;
  scope: WorkspaceScope;
  adminScope: EnterpriseScope;
  repos: ReturnType<typeof createRepositories>;
  identity: IdentityRepositories;
  access: ProviderAccessRepositories;
  sets: WorkspaceRepositorySetRepository;
  ownIntegrationId: string;
  instanceCounter: number;
}

interface FixtureOptions {
  gate?: "enabled" | "disabled";
  /** The logged-in actor's GitHub role on the workspace's own repository. */
  actorGithubRole?: string;
}

/**
 * A real orchestrator with the identity surface, a GitHub-seeded workspace
 * whose own repository is already bound, and verified authority for the actor.
 */
async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const app = await startAuthApp({ dsh, repositoryIntegration: true });
  apps.push(app);
  const db = app.orchestrator.controlPlane as ControlPlaneDb;
  const actor = await webLogin(app);
  const repos = createRepositories(db);
  const identity = createIdentityRepositories(db);
  const access = createProviderAccessRepositories(db);
  const sets = createWorkspaceRepositorySetRepository(db);
  const scope: WorkspaceScope = {
    enterprise_id: app.enterpriseId,
    workspace_id: app.workspaceId,
    actor_id: "usr_test_operator",
  };
  const adminScope: EnterpriseScope = {
    enterprise_id: app.enterpriseId,
    actor_id: "usr_test_operator",
  };

  if (options.gate === "enabled") {
    enableGate(db);
  }

  repos.memberships.create(scope, { user_id: actor.userId, role: "owner" });

  const ownIntegration = app.integration;
  if (ownIntegration === undefined) {
    throw new Error("fixture requires the seeded GitHub integration");
  }
  access.roster.applySnapshot(scope, ownIntegration.id, {
    roles: [
      {
        subject: "1001",
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: options.actorGithubRole ?? "admin",
        authority_ref: DEFAULT_REPOSITORY,
        inherited_from: null,
      },
    ],
    verified_at: nowIso(),
  });

  return {
    app,
    db,
    actor,
    scope,
    adminScope,
    repos,
    identity,
    access,
    sets,
    ownIntegrationId: ownIntegration.id,
    instanceCounter: 0,
  };
}

interface IntegrationOptions {
  repositoryId: string;
  repositoryName?: string;
  providerType?: ProviderType;
  permissionVisibility?: PermissionVisibility;
  /** Register the instance in another enterprise, so it is unapproved here. */
  foreignInstance?: boolean;
}

interface AddedIntegration {
  integrationId: string;
  providerInstanceId: string;
}

/** Register one repository-scoped installation the way an administrator would. */
function addIntegration(fx: Fixture, options: IntegrationOptions): AddedIntegration {
  fx.instanceCounter += 1;
  const providerType = options.providerType ?? "gitlab";
  const origin =
    providerType === "github"
      ? `https://github.${fx.instanceCounter}.example.com`
      : `https://gitlab.${fx.instanceCounter}.example.com`;
  let instanceScope = fx.adminScope;
  if (options.foreignInstance === true) {
    const foreign = seedEnterprise(fx.db, {
      enterprise_name: "Other Enterprise",
      enterprise_slug: `other-ent-${fx.instanceCounter}-${Math.random().toString(36).slice(2, 8)}`,
      admin_user_id: "usr_test_operator",
    });
    instanceScope = foreign.admin_scope;
  }
  const instance = seedProviderInstance(fx.db, instanceScope, {
    provider_type: providerType,
    origin_url: origin,
  });
  const integration = fx.access.integrations.create(fx.scope, {
    provider_instance_id: instance.id,
    repository_id: options.repositoryId,
    repository_name: options.repositoryName ?? options.repositoryId,
    source_credential_ref: `svc-source-${fx.instanceCounter}`,
    permission_visibility: options.permissionVisibility ?? "full",
    actor_id: "usr_test_operator",
  });
  return { integrationId: integration.id, providerInstanceId: instance.id };
}

/** Seed verified authority rows for an installation (what reconciliation writes). */
function verifySubjects(fx: Fixture, integrationId: string, verifiedAt = nowIso()): void {
  fx.access.roster.applySnapshot(fx.scope, integrationId, {
    roles: [
      {
        subject: "1001",
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: "admin",
        authority_ref: DEFAULT_REPOSITORY,
        inherited_from: null,
      },
    ],
    verified_at: verifiedAt,
  });
}

/** Record a completed reconciliation, optionally with a failure code. */
function recordReconcile(fx: Fixture, integrationId: string, failureCode?: string): void {
  const run = fx.access.reconcileRuns.start(fx.scope, integrationId, {
    integration_id: integrationId,
    started_at: nowIso(),
  });
  fx.access.reconcileRuns.finish(fx.scope, run.id, {
    status: failureCode === undefined ? "completed" : "incomplete",
    pages_seen: 1,
    roster_size: 1,
    ...(failureCode !== undefined ? { failure_code: failureCode } : {}),
    finished_at: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function candidatesUrl(fx: Fixture, cursor?: string | null, workspaceId?: string): string {
  const base = `${fx.app.base}/api/v1/workspaces/${workspaceId ?? fx.app.workspaceId}/repository-candidates`;
  return cursor === undefined || cursor === null
    ? base
    : `${base}?cursor=${encodeURIComponent(cursor)}`;
}

async function listCandidates(
  fx: Fixture,
  options: { cursor?: string | null; session?: LoggedInSession; workspaceId?: string } = {},
): Promise<{ status: number; body: CandidatePage & Partial<ErrorBody> }> {
  const response = await getJson<CandidatePage & Partial<ErrorBody>>(
    candidatesUrl(fx, options.cursor, options.workspaceId),
    cookieSessionHeaders(options.session ?? fx.actor),
  );
  return { status: response.status, body: response.body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("approved-repository discovery", () => {
  test("an authorized manager sees unbound installations as selectable candidates", async () => {
    const fx = await startFixture();
    const gitlab = addIntegration(fx, {
      repositoryId: "gitlab:repo:9100",
      repositoryName: "acme/service-b",
    });
    verifySubjects(fx, gitlab.integrationId);
    recordReconcile(fx, gitlab.integrationId);
    const github = addIntegration(fx, {
      repositoryId: "github:repo:2002",
      repositoryName: "acme/service-c",
      providerType: "github",
    });
    verifySubjects(fx, github.integrationId);
    recordReconcile(fx, github.integrationId);

    const { status, body } = await listCandidates(fx);
    expect(status).toBe(200);
    expectContract("RepositoryCandidatePage", body);

    // The workspace's own repository is bound, so it is counted, not offered.
    expect(body.totals).toEqual({
      discovered: 2,
      proposable: 2,
      restricted: 0,
      already_bound: 1,
    });
    expect(body.set_version).toBe(1);
    expect(body.next_cursor).toBeNull();

    // Bounded coverage is stated, never implied complete.
    expect(body.coverage.completeness).toBe("bounded");
    expect(body.coverage.sources).toEqual(["registered_service_integrations"]);
    expect(body.coverage.unsupported_sources).toEqual(["provider_repository_enumeration"]);
    expect(body.coverage.limits).toEqual([
      "provider_repository_enumeration_unsupported",
      "installation_scoped_to_workspace",
    ]);

    const ids = body.items.map((item) => item.repository_id);
    expect(ids).toEqual(["gitlab:repo:9100", "github:repo:2002"]);
    for (const item of body.items) {
      expect(item.proposable).toBe(true);
      expect(item.restriction_reasons).toEqual([]);
      expect(item.install_status).toBe("active");
      expect(item.permission_visibility).toBe("full");
      expect(item.verification.subjects).toBe(1);
      expect(item.verification.freshness).toBe("fresh");
      expect(item.verification.last_failure).toBeNull();
    }
    // The exact triple a DAT-286 proposal needs, and nothing secret beside it.
    const candidate = body.items[0]!;
    expect(candidate.installation_ref).toBe(gitlab.integrationId);
    expect(candidate.provider_instance_id).toBe(gitlab.providerInstanceId);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("svc-source");
    expect(serialized).not.toContain("1001");
    capture("candidates-all.json", body);
  });

  test("a workspace with nothing unbound returns an empty page that explains itself", async () => {
    const fx = await startFixture();
    const { status, body } = await listCandidates(fx);
    expect(status).toBe(200);
    expectContract("RepositoryCandidatePage", body);
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
    expect(body.totals).toEqual({
      discovered: 0,
      proposable: 0,
      restricted: 0,
      already_bound: 1,
    });
    capture("candidates-empty.json", body);
  });

  test("a restricted installation is reported with named reasons, never hidden or approved", async () => {
    const fx = await startFixture();
    const active = addIntegration(fx, {
      repositoryId: "gitlab:repo:9100",
      repositoryName: "acme/active",
    });
    verifySubjects(fx, active.integrationId);

    const suspended = addIntegration(fx, {
      repositoryId: "gitlab:repo:9101",
      repositoryName: "acme/suspended",
    });
    const suspendedRow = fx.access.integrations.getById(fx.scope, suspended.integrationId);
    fx.access.integrations.setStatus(
      fx.scope,
      suspended.integrationId,
      { install_status: "suspended", actor_id: "usr_test_operator" },
      suspendedRow?.version ?? 1,
    );

    addIntegration(fx, {
      repositoryId: "gitlab:repo:9102",
      repositoryName: "acme/no-visibility",
      permissionVisibility: "none",
    });
    addIntegration(fx, {
      repositoryId: "gitlab:repo:9103",
      repositoryName: "acme/partial-visibility",
      permissionVisibility: "partial",
    });
    const unreachable = addIntegration(fx, {
      repositoryId: "gitlab:repo:9104",
      repositoryName: "acme/unreachable",
    });
    recordReconcile(fx, unreachable.integrationId, "PROVIDER_UNAVAILABLE");
    const truncated = addIntegration(fx, {
      repositoryId: "gitlab:repo:9105",
      repositoryName: "acme/truncated",
    });
    recordReconcile(fx, truncated.integrationId, "PROVIDER_ROSTER_INCOMPLETE");
    const unapproved = addIntegration(fx, {
      repositoryId: "gitlab:repo:9106",
      repositoryName: "acme/foreign-instance",
      foreignInstance: true,
    });

    const { status, body } = await listCandidates(fx);
    expect(status).toBe(200);
    expectContract("RepositoryCandidatePage", body);

    const byRepo = new Map(body.items.map((item) => [item.repository_id, item]));
    expect(byRepo.get("gitlab:repo:9100")?.proposable).toBe(true);
    expect(byRepo.get("gitlab:repo:9101")?.restriction_reasons).toEqual(["installation_inactive"]);
    expect(byRepo.get("gitlab:repo:9102")?.restriction_reasons).toEqual([
      "permission_visibility_none",
    ]);
    expect(byRepo.get("gitlab:repo:9103")?.restriction_reasons).toEqual([
      "permission_visibility_partial",
    ]);
    expect(byRepo.get("gitlab:repo:9104")?.restriction_reasons).toEqual(["provider_unavailable"]);
    expect(byRepo.get("gitlab:repo:9106")?.restriction_reasons).toEqual([
      "provider_instance_unapproved",
    ]);
    // Truncated roster: `roster_incomplete` is reported, and the reconcile
    // failure is visible next to it.
    expect(byRepo.get("gitlab:repo:9105")?.restriction_reasons).toEqual(["roster_incomplete"]);
    expect(byRepo.get("gitlab:repo:9105")?.verification.last_failure).toBe(
      "PROVIDER_ROSTER_INCOMPLETE",
    );
    for (const item of body.items) {
      if (item.repository_id === "gitlab:repo:9100") {
        continue;
      }
      expect(item.proposable, item.repository_id).toBe(false);
      expect(item.restriction_reasons.length, item.repository_id).toBeGreaterThan(0);
    }
    expect(body.totals).toEqual({
      discovered: 7,
      proposable: 1,
      restricted: 6,
      already_bound: 1,
    });
    // The foreign instance's candidate is still this workspace's installation.
    expect(byRepo.get("gitlab:repo:9106")?.installation_ref).toBe(unapproved.integrationId);
    capture("candidates-restricted.json", body);
  });

  test("an aged installation is still offered and reports its freshness", async () => {
    const fx = await startFixture();
    const aged = addIntegration(fx, {
      repositoryId: "gitlab:repo:9100",
      repositoryName: "acme/aged",
    });
    verifySubjects(fx, aged.integrationId, new Date(Date.now() - 2 * DAY_MS).toISOString());
    const never = addIntegration(fx, {
      repositoryId: "gitlab:repo:9101",
      repositoryName: "acme/never",
    });
    void never;

    const { body } = await listCandidates(fx);
    const byRepo = new Map(body.items.map((item) => [item.repository_id, item]));
    expect(byRepo.get("gitlab:repo:9100")?.verification.freshness).toBe("stale");
    // Staleness is data, not a restriction: the preview decides per member.
    expect(byRepo.get("gitlab:repo:9100")?.proposable).toBe(true);
    const neverItem = byRepo.get("gitlab:repo:9101");
    expect(neverItem?.verification.freshness).toBe("never_verified");
    expect(neverItem?.verification.subjects).toBe(0);
    expect(neverItem?.verification.latest_verified_at).toBeNull();
  });

  test("pages through every candidate exactly once and refuses an unknown cursor", async () => {
    const fx = await startFixture();
    for (let index = 0; index < 52; index += 1) {
      addIntegration(fx, {
        repositoryId: `gitlab:repo:p${String(index).padStart(3, "0")}`,
        repositoryName: `acme/page-${String(index).padStart(3, "0")}`,
      });
    }

    const first = await listCandidates(fx);
    expect(first.status).toBe(200);
    expectContract("RepositoryCandidatePage", first.body);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.totals.discovered).toBe(52);
    expect(first.body.next_cursor).not.toBeNull();

    const second = await listCandidates(fx, { cursor: first.body.next_cursor });
    expect(second.status).toBe(200);
    expectContract("RepositoryCandidatePage", second.body);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.next_cursor).toBeNull();
    // Totals describe the whole set, not the page.
    expect(second.body.totals.discovered).toBe(52);

    const seen = new Set([
      ...first.body.items.map((item) => item.repository_id),
      ...second.body.items.map((item) => item.repository_id),
    ]);
    expect(seen.size).toBe(52);

    const unknown = await listCandidates(fx, { cursor: "pri_missing:gitlab:repo:none" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.code).toBe("INVALID_CURSOR");
  });

  test("another enterprise's installation is never a candidate and its workspace stays a 404", async () => {
    const fx = await startFixture();
    const foreign = seedEnterprise(fx.db, {
      enterprise_name: "Other Enterprise",
      enterprise_slug: "other-ent-default",
      admin_user_id: "usr_test_operator",
    });
    const foreignInstance = seedProviderInstance(fx.db, foreign.admin_scope, {
      provider_type: "gitlab",
      origin_url: "https://gitlab.other.example.com",
    });
    const foreignWorkspace = seedWorkspace(fx.db, foreign.admin_scope, {
      name: "Other Workspace",
      repository_id: "gitlab:repo:9999",
      provider_instance_id: foreignInstance.id,
    });
    const foreignIntegration = fx.access.integrations.create(
      {
        enterprise_id: foreign.enterprise.id,
        workspace_id: foreignWorkspace.id,
        actor_id: "usr_test_operator",
      },
      {
        provider_instance_id: foreignInstance.id,
        repository_id: "gitlab:repo:8888",
        repository_name: "other/secret-repo",
        source_credential_ref: "svc-other",
        permission_visibility: "full",
        actor_id: "usr_test_operator",
      },
    );
    void foreignIntegration;

    const { status, body } = await listCandidates(fx);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.totals.already_bound).toBe(1);
    expect(JSON.stringify(body)).not.toContain("gitlab:repo:8888");
    expect(JSON.stringify(body)).not.toContain("other/secret-repo");

    // The other enterprise's workspace is not addressable from this session.
    const crossTenant = await listCandidates(fx, { workspaceId: foreignWorkspace.id });
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error?.code).toBe("NOT_FOUND");

    const unknown = await listCandidates(fx, { workspaceId: "wsp_does_not_exist" });
    expect(unknown.status).toBe(404);
  });

  test("discovery is limited to repository administrators", async () => {
    const fx = await startFixture();
    addIntegration(fx, {
      repositoryId: "gitlab:repo:9100",
      repositoryName: "acme/restricted-visibility",
    });

    // A workspace member with a verified provider identity is not a manager.
    // The login itself records the provider identity for the profile (1002).
    fx.app.provider.profile = { id: 1002, login: "octo-member" };
    const member = await webLogin(fx.app);
    fx.repos.memberships.create(fx.scope, { user_id: member.userId, role: "member" });
    const memberView = await listCandidates(fx, { session: member });
    expect(memberView.status).toBe(403);
    expect(memberView.body.error?.code).toBe("REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED");
    expect(JSON.stringify(memberView.body)).not.toContain("acme/restricted-visibility");

    // An owner assignment alone is not repository authority: without verified
    // `repository_manage` the same refusal applies.
    const unmanaged = await startFixture({ actorGithubRole: "read" });
    addIntegration(unmanaged, { repositoryId: "gitlab:repo:9100" });
    const ownerWithoutManagement = await listCandidates(unmanaged);
    expect(ownerWithoutManagement.status).toBe(403);
    expect(ownerWithoutManagement.body.error?.code).toBe(
      "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED",
    );

    // No session at all.
    const anonymous = await getJson(
      `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}/repository-candidates`,
    );
    expect(anonymous.status).toBe(401);
  });

  test("discovery writes nothing: the rollout gate stays closed and confirmation still refuses", async () => {
    const fx = await startFixture({ gate: "disabled" });
    const candidate = addIntegration(fx, {
      repositoryId: "gitlab:repo:9100",
      repositoryName: "acme/service-b",
    });
    verifySubjects(fx, candidate.integrationId);

    const { status, body } = await listCandidates(fx);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);

    // The selected candidate still runs the full preview, which reports the
    // closed gate instead of promising a change.
    const preview = await postJson<Record<string, unknown>>(
      `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}/repository-set-additions/preview`,
      {
        additional_repositories: [
          {
            provider_instance_id: candidate.providerInstanceId,
            installation_ref: body.items[0]?.installation_ref,
            repository_id: body.items[0]?.repository_id,
          },
        ],
      },
      cookieSessionHeaders(fx.actor),
    );
    expect(preview.status).toBe(200);
    expect(preview.body["committable"]).toBe(false);
    expect(preview.body["commit_blocked_reasons"]).toContain("MULTI_REPOSITORY_GATE_DISABLED");

    const confirm = await postJson<ErrorBody>(
      `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}/repository-set-additions/confirmations`,
      {
        expected_set_version: body.set_version,
        additional_repositories: [
          {
            provider_instance_id: candidate.providerInstanceId,
            installation_ref: body.items[0]?.installation_ref,
            repository_id: body.items[0]?.repository_id,
          },
        ],
        confirmed_reductions: [],
      },
      cookieSessionHeaders(fx.actor),
    );
    expect(confirm.status).toBe(403);
    expect(confirm.body.error.code).toBe("SCOPE_MUTATION_DISABLED");
  });

  test("a candidate that stops being valid between discovery and submission is refused", async () => {
    const fx = await startFixture({ gate: "enabled" });
    const candidate = addIntegration(fx, {
      repositoryId: "gitlab:repo:9100",
      repositoryName: "acme/service-b",
    });
    verifySubjects(fx, candidate.integrationId);
    recordReconcile(fx, candidate.integrationId);

    const discovered = await listCandidates(fx);
    expect(discovered.status).toBe(200);
    const selected = discovered.body.items[0];
    expect(selected?.proposable).toBe(true);

    // The installation is deactivated after discovery: the candidate list must
    // now restrict it, and the proposal must be refused rather than committed
    // on the strength of the earlier read.
    const row = fx.access.integrations.getById(fx.scope, candidate.integrationId);
    fx.access.integrations.setStatus(
      fx.scope,
      candidate.integrationId,
      { install_status: "uninstalled", actor_id: "usr_test_operator" },
      row?.version ?? 1,
    );

    const reDiscovered = await listCandidates(fx);
    expect(reDiscovered.body.items[0]?.proposable).toBe(false);
    expect(reDiscovered.body.items[0]?.restriction_reasons).toEqual(["installation_inactive"]);

    const proposal = {
      additional_repositories: [
        {
          provider_instance_id: selected?.provider_instance_id,
          installation_ref: selected?.installation_ref,
          repository_id: selected?.repository_id,
        },
      ],
    };
    const preview = await postJson<Record<string, unknown>>(
      `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}/repository-set-additions/preview`,
      proposal,
      cookieSessionHeaders(fx.actor),
    );
    expect(preview.status).toBe(200);
    expect(preview.body["committable"]).toBe(false);
    expect(preview.body["commit_blocked_reasons"]).toContain("MEMBER_ADMISSION_NOT_RETAINED");
    // Unknown evidence is reported as a class, never as a confirmed removal.
    const members = preview.body["members"] as Array<Record<string, unknown>>;
    expect(members[0]?.["retains_admission"]).toBe(false);
    expect(members[0]?.["evidence_classes"]).toContain("unknown");

    const confirm = await postJson<ErrorBody>(
      `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}/repository-set-additions/confirmations`,
      {
        expected_set_version: discovered.body.set_version,
        ...proposal,
        confirmed_reductions: [],
      },
      cookieSessionHeaders(fx.actor),
    );
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe("REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE");
  });
});
