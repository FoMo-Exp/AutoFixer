import { describe, expect, test } from "vitest";

import {
  effectiveProviderRole,
  normalizeRole,
  normalizeRoster,
} from "../src/provider-access/normalize.js";
import { NormalizationError, type RawProviderRole } from "../src/provider-access/types.js";

const ORG = "org:700";
const TEAM = "team:42";
const REPO = "github:repo:9001";
const GROUP = "group:10";
const PARENT_GROUP = "group:1";

describe("github role normalization", () => {
  test("org owner authority is normalized with the organization as authority_ref", () => {
    const entry = normalizeRole("github", {
      subject: "1001",
      login: "octo-owner",
      kind: "org_owner",
      provider_role: "owner",
      authority_ref: ORG,
    });
    expect(entry.source_kind).toBe("org_owner");
    expect(entry.authority_ref).toBe(ORG);
    expect(entry.provenance).toEqual({
      provider: "github",
      source_kind: "org_owner",
      authority_ref: ORG,
      inherited_from: null,
      provider_role: "owner",
    });
  });

  test("org-owned repository never yields a fabricated repository owner user", () => {
    // A raw record claiming repository-level owner would invent authority
    // GitHub does not model — it must be refused, not normalized.
    const raw: RawProviderRole = {
      subject: "1002",
      login: "pretender",
      kind: "direct_collaborator",
      provider_role: "owner",
      authority_ref: REPO,
    };
    expect(() => normalizeRole("github", raw)).toThrow(NormalizationError);
    expect(() => normalizeRole("github", raw)).toThrow(/no owner user/);
  });

  test("team-inherited repository permission keeps its team provenance", () => {
    const entry = normalizeRole("github", {
      subject: "1003",
      login: "team-member",
      kind: "inherited_role",
      provider_role: "write",
      authority_ref: TEAM,
      inherited_from: ORG,
    });
    expect(entry.source_kind).toBe("inherited_role");
    expect(entry.authority_ref).toBe(TEAM);
    expect(entry.inherited_from).toBe(ORG);
  });

  test("direct collaborator keeps repository provenance", () => {
    const entry = normalizeRole("github", {
      subject: "1004",
      login: "collab",
      kind: "direct_collaborator",
      provider_role: "admin",
      authority_ref: REPO,
    });
    expect(entry.source_kind).toBe("direct_collaborator");
    expect(entry.authority_ref).toBe(REPO);
  });

  test("org membership alone is explicit: it is not repository access", () => {
    const entry = normalizeRole("github", {
      subject: "1005",
      login: "plain-member",
      kind: "org_member",
      provider_role: "member",
      authority_ref: ORG,
    });
    const effective = effectiveProviderRole("github", [entry], "1005");
    // The rank sits below `read`: GitHub org membership grants nothing by
    // itself, and the normalization says so instead of inflating it.
    expect(effective?.rank).toBeLessThan(0);
  });

  test("unknown repository role vocabulary is refused", () => {
    expect(() =>
      normalizeRole("github", {
        subject: "1006",
        login: "x",
        kind: "direct_collaborator",
        provider_role: "superuser",
        authority_ref: REPO,
      }),
    ).toThrow(NormalizationError);
  });

  test("github has no group authority source distinct from orgs and teams", () => {
    expect(() =>
      normalizeRole("github", {
        subject: "1007",
        login: "x",
        kind: "group",
        provider_role: "maintainer",
        authority_ref: GROUP,
      }),
    ).toThrow(NormalizationError);
  });
});

describe("gitlab role normalization", () => {
  test("group membership keeps group provenance", () => {
    const entry = normalizeRole("gitlab", {
      subject: "2001",
      login: "gl-member",
      kind: "group",
      provider_role: "maintainer",
      authority_ref: GROUP,
    });
    expect(entry.source_kind).toBe("group");
    expect(entry.authority_ref).toBe(GROUP);
    expect(entry.inherited_from).toBeNull();
  });

  test("subgroup-inherited role records both group and parent", () => {
    const entry = normalizeRole("gitlab", {
      subject: "2002",
      login: "gl-inherited",
      kind: "inherited_role",
      provider_role: "developer",
      authority_ref: GROUP,
      inherited_from: PARENT_GROUP,
    });
    expect(entry.inherited_from).toBe(PARENT_GROUP);
  });

  test("inherited role without a parent group is refused, not guessed", () => {
    expect(() =>
      normalizeRole("gitlab", {
        subject: "2003",
        login: "x",
        kind: "inherited_role",
        provider_role: "developer",
        authority_ref: GROUP,
      }),
    ).toThrow(NormalizationError);
  });

  test("gitlab rejects github-only org sources", () => {
    expect(() =>
      normalizeRole("gitlab", {
        subject: "2004",
        login: "x",
        kind: "org_owner",
        provider_role: "owner",
        authority_ref: ORG,
      }),
    ).toThrow(NormalizationError);
  });
});

describe("provenance and effective folding", () => {
  test("one subject through several sources keeps every provenance row", () => {
    const roster = normalizeRoster("github", [
      {
        subject: "3001",
        login: "multi",
        kind: "org_owner",
        provider_role: "owner",
        authority_ref: ORG,
      },
      {
        subject: "3001",
        login: "multi",
        kind: "direct_collaborator",
        provider_role: "read",
        authority_ref: REPO,
      },
    ]);
    expect(roster).toHaveLength(2);
    const effective = effectiveProviderRole("github", roster, "3001");
    expect(effective?.provider_role).toBe("owner");
    expect(effective?.sources).toHaveLength(2);
  });

  test("effective role ranks by provider vocabulary, highest source wins", () => {
    const roster = normalizeRoster("github", [
      {
        subject: "3002",
        login: "mixed",
        kind: "direct_collaborator",
        provider_role: "triage",
        authority_ref: REPO,
      },
      {
        subject: "3002",
        login: "mixed",
        kind: "inherited_role",
        provider_role: "maintain",
        authority_ref: TEAM,
        inherited_from: ORG,
      },
    ]);
    expect(effectiveProviderRole("github", roster, "3002")?.provider_role).toBe("maintain");
    expect(effectiveProviderRole("github", roster, "nobody")).toBeNull();
  });
});
