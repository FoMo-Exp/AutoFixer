/**
 * Shared fixtures for the candidate-admission tests (DAT-234).
 *
 * Not a `*.test.ts` file, so vitest does not collect it.
 */

import {
  openControlPlaneDb,
  seedEnterprise,
  seedProviderInstance,
  seedWorkspace,
} from "../../src/control-plane/index.js";
import type { ControlPlaneDb, WorkspaceScope } from "../../src/control-plane/index.js";
import {
  createMemoryAdmissionRepository,
  createMemoryRepositories,
  ledgerEvidenceResolver,
} from "../../src/memory/index.js";
import type {
  AdmissionCandidate,
  EvidenceResolution,
  MemoryAdmissionRepository,
  MemoryItemRecord,
  MemoryRepositories,
} from "../../src/memory/index.js";

export const ACTOR = "usr_admin";
export const NOW = "2026-11-15T00:00:00Z";

export interface Fixture {
  db: ControlPlaneDb;
  memory: MemoryRepositories;
  admission: MemoryAdmissionRepository;
  scopeA: WorkspaceScope;
  scopeB: WorkspaceScope;
  scopeForeign: WorkspaceScope;
}

export function bootstrap(): Fixture {
  const db = openControlPlaneDb();
  const memory = createMemoryRepositories(db);
  const admission = createMemoryAdmissionRepository(db);

  const first = seedEnterprise(db, {
    enterprise_name: "Enterprise One",
    enterprise_slug: "ent-one",
    admin_user_id: ACTOR,
  });
  const providerOne = seedProviderInstance(db, first.admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspaceA = seedWorkspace(db, first.admin_scope, {
    name: "Workspace A",
    repository_id: "repo-a",
    provider_instance_id: providerOne.id,
  });
  const workspaceB = seedWorkspace(db, first.admin_scope, {
    name: "Workspace B",
    repository_id: "repo-b",
    provider_instance_id: providerOne.id,
  });
  const second = seedEnterprise(db, {
    enterprise_name: "Enterprise Two",
    enterprise_slug: "ent-two",
    admin_user_id: ACTOR,
  });
  const providerTwo = seedProviderInstance(db, second.admin_scope, {
    provider_type: "github",
    origin_url: "https://github.com",
  });
  const workspaceForeign = seedWorkspace(db, second.admin_scope, {
    name: "Foreign Workspace",
    repository_id: "repo-a",
    provider_instance_id: providerTwo.id,
  });

  return {
    db,
    memory,
    admission,
    scopeA: { enterprise_id: first.enterprise.id, workspace_id: workspaceA.id, actor_id: ACTOR },
    scopeB: { enterprise_id: first.enterprise.id, workspace_id: workspaceB.id, actor_id: ACTOR },
    scopeForeign: {
      enterprise_id: second.enterprise.id,
      workspace_id: workspaceForeign.id,
      actor_id: ACTOR,
    },
  };
}

/**
 * The captured-evidence ledger a candidate's citations resolve against. Every
 * fixture evidence reference is here unless a test deliberately omits one.
 */
export const LEDGER: readonly EvidenceResolution[] = [
  {
    evidence_type: "run",
    reference: "run_known",
    known: true,
    positive: true,
  },
  {
    evidence_type: "pr",
    reference: "pr_101",
    known: true,
    positive: true,
  },
  {
    evidence_type: "test",
    reference: "test_ci",
    known: true,
    positive: true,
  },
  {
    evidence_type: "reviewer_decision",
    reference: "review_7",
    known: true,
    positive: true,
  },
  {
    evidence_type: "run",
    reference: "run_timeout",
    known: false,
    positive: false,
  },
];

export function ledger() {
  return ledgerEvidenceResolver(LEDGER);
}

/** A clean, well-evidenced candidate every test mutates from. */
export function candidate(overrides: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    kind: "fact",
    scope: { path_prefix: "node/src" },
    statement: "The workspace runs its checks with npm run lint before every push.",
    preconditions: ["when validating a Node change"],
    provenance: { author_type: "agent", agent_model: "claude-sonnet-5-5" },
    trust: "agent",
    sensitivity: "internal",
    valid_from: "2026-11-01T00:00:00Z",
    valid_to: null,
    source_run_id: "run_known",
    evidence: [{ evidence_type: "run", reference: "run_known" }],
    ...overrides,
  };
}

/**
 * A real item placed in the corpus **without** going through the admission
 * gate. Several tests rely on exactly that: an item with no admission decision
 * must not be retrieval-eligible.
 */
export function seedItem(
  fixture: Fixture,
  scope: WorkspaceScope,
  overrides: Partial<AdmissionCandidate> = {},
): MemoryItemRecord {
  const input = candidate(overrides);
  return fixture.memory.items.create(scope, {
    kind: input.kind,
    scope: input.scope,
    statement: input.statement,
    preconditions: input.preconditions,
    provenance: input.provenance,
    trust: input.trust,
    sensitivity: input.sensitivity,
    valid_from: input.valid_from,
    valid_to: input.valid_to ?? null,
    source_run_id: input.source_run_id ?? null,
  });
}
