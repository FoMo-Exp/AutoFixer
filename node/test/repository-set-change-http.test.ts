/**
 * Workspace repository-addition API: preview, confirmation and the atomic
 * audited commit, exercised over real HTTP against the running service
 * (DAT-286, ADR-0011).
 *
 * The acceptance boundary these tests pin down:
 *
 * - the preview reports the exact before/after intersection of every current
 *   effective member across GitHub *and* GitLab, and writes nothing;
 * - the whole addition is refused when any member is confirmed to lack code
 *   read or any necessary evidence is unknown or expired — unknown evidence is
 *   never recorded as a confirmed removal and no member is removed to pass;
 * - a verified reduction needs an explicit confirmation of the exact affected
 *   members and capabilities, the assigned role is preserved, and the last
 *   effective owner is protected even when everyone still reads;
 * - the commit re-authorizes and revalidates inside one transaction: a changed
 *   set version, membership fact, provider role or expired confirmation is
 *   refused, and a required-audit failure rolls back every part of the change;
 * - nothing in the surface opens the multi-repository gate or invents a field
 *   outside the committed OpenAPI contract.
 *
 * Every response is validated against the generated OpenAPI schemas with
 * closed objects. Set `AUTOFIXER_CAPTURE_FIXTURES=1` to refresh the committed
 * real-response fixtures under `docs/fixtures/repository-set-api-v1/`.
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
  assertSchemaSupported,
  createIdentityRepositories,
  createProviderAccessRepositories,
  createRepositories,
  createWorkspaceRepositorySetRepository,
  seedProviderInstance,
} from "../src/control-plane/index.js";
import { WorkspaceRepositorySetError } from "../src/control-plane/errors.js";
import { createRunStepAuthority } from "../src/api/run-step-authority.js";
import type {
  ControlPlaneDb,
  EnterpriseScope,
  IdentityRepositories,
  ProviderAccessRepositories,
  RepositorySetAdditionBinding,
  WorkspaceRepositorySetRepository,
  WorkspaceScope,
} from "../src/control-plane/index.js";
import { buildOpenApiDocument } from "../src/api/openapi.js";
import { cookieSessionHeaders, REPOSITORY_ID, startAuthApp, webLogin } from "./helpers/auth-app.js";
import type { AuthApp, LoggedInSession } from "./helpers/auth-app.js";
import { startDshServer } from "./helpers/dsh-server.js";
import type { DshServerHandle } from "./helpers/dsh-server.js";
import { getJson, postJson, setAuthToken } from "./helpers/http.js";

// ajv-formats ships CJS: NodeNext types its default import as the module
// namespace while the runtime binding is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repoRoot, "docs", "fixtures", "repository-set-api-v1");
const CAPTURE = process.env["AUTOFIXER_CAPTURE_FIXTURES"] === "1";

const REPO_B = "gitlab:repo:9100";
const REPO_B_NAME = "acme/service-b";
const REPO_B_URL = "https://gitlab.com/acme/service-b";
/** What a caller sends as display metadata; never stored in a decision. */
const CALLER_NAME = "caller-supplied-name";
const CALLER_URL = "https://gitlab.com/caller-supplied/name";
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
  $id: "urn:forgepilot:repository-set-contract",
  components: closedCopy({ schemas }),
} as Record<string, unknown>);

