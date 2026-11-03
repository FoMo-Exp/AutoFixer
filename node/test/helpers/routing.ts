import { expect } from "vitest";

import type { RoutingError as RoutingErrorType } from "../../src/routing/errors.js";
import { RoutingError } from "../../src/routing/errors.js";
import type {
  AffectedFile,
  BlameFact,
  DirectoryMember,
  DirectoryTeam,
  ProviderIdentityRef,
  RouteEvidence,
  RoutingDirectory,
  RoutingPolicy,
  RoutingScope,
  ServiceMapping,
} from "../../src/routing/types.js";
import { RoutingMachine } from "../../src/routing/machine.js";
import type { UserStatus } from "../../src/control-plane/identity-types.js";
import type { WorkspaceRole } from "../../src/control-plane/types.js";
import { Clock, op } from "./collab.js";

export { Clock, op };

export const ACTOR = "system:routing";
export const SCOPE: RoutingScope = { enterprise_id: "ent_test", workspace_id: "ws_test" };

/** Assert that `fn` fails with exactly the routing denial code. */
export function expectCode(fn: () => unknown, code: RoutingErrorType["code"]): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof RoutingError)) {
      throw error;
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected denial ${code}`);
}

export const ALICE = "usr_alice";
export const BOB = "usr_bob";
export const CAROL = "usr_carol";
export const ERIN = "usr_erin";
export const FRANK = "usr_frank";
export const GRACE = "usr_grace";
export const HENRY = "usr_henry";
export const ZOE = "usr_zoe";

export const TEAM_BACKEND = "team_backend";
export const TEAM_FRONTEND = "team_frontend";

/**
 * In-memory directory seam. Tests mutate `members`/`teams`/`identities`
 * directly to model membership and authority changes mid-flight.
 */
export class FakeDirectory implements RoutingDirectory {
  identities = new Map<string, string>();
  members: DirectoryMember[] = [];
  teams: DirectoryTeam[] = [];

  identify(ref: ProviderIdentityRef, userId: string): void {
    this.identities.set(`${ref.provider_instance_id} ${ref.subject}`, userId);
  }

  resolveProviderIdentity(ref: ProviderIdentityRef): string | null {
    return this.identities.get(`${ref.provider_instance_id} ${ref.subject}`) ?? null;
  }

  listMembers(_scope: RoutingScope): DirectoryMember[] {
    return this.members;
  }

  listTeams(_scope: RoutingScope): DirectoryTeam[] {
    return this.teams;
  }
}

export function member(
  user_id: string,
  role: WorkspaceRole = "member",
  status: UserStatus = "active",
): DirectoryMember {
  return { user_id, role, status };
}

export function team(team_id: string, leader_user_id: string | null): DirectoryTeam {
  return {
    team_id,
    name: team_id,
    responsibility: `${team_id} responsibility`,
    leader_user_id,
  };
}

export function identity(provider_instance_id: string, subject: string): ProviderIdentityRef {
  return { provider_instance_id, subject };
}

/** The standard roster: members alice/bob/carol, owner erin, admin frank, viewer grace, suspended henry. */
export function standardDirectory(): FakeDirectory {
  const directory = new FakeDirectory();
  directory.members = [
    member(ALICE),
    member(BOB),
    member(CAROL),
    member(ERIN, "owner"),
    member(FRANK, "admin"),
    member(GRACE, "viewer"),
    member(HENRY, "member", "suspended"),
  ];
  directory.teams = [team(TEAM_BACKEND, ALICE)];
  directory.identify(identity("github", "1"), ALICE);
  directory.identify(identity("github", "2"), BOB);
  directory.identify(identity("github", "3"), CAROL);
  directory.identify(identity("github", "9"), HENRY);
  return directory;
}

export function testPolicy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    policy_version: "2026-11-03.1",
    ownership_rules: [],
    codeowners_rules: [],
    team_rules: [],
    confidence: { min_top_weight: 5, min_margin: 2 },
    triage_roles: ["owner", "admin"],
    approval_roles: ["owner", "admin"],
    transfer: { propose_roles: ["owner", "admin", "member"], confirm_roles: ["owner", "admin"] },
    ...overrides,
  };
}

export function substantive(path: string, weight: number): AffectedFile {
  return { path, classification: "substantive", weight };
}

export function cosmeticChange(path: string, weight: number): AffectedFile {
  return { path, classification: "cosmetic", weight };
}

export function bulkChange(path: string, weight: number): AffectedFile {
  return { path, classification: "bulk", weight };
}

export function blameFact(
  path: string,
  author: ProviderIdentityRef | null,
  weight: number,
  options: { revision?: string; author_label?: string } = {},
): BlameFact {
  return {
    path,
    revision: options.revision ?? "abc123",
    author,
    author_label: options.author_label ?? "someone@example.com",
    weight,
  };
}

export function evidence(affected_files: AffectedFile[], blame: BlameFact[] = []): RouteEvidence {
  return { affected_files, blame };
}

export function mapped(service = "checkout-api"): ServiceMapping {
  return { service, status: "mapped" };
}

export function makeMachine(directory: FakeDirectory, clock?: Clock): RoutingMachine {
  return new RoutingMachine({ directory, now: (clock ?? new Clock()).now });
}