/** Assert one real response body matches its committed contract schema. */
function expectContract(schemaName: string, body: unknown): void {
  const validate = ajv.getSchema(
    `urn:forgepilot:repository-set-contract#/components/schemas/${schemaName}`,
  );
  if (!validate) {
    throw new Error(`no contract schema ${schemaName}`);
  }
  const valid = validate(body);
  expect(valid, `${schemaName}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GENERATED_ID = /^(ent|wsp|mbr|usr|sint|pri|wrb|rsc|aud|pdi)_/;

/**
 * Normalize a captured response into a stable exemplar: generated ids keep
 * their prefix and first-seen order, timestamps collapse to one instant. The
 * shape is untouched — only the deployment-specific values change — so the
 * committed fixture stays reviewable and the schema check stays honest.
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
      // Distinct instants stay distinct (and ordered): the fixture keeps the
      // expiry ordering a client must respect, without a real capture date.
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
  // This suite authenticates with session cookies only; strip any bearer token
  // a previous suite in this worker may have installed.
  setAuthToken("");
  dsh = await startDshServer({ approver: "github:local-operator" });
}, 180_000);

afterAll(async () => {
  await dsh.stop();
  while (apps.length > 0) {
    await apps.pop()?.stop();
  }
});

interface MemberSeed {
  /** GitHub role on repository A; null means "no GitHub identity at all". */
  github: string | null;
  /** GitLab role on the proposed repository B; null means no GitLab identity. */
  gitlab: string | null;
  /** Verification timestamp for the GitLab authority row. */
  gitlabVerifiedAt?: string;
}

interface ChangeFixture {
  app: AuthApp;
  db: ControlPlaneDb;
  actor: LoggedInSession;
  scope: WorkspaceScope;
  adminScope: EnterpriseScope;
  repos: ReturnType<typeof createRepositories>;
  identity: IdentityRepositories;
  access: ProviderAccessRepositories;
  sets: WorkspaceRepositorySetRepository;
  githubIntegrationId: string;
  githubInstanceId: string;
  gitlabInstanceId: string;
  gitlabIntegrationId: string;
  memberUserId: string | null;
  proposal: RepositorySetAdditionBinding[];
}

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

interface FixtureOptions {
  gate?: "enabled" | "disabled";
  actorGithubRole?: string;
  actorGitlabRole?: string;
  /** Absent means no second member at all. */
  member?: MemberSeed | null;
}

/**
 * One app per scenario: a real orchestrator with the identity surface, a
 * GitHub-seeded workspace, a GitLab instance and installation for the proposed
 * repository, and verified authority rows for every actor and member.
 */
async function startFixture(options: FixtureOptions = {}): Promise<ChangeFixture> {
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

  if (options.gate !== "disabled") {
    enableGate(db);
  }

  // The login's user is the actor; its provider identity on GitHub was created
  // by the login itself (subject 1001 — the fake profile id).
  repos.memberships.create(scope, { user_id: actor.userId, role: "owner" });

  const githubIntegration = app.integration;
  if (githubIntegration === undefined) {
    throw new Error("fixture requires the seeded GitHub integration");
  }
  const verifiedAt = nowIso();
  access.roster.applySnapshot(scope, githubIntegration.id, {
    roles: [
      {
        subject: "1001",
        login: "octo",
        source_kind: "direct_collaborator",
        provider_role: options.actorGithubRole ?? "admin",
        authority_ref: "github:FoMo-Exp/AutoFixer",
        inherited_from: null,
      },
    ],
    verified_at: verifiedAt,
  });

  const gitlab = seedProviderInstance(db, adminScope, {
    provider_type: "gitlab",
    origin_url: "https://gitlab.com",
  });
  const gitlabIntegration = access.integrations.create(scope, {
    provider_instance_id: gitlab.id,
    repository_id: REPO_B,
    repository_name: REPO_B_NAME,
    source_credential_ref: "svc-source-b",
    checkout_credential_ref: "svc-checkout-b",
    delivery_credential_ref: "svc-delivery-b",
    permission_visibility: "full",
    actor_id: "usr_test_operator",
  });
  identity.identities.create({
    user_id: actor.userId,
    provider_instance_id: gitlab.id,
    subject: "9501",
    login: "gitlab-owner",
    actor_id: "usr_test_operator",
  });
  access.roster.applySnapshot(scope, gitlabIntegration.id, {
    roles: [
      {
        subject: "9501",
        login: "gitlab-owner",
        source_kind: "direct_collaborator",
        provider_role: options.actorGitlabRole ?? "owner",
        authority_ref: REPO_B,
        inherited_from: null,
      },
    ],
    verified_at: verifiedAt,
  });

  // One provider-proven member with a GitHub and a GitLab identity.
  let memberUserId: string | null = null;
  const memberSeed = options.member === undefined ? null : options.member;
  if (memberSeed !== null) {
    const member = identity.users.create({
      display_name: "Repository Reader",
      actor_id: "usr_test_operator",
    });
    memberUserId = member.id;
    identity.enterpriseUsers.ensureActive(
      app.enterpriseId,
      member.id,
      { kind: "user", user_id: actor.userId },
      { provider_instance_id: app.providerInstanceId, subject: "1002" },
    );
    repos.memberships.create(scope, { user_id: member.id, role: "member" });
    if (memberSeed.github !== null) {
      identity.identities.create({
        user_id: member.id,
        provider_instance_id: app.providerInstanceId,
        subject: "1002",
        login: "octo-member",
        actor_id: "usr_test_operator",
      });
      access.roster.applySnapshot(scope, githubIntegration.id, {
        roles: [
          {
            subject: "1001",
            login: "octo",
            source_kind: "direct_collaborator",
            provider_role: options.actorGithubRole ?? "admin",
            authority_ref: "github:FoMo-Exp/AutoFixer",
            inherited_from: null,
          },
          {
            subject: "1002",
            login: "octo-member",
            source_kind: "direct_collaborator",
            provider_role: memberSeed.github,
            authority_ref: "github:FoMo-Exp/AutoFixer",
            inherited_from: null,
          },
        ],
        verified_at: verifiedAt,
      });
    }
    if (memberSeed.gitlab !== null) {
      identity.identities.create({
        user_id: member.id,
        provider_instance_id: gitlab.id,
        subject: "9502",
        login: "gitlab-member",
        actor_id: "usr_test_operator",
      });
      access.roster.applySnapshot(scope, gitlabIntegration.id, {
        roles: [
          {
            subject: "9501",
            login: "gitlab-owner",
            source_kind: "direct_collaborator",
            provider_role: options.actorGitlabRole ?? "owner",
            authority_ref: REPO_B,
            inherited_from: null,
          },
          {
            subject: "9502",
            login: "gitlab-member",
            source_kind: "direct_collaborator",
            provider_role: memberSeed.gitlab,
            authority_ref: REPO_B,
            inherited_from: null,
          },
        ],
        verified_at: memberSeed.gitlabVerifiedAt ?? verifiedAt,
      });
    }
  }

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
    githubIntegrationId: githubIntegration.id,
    githubInstanceId: app.providerInstanceId,
    gitlabInstanceId: gitlab.id,
    gitlabIntegrationId: gitlabIntegration.id,
    memberUserId,
    proposal: [
      {
        provider_instance_id: gitlab.id,
        installation_ref: gitlabIntegration.id,
        repository_id: REPO_B,
        repository_name: CALLER_NAME,
        repository_url: CALLER_URL,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const BASE = (fx: ChangeFixture): string =>
  `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}/repository-set-additions`;

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown>; category: string };
}

async function preview(
  fx: ChangeFixture,
  body: Record<string, unknown>,
  session: LoggedInSession = fx.actor,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson<Record<string, unknown>>(
    BASE(fx) + "/preview",
    body,
    cookieSessionHeaders(session),
  );
}

async function confirm(
  fx: ChangeFixture,
  body: Record<string, unknown>,
  session: LoggedInSession = fx.actor,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson<Record<string, unknown>>(
    BASE(fx) + "/confirmations",
    body,
    cookieSessionHeaders(session),
  );
}

async function commit(
  fx: ChangeFixture,
  confirmationId: string,
  session: LoggedInSession = fx.actor,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson<Record<string, unknown>>(
    `${BASE(fx)}/confirmations/${confirmationId}/commit`,
    {},
    cookieSessionHeaders(session),
  );
}

function proposalBody(fx: ChangeFixture, expectedSetVersion: number): Record<string, unknown> {
  return { expected_set_version: expectedSetVersion, additional_repositories: fx.proposal };
}

interface PreviewMember {
  membership_id: string;
  user_id: string;
  role: string;
  retains_admission: boolean;
  current_capabilities: string[];
  proposed_capabilities: string[];
  reduction: string[];
  evidence_classes: string[];
  evidence_complete: boolean;
  reason: string | null;
  verified_at: string | null;
}

interface PreviewBody {
  preview: true;
  authorizes_access: false;
  set_version: number;
  proposed_repository_count: number;
  multi_repository_gate: string;
  members: PreviewMember[];
  owners: Array<{ user_id: string; effective: boolean; reason: string | null }>;
  last_owner_survives: boolean;
  all_members_retain_admission: boolean;
  reductions_required: Array<{ membership_id: string; user_id: string; capabilities: string[] }>;
  impact: Record<string, unknown>;
  committable: boolean;
  commit_blocked_reasons: string[];
}

interface ConfirmationBody {
  confirmation_id: string;
  set_version: number;
  proposed_repositories: Array<{ provider_instance_id: string; repository_id: string }>;
  expires_at: string;
}

function bindingRows(fx: ChangeFixture): Array<Record<string, unknown>> {
  return fx.db
    .prepare(
      `SELECT * FROM workspace_repository_binding
        WHERE enterprise_id = ? AND workspace_id = ?
        ORDER BY position, id`,
    )
    .all(fx.scope.enterprise_id, fx.scope.workspace_id) as Array<Record<string, unknown>>;
}

function setVersion(fx: ChangeFixture): number {
  const row = fx.db
    .prepare("SELECT repository_set_version FROM workspace WHERE id = ?")
    .get(fx.scope.workspace_id) as { repository_set_version: number };
  return row.repository_set_version;
}

function confirmationRows(fx: ChangeFixture): Array<Record<string, unknown>> {
  return fx.db
    .prepare(
      `SELECT * FROM workspace_repository_set_confirmation
        WHERE enterprise_id = ? AND workspace_id = ?
        ORDER BY created_at, id`,
    )
    .all(fx.scope.enterprise_id, fx.scope.workspace_id) as Array<Record<string, unknown>>;
}

function ceilingRows(fx: ChangeFixture): Array<Record<string, unknown>> {
  return fx.db
    .prepare(
      `SELECT * FROM workspace_member_capability
        WHERE enterprise_id = ? AND workspace_id = ?`,
    )
    .all(fx.scope.enterprise_id, fx.scope.workspace_id) as Array<Record<string, unknown>>;
}

function auditRows(fx: ChangeFixture, event: string): Array<Record<string, unknown>> {
  return fx.db
    .prepare("SELECT * FROM auth_audit WHERE event = ? ORDER BY at, id")
    .all(event) as Array<Record<string, unknown>>;
}

function memberPreview(previewBody: PreviewBody, userId: string): PreviewMember {
  const member = previewBody.members.find((entry) => entry.user_id === userId);
  if (member === undefined) {
    throw new Error(`member ${userId} missing from the preview`);
  }
  return member;
}

/**
 * Confirm exactly the preview's required reductions. The route is given the
 * list the preview reported, never a hard-coded expectation, so the test
 * cannot disagree with what a real caller would have to acknowledge.
 */
async function previewAndConfirm(fx: ChangeFixture) {
  const previewed = await preview(fx, proposalBody(fx, 1));
  expect(previewed.status).toBe(200);
  const previewBody = previewed.body as unknown as PreviewBody;
  const confirmed = await confirm(fx, {
    ...proposalBody(fx, previewBody.set_version),
    confirmed_reductions: previewBody.reductions_required,
  });
  return { previewBody, confirmed };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("repository-set addition API", () => {
  test("previews the full-set impact across GitHub and GitLab without writing", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    expect(fx.memberUserId).not.toBeNull();

    const response = await preview(fx, proposalBody(fx, 1));
    expect(response.status).toBe(200);
    const body = response.body as unknown as PreviewBody;
    expectContract("RepositorySetAdditionPreview", body);
    capture("addition-preview-reduction.json", body);

    expect(body.preview).toBe(true);
    expect(body.authorizes_access).toBe(false);
    expect(body.set_version).toBe(1);
    expect(body.proposed_repository_count).toBe(2);
    expect(body.multi_repository_gate).toBe("enabled");
    expect(body.committable).toBe(true);
    expect(body.commit_blocked_reasons).toEqual([]);

    // The actor keeps full management on both repositories: no reduction.
    const actorImpact = memberPreview(body, fx.actor.userId);
    expect(actorImpact.role).toBe("owner");
    expect(actorImpact.retains_admission).toBe(true);
    expect(actorImpact.reduction).toEqual([]);
    expect(actorImpact.proposed_capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
      "repository_manage",
    ]);

    // The member writes on GitHub and only reports on GitLab: read survives,
    // write and issue-write are reduced. Before/after are both reported.
    const memberImpact = memberPreview(body, fx.memberUserId as string);
    expect(memberImpact.role).toBe("member");
    expect(memberImpact.retains_admission).toBe(true);
    expect(memberImpact.evidence_classes).toEqual([]);
    expect(memberImpact.current_capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
    ]);
    expect(memberImpact.proposed_capabilities).toEqual(["code_read"]);
    expect(memberImpact.reduction).toEqual(["issue_write", "repository_write"]);

    expect(body.owners).toEqual([{ user_id: fx.actor.userId, effective: true, reason: null }]);
    expect(body.last_owner_survives).toBe(true);
    expect(body.all_members_retain_admission).toBe(true);
    expect(body.reductions_required).toEqual([
      {
        membership_id: memberImpact.membership_id,
        user_id: fx.memberUserId,
        capabilities: ["issue_write", "repository_write"],
      },
    ]);
    expect(body.impact).toEqual({
      proposed_repository_count: 2,
      protected_members: 2,
      reduced_members: 1,
      removed_capabilities: 2,
      effective_owners: 1,
      last_owner_survives: true,
    });

    // Writes nothing: no binding, no set-version move, no confirmation.
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
    expect(confirmationRows(fx)).toHaveLength(0);

    // Disclosure: no repository URL/name, credential ref or provider subject.
    const serialized = JSON.stringify(body);
    for (const secret of [
      REPO_B_NAME,
      REPO_B_URL,
      CALLER_NAME,
      CALLER_URL,
      "svc-source-b",
      "9502",
      "1001",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("confirms the exact reduction and commits the bindings atomically", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const { previewBody, confirmed } = await previewAndConfirm(fx);
    expect(confirmed.status).toBe(201);
    const confirmation = confirmed.body as unknown as ConfirmationBody;
    expectContract("RepositorySetAdditionConfirmation", confirmation);
    capture("addition-confirmation.json", confirmation);

    expect(confirmation.set_version).toBe(1);
    expect(confirmation.proposed_repositories).toEqual([
      { provider_instance_id: fx.gitlabInstanceId, repository_id: REPO_B },
    ]);
    expect(Date.parse(confirmation.expires_at)).toBeGreaterThan(Date.now());
    expect(confirmationRows(fx)).toHaveLength(1);
    // The confirmation alone writes no binding and moves no set version.
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);

    const committed = await commit(fx, confirmation.confirmation_id);
    expect(committed.status).toBe(200);
    expectContract("RepositorySetAdditionCommitResult", committed.body);
    capture("addition-commit-result.json", committed.body);
    expect(committed.body).toMatchObject({
      workspace_id: fx.app.workspaceId,
      confirmation_id: confirmation.confirmation_id,
      set_version_before: 1,
      set_version_after: 2,
      repositories: [{ provider_instance_id: fx.gitlabInstanceId, repository_id: REPO_B }],
      members_reduced: [{ user_id: fx.memberUserId, capabilities: ["code_read"] }],
      grants_revoked: 0,
      effective_owners: [fx.actor.userId],
    });

    // Durable outcome: two bindings, the new set version, the member's ceiling
    // reduced with its reason, the assigned role untouched, and both audit rows.
    const bindings = bindingRows(fx);
    expect(bindings).toHaveLength(2);
    const added = bindings.find((row) => row["repository_id"] === REPO_B);
    expect(added?.["installation_ref"]).toBe(fx.gitlabIntegrationId);
    // The binding's name comes from the verified installation, never the caller.
    expect(added?.["repository_name"]).toBe(REPO_B_NAME);
    expect(added?.["repository_url"]).toBeNull();
    expect(setVersion(fx)).toBe(2);

    const membership = fx.repos.memberships.getByUser(fx.scope, fx.memberUserId as string);
    expect(membership?.role).toBe("member");

    const ceilings = ceilingRows(fx).filter((row) => row["user_id"] === fx.memberUserId);
    expect(ceilings).toHaveLength(1);
    expect(JSON.parse(String(ceilings[0]?.["ceiling"]))).toEqual(["code_read"]);
    expect(ceilings[0]?.["reason"]).toBe("repository_set_changed");
    expect(ceilings[0]?.["state"]).toBe("downgraded");

    expect(auditRows(fx, "repository_set.addition_confirmed")).toHaveLength(1);
    expect(auditRows(fx, "repository_set.addition_committed")).toHaveLength(1);
    expect(confirmationRows(fx)[0]?.["consumed_at"]).not.toBeNull();

    // The decision record never retains display metadata.
    const stored = JSON.stringify(confirmationRows(fx));
    for (const secret of [REPO_B_NAME, REPO_B_URL, CALLER_NAME, CALLER_URL]) {
      expect(stored).not.toContain(secret);
    }
    expect(previewBody.committable).toBe(true);
  });

  test("refuses a confirmation that does not acknowledge the exact reductions", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const previewed = await preview(fx, proposalBody(fx, 1));
    expect(previewed.status).toBe(200);

    const refused = await confirm(fx, {
      ...proposalBody(fx, 1),
      confirmed_reductions: [],
    });
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
    );
    expect(confirmationRows(fx)).toHaveLength(0);
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
  });

  test("refuses the whole addition when a member's evidence is unknown", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: null },
    });
    const previewed = await preview(fx, proposalBody(fx, 1));
    expect(previewed.status).toBe(200);
    const body = previewed.body as unknown as PreviewBody;
    expectContract("RepositorySetAdditionPreview", body);
    capture("addition-preview-unknown-evidence.json", body);

    const member = memberPreview(body, fx.memberUserId as string);
    expect(member.retains_admission).toBe(false);
    expect(member.evidence_complete).toBe(false);
    expect(member.evidence_classes).toEqual(["unknown"]);
    expect(member.reduction).toEqual([]);
    expect(body.all_members_retain_admission).toBe(false);
    expect(body.committable).toBe(false);
    expect(body.commit_blocked_reasons).toEqual(["MEMBER_ADMISSION_NOT_RETAINED"]);

    const refused = await confirm(fx, {
      ...proposalBody(fx, 1),
      confirmed_reductions: [],
    });
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE",
    );

    // Unknown evidence is neither a removal nor a downgrade: the member keeps
    // the membership and no ceiling row is written.
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
    expect(confirmationRows(fx)).toHaveLength(0);
    expect(ceilingRows(fx)).toHaveLength(0);
    expect(fx.repos.memberships.getByUser(fx.scope, fx.memberUserId as string)).toBeDefined();
  });

  test("refuses the whole addition when a member's evidence has expired", async () => {
    const fx = await startFixture({
      member: {
        github: "write",
        gitlab: "reporter",
        gitlabVerifiedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      },
    });
    const previewed = await preview(fx, proposalBody(fx, 1));
    expect(previewed.status).toBe(200);
    const body = previewed.body as unknown as PreviewBody;
    const member = memberPreview(body, fx.memberUserId as string);
    expect(member.evidence_classes).toEqual(["expired"]);
    expect(member.retains_admission).toBe(false);
    expect(body.committable).toBe(false);

    const refused = await confirm(fx, { ...proposalBody(fx, 1), confirmed_reductions: [] });
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE",
    );
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
  });

  test("refuses the whole addition when a member would lose verified code read", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "guest" },
    });
    const previewed = await preview(fx, proposalBody(fx, 1));
    expect(previewed.status).toBe(200);
    const body = previewed.body as unknown as PreviewBody;
    const member = memberPreview(body, fx.memberUserId as string);
    // The evidence verified; the intersection simply has no read.
    expect(member.evidence_complete).toBe(true);
    expect(member.reason).toBe("no_code_read");
    expect(member.retains_admission).toBe(false);
    expect(body.commit_blocked_reasons).toEqual(["MEMBER_ADMISSION_NOT_RETAINED"]);

    const refused = await confirm(fx, { ...proposalBody(fx, 1), confirmed_reductions: [] });
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE",
    );
    expect(setVersion(fx)).toBe(1);
  });

  test("protects the last effective owner even when everyone still reads", async () => {
    const fx = await startFixture({
      actorGitlabRole: "maintainer",
      member: { github: "write", gitlab: "reporter" },
    });
    const previewed = await preview(fx, proposalBody(fx, 1));
    expect(previewed.status).toBe(200);
    const body = previewed.body as unknown as PreviewBody;
    capture("addition-preview-last-owner.json", body);

    const actorImpact = memberPreview(body, fx.actor.userId);
    expect(actorImpact.retains_admission).toBe(true);
    expect(actorImpact.proposed_capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
    ]);
    expect(actorImpact.reduction).toEqual(["repository_manage"]);
    expect(body.owners).toEqual([
      { user_id: fx.actor.userId, effective: false, reason: "management_missing" },
    ]);
    expect(body.last_owner_survives).toBe(false);
    expect(body.all_members_retain_admission).toBe(true);
    expect(body.committable).toBe(false);
    expect(body.commit_blocked_reasons).toEqual(["LAST_EFFECTIVE_OWNER_MISSING"]);
    // The reduction is disclosed, not hidden behind the refusal.
    expect(body.reductions_required).toHaveLength(2);

    const refused = await confirm(fx, {
      ...proposalBody(fx, 1),
      confirmed_reductions: body.reductions_required,
    });
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_NOT_ADMISSIBLE",
    );
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
  });

  test("refuses a stale confirmation and requires a fresh preview after facts change", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const { confirmed } = await previewAndConfirm(fx);
    expect(confirmed.status).toBe(201);
    const confirmation = confirmed.body as unknown as ConfirmationBody;

    // The provider confirms a lower role for the member after the decision.
    fx.access.roster.applySnapshot(fx.scope, fx.githubIntegrationId, {
      roles: [
        {
          subject: "1001",
          login: "octo",
          source_kind: "direct_collaborator",
          provider_role: "admin",
          authority_ref: "github:FoMo-Exp/AutoFixer",
          inherited_from: null,
        },
        {
          subject: "1002",
          login: "octo-member",
          source_kind: "direct_collaborator",
          provider_role: "read",
          authority_ref: "github:FoMo-Exp/AutoFixer",
          inherited_from: null,
        },
      ],
      verified_at: nowIso(),
    });

    const stale = await commit(fx, confirmation.confirmation_id);
    expect(stale.status).toBe(409);
    expect((stale.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
    );
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
    expect(confirmationRows(fx)[0]?.["consumed_at"]).toBeNull();

    // A fresh preview now sees nothing to reduce (read on both repositories),
    // and the change commits cleanly.
    const fresh = await preview(fx, proposalBody(fx, 1));
    expect(fresh.status).toBe(200);
    const freshBody = fresh.body as unknown as PreviewBody;
    expect(freshBody.reductions_required).toEqual([]);
    expect(freshBody.committable).toBe(true);
    const reconfirmed = await confirm(fx, {
      ...proposalBody(fx, freshBody.set_version),
      confirmed_reductions: [],
    });
    expect(reconfirmed.status).toBe(201);
    const recommitted = await commit(
      fx,
      (reconfirmed.body as unknown as ConfirmationBody).confirmation_id,
    );
    expect(recommitted.status).toBe(200);
    expect(setVersion(fx)).toBe(2);
  });

  test("refuses a consumed confirmation and a stale set version", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const wrongVersion = await preview(fx, proposalBody(fx, 99));
    expect(wrongVersion.status).toBe(409);
    expect((wrongVersion.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_VERSION_CONFLICT",
    );

    const { confirmed } = await previewAndConfirm(fx);
    const confirmation = confirmed.body as unknown as ConfirmationBody;
    expect((await commit(fx, confirmation.confirmation_id)).status).toBe(200);

    const replay = await commit(fx, confirmation.confirmation_id);
    expect(replay.status).toBe(409);
    expect((replay.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_CONFIRMATION_CONSUMED",
    );
    expect(bindingRows(fx)).toHaveLength(2);
    expect(setVersion(fx)).toBe(2);
  });

  test("refuses a commit whose required audit cannot be written, committing nothing", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const { confirmed } = await previewAndConfirm(fx);
    const confirmation = confirmed.body as unknown as ConfirmationBody;

    // Required audit evidence becomes unwritable: the whole change must roll
    // back instead of committing unaudited.
    fx.db.exec(
      `CREATE TRIGGER fail_repository_set_audit
         BEFORE INSERT ON auth_audit
         WHEN NEW.event = 'repository_set.addition_committed'
       BEGIN
         SELECT RAISE(ABORT, 'audit store unavailable');
       END`,
    );
    const failed = await commit(fx, confirmation.confirmation_id);
    expect(failed.status).toBe(500);
    expect((failed.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_AUDIT_FAILED",
    );
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
    expect(ceilingsForMember(fx)).toHaveLength(0);
    expect(confirmationRows(fx)[0]?.["consumed_at"]).toBeNull();
    expect(auditRows(fx, "repository_set.addition_committed")).toHaveLength(0);

    // Once audit is writable the same confirmation commits exactly once.
    fx.db.exec("DROP TRIGGER fail_repository_set_audit");
    const retried = await commit(fx, confirmation.confirmation_id);
    expect(retried.status).toBe(200);
    expect(bindingRows(fx)).toHaveLength(2);
    expect(setVersion(fx)).toBe(2);
    expect(auditRows(fx, "repository_set.addition_committed")).toHaveLength(1);
  });

  test("refuses to change the set while the multi-repository gate is disabled", async () => {
    const fx = await startFixture({
      gate: "disabled",
      member: { github: "write", gitlab: "reporter" },
    });
    const previewed = await preview(fx, proposalBody(fx, 1));
    expect(previewed.status).toBe(200);
    const body = previewed.body as unknown as PreviewBody;
    expect(body.multi_repository_gate).toBe("disabled");
    expect(body.committable).toBe(false);
    expect(body.commit_blocked_reasons).toContain("MULTI_REPOSITORY_GATE_DISABLED");

    const refused = await confirm(fx, {
      ...proposalBody(fx, 1),
      confirmed_reductions: body.reductions_required,
    });
    expect(refused.status).toBe(403);
    expect((refused.body as unknown as ErrorBody).error.code).toBe("SCOPE_MUTATION_DISABLED");
    expect(confirmationRows(fx)).toHaveLength(0);
    expect(bindingRows(fx)).toHaveLength(1);
  });

  test("refuses an actor without repository management authority", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const membership = fx.repos.memberships.getByUser(fx.scope, fx.actor.userId);
    if (membership === undefined) {
      throw new Error("actor membership missing");
    }
    // A provider-proven administrator can still be a plain member: the assigned
    // workspace role gates administration, and a role-only claim never does.
    fx.repos.memberships.updateRole(fx.scope, membership.id, "member", membership.version);

    const refused = await preview(fx, proposalBody(fx, 1));
    expect(refused.status).toBe(403);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED",
    );
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
  });

  test("does not enumerate workspaces the caller is not a member of", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const foreign = fx.repos.workspaces.create(
      {
        enterprise_id: fx.app.enterpriseId,
        actor_id: "usr_test_operator",
      },
      {
        name: "Foreign Workspace",
        repository_id: "github:FoMo-Exp/Other",
        provider_instance_id: fx.githubInstanceId,
      },
    );
    for (const workspaceId of [foreign.id, "ws_does_not_exist"]) {
      const response = await postJson<Record<string, unknown>>(
        `${fx.app.base}/api/v1/workspaces/${workspaceId}/repository-set-additions/preview`,
        proposalBody(fx, 1),
        cookieSessionHeaders(fx.actor),
      );
      expect(response.status, workspaceId).toBe(404);
      expect((response.body as unknown as ErrorBody).error.code).toBe("NOT_FOUND");
    }
  });

  test("re-authorizes the actor at commit and refuses a demoted decider", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const { confirmed } = await previewAndConfirm(fx);
    const confirmation = confirmed.body as unknown as ConfirmationBody;

    const membership = fx.repos.memberships.getByUser(fx.scope, fx.actor.userId);
    if (membership === undefined) {
      throw new Error("actor membership missing");
    }
    fx.repos.memberships.updateRole(fx.scope, membership.id, "member", membership.version);

    const refused = await commit(fx, confirmation.confirmation_id);
    expect(refused.status).toBe(403);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED",
    );
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
    expect(confirmationRows(fx)[0]?.["consumed_at"]).toBeNull();
  });

  test("serializes concurrent commits: one addition commits and the other is stale", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const first = await previewAndConfirm(fx);
    const second = await previewAndConfirm(fx);
    const firstId = (first.confirmed.body as unknown as ConfirmationBody).confirmation_id;
    const secondId = (second.confirmed.body as unknown as ConfirmationBody).confirmation_id;

    // Both decisions name set version 1; only the first may commit. The loser
    // is refused before writing anything: the set version it decided against is
    // gone, and in this build the resulting two-repository set authorizes
    // nothing yet (DAT-288 opens enforcement).
    const [a, b] = await Promise.all([commit(fx, firstId), commit(fx, secondId)]);
    expect([a.status, b.status].filter((status) => status === 200)).toHaveLength(1);
    const denied = a.status === 200 ? b : a;
    expect(denied.status).toBeGreaterThanOrEqual(403);
    expect([
      "REPOSITORY_SET_CHANGE_CONFIRMATION_STALE",
      "MULTI_REPOSITORY_SCOPE_UNSUPPORTED",
    ]).toContain((denied.body as unknown as ErrorBody).error.code);
    expect(bindingRows(fx)).toHaveLength(2);
    expect(setVersion(fx)).toBe(2);
    expect(auditRows(fx, "repository_set.addition_committed")).toHaveLength(1);
  });

  test("refuses an expired confirmation and requires a fresh decision", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const { confirmed } = await previewAndConfirm(fx);
    const confirmation = confirmed.body as unknown as ConfirmationBody;

    // Age the bounded validity window past its expiry.
    fx.db
      .prepare(
        `UPDATE workspace_repository_set_confirmation
            SET expires_at = ?
          WHERE id = ?`,
      )
      .run(new Date(Date.now() - 1000).toISOString(), confirmation.confirmation_id);

    const refused = await commit(fx, confirmation.confirmation_id);
    expect(refused.status).toBe(409);
    expect((refused.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_CONFIRMATION_EXPIRED",
    );
    expect(bindingRows(fx)).toHaveLength(1);
    expect(setVersion(fx)).toBe(1);
  });
});

function ceilingsForMember(fx: ChangeFixture): Array<Record<string, unknown>> {
  return ceilingRows(fx).filter((row) => row["user_id"] === fx.memberUserId);
}

// ---------------------------------------------------------------------------
// DAT-288: full-chain acceptance gate
//
// The repository-addition decision above is only safe if every other path
// refuses the resulting multi-repository scope in this build. These tests pin
// that closure at the real HTTP boundary, across a process restart, in the
// worker-step policy, and against the mixed-version guards. They do not open
// the gate: the gate is a rollout decision, and this build has no
// multi-repository execution target binding.
// ---------------------------------------------------------------------------

interface ProjectionBody {
  state: string;
  blocked_reason: string | null;
  capabilities: string[];
  modules: Record<
    string,
    {
      visible: boolean;
      data_ceiling: string;
      reason: string | null;
      actions: Record<string, { allowed: boolean; reason?: string }>;
    }
  >;
  authority: { set_version: number; repository_count: number };
}

async function expectEveryProtectedPathClosed(fx: ChangeFixture): Promise<void> {
  const cookie = cookieSessionHeaders(fx.actor);
  const workspace = `${fx.app.base}/api/v1/workspaces/${fx.app.workspaceId}`;

  // The projection is advisory, and its own answer is "no verified data":
  // tasks stay visible (the role exists) but carry no ceiling and no action.
  const projection = await getJson<ProjectionBody>(`${workspace}/capabilities`, cookie);
  expect(projection.status).toBe(200);
  expect(projection.body).toMatchObject({
    state: "unverified",
    blocked_reason: "repository_set_unsupported",
    capabilities: [],
    authority: { set_version: 2, repository_count: 2 },
  });
  const tasks = projection.body.modules["tasks"]!;
  expect(tasks).toMatchObject({ visible: true, data_ceiling: "none" });
  expect(tasks.actions["view"]).toMatchObject({ allowed: false });
  expect(tasks.actions["create"]).toMatchObject({ allowed: false });
  expect(tasks.actions["stream"]).toMatchObject({ allowed: false });

  // Every action class, the legacy task seam, and the collaboration delivery
  // seam deny before any route body runs.
  const probes: Array<["GET" | "POST", string, unknown]> = [
    ["GET", `${workspace}/tasks`, undefined],
    ["POST", `${workspace}/tasks`, { repository_id: REPO_B, base_ref: "main", summary: "probe" }],
    ["GET", `${workspace}/tasks/task_probe`, undefined],
    ["GET", `${workspace}/tasks/task_probe/stream`, undefined],
    ["GET", `${workspace}/tasks/task_probe/artifacts/art_probe`, undefined],
    ["POST", `${workspace}/tasks/task_probe/approvals`, { decision: "approved" }],
    ["POST", `${workspace}/tasks/task_probe/messages`, { mode: "follow_up", content: "probe" }],
    ["GET", `${workspace}/issues`, undefined],
    ["POST", `${workspace}/issues/issue_probe/deliveries`, {}],
    ["GET", `${fx.app.base}/api/v1/tasks`, undefined],
  ];
  for (const [method, url, body] of probes) {
    const response =
      method === "GET"
        ? await getJson<ErrorBody>(url, cookie)
        : await postJson<ErrorBody>(url, body ?? {}, cookie);
    expect(response.status, `${method} ${url}`).toBe(403);
    expect(response.body.error.code, `${method} ${url}`).toBe("AUTHORITY_RECHECK_REQUIRED");
  }
}

describe("full-chain acceptance gate (DAT-288)", () => {
  test("the committed set denies every protected path before and after a restart", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const { confirmed } = await previewAndConfirm(fx);
    const committed = await commit(
      fx,
      (confirmed.body as unknown as ConfirmationBody).confirmation_id,
    );
    expect(committed.status).toBe(200);

    await expectEveryProtectedPathClosed(fx);

    // No second change can even be previewed on top of a set this build
    // cannot enforce: the manager's own capability intersection is unverified,
    // so the surface refuses instead of disclosing an impact it cannot act on.
    const after = await preview(fx, proposalBody(fx, 2));
    expect(after.status).toBe(403);
    expect((after.body as unknown as ErrorBody).error.code).toBe(
      "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED",
    );

    // A process restart re-reads the gate and the set from durable storage;
    // nothing was cached, so the answer is the same.
    await fx.app.restart();
    await expectEveryProtectedPathClosed(fx);

    const restartedDb = fx.app.orchestrator.controlPlane as ControlPlaneDb;
    const set = createWorkspaceRepositorySetRepository(restartedDb).getSet(fx.scope);
    expect(set.multi_repository).toBe(true);
    expect(set.set_version).toBe(2);
    expect(set.bindings).toHaveLength(2);
    expect(set.blocked_reason).toBe("MULTI_REPOSITORY_SCOPE_UNSUPPORTED");
  });

  test("a worker step bound to the old set is terminal, and the new set grants nothing", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const { confirmed } = await previewAndConfirm(fx);
    const committed = await commit(
      fx,
      (confirmed.body as unknown as ConfirmationBody).confirmation_id,
    );
    expect(committed.status).toBe(200);

    const authority = fx.app.orchestrator.providerAuthority;
    expect(authority).toBeDefined();
    const policy = createRunStepAuthority({
      enterpriseId: fx.scope.enterprise_id,
      actorId: "usr_acceptance",
      repositorySets: fx.sets,
      authority: authority!,
    });
    const stepBase = {
      enterprise_id: fx.scope.enterprise_id,
      workspace_id: fx.scope.workspace_id,
      repository_id: REPOSITORY_ID,
      requested_by: { kind: "session" as const, user_id: fx.actor.userId },
    };

    // A run created against set 1 must not keep acting after the addition.
    expect(policy({ ...stepBase, repository_set_version: 1 })).toMatchObject({
      allowed: false,
      code: "REPOSITORY_SET_VERSION_CONFLICT",
      terminal: true,
    });
    // A run created against set 2 matches its target but this build cannot
    // authorize a multi-repository workspace, so the step is refused too.
    const current = policy({ ...stepBase, repository_set_version: 2 });
    expect(current.allowed).toBe(false);
    expect(current.code).toBe("AUTHORITY_RECHECK_REQUIRED");
    expect(current.reason).toBe("capability_unverified");
    expect(current.terminal).toBe(false);
  });

  test("another tenant and an unknown workspace never expose the set or its preview", async () => {
    const fx = await startFixture({
      member: { github: "write", gitlab: "reporter" },
    });
    const foreignSet = {
      enterprise_id: "ent_other",
      workspace_id: fx.app.workspaceId,
      actor_id: "usr_other",
    };
    expect(() => fx.sets.getSet(foreignSet)).toThrow(/not found/i);
    expect(() => fx.sets.listBindings(foreignSet)).toThrow(/not found/i);

    const response = await postJson<ErrorBody>(
      `${fx.app.base}/api/v1/workspaces/wsp_other/repository-set-additions/preview`,
      proposalBody(fx, 1),
      cookieSessionHeaders(fx.actor),
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  test("an older build or a newer rollout decision refuses to establish authority", async () => {
    const fx = await startFixture();

    // An older build (lower supported schema) may not serve this database at
    // all: it would ignore the repository set it cannot enforce.
    expect(() => assertSchemaSupported(fx.db, CURRENT_SCHEMA_VERSION - 1)).toThrow(
      /newer than this build/,
    );

    // A gate row decided by a newer schema is unreadable, not "enabled".
    fx.db
      .prepare(
        `INSERT INTO deployment_feature_gate
           (key, min_schema_version, state, reason, created_at, created_by)
         VALUES (?, ?, 'enabled', ?, ?, ?)`,
      )
      .run(
        MULTI_REPOSITORY_GATE_KEY,
        CURRENT_SCHEMA_VERSION + 1,
        "future rollout this build does not understand",
        nowIso(),
        "usr_auth_system",
      );

    let refused: unknown;
    try {
      fx.sets.gate();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(WorkspaceRepositorySetError);
    expect((refused as WorkspaceRepositorySetError).code).toBe("FEATURE_GATE_UNREADABLE");
  });
});
