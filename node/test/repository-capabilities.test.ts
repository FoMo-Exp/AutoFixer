/**
 * Provider role → repository capability policy (DAT-276, ADR-0011).
 *
 * These are the pure rules the ceiling layer relies on. The point of almost
 * every test here is that a provider role *name* never implies authority:
 * unsupported vocabularies fail closed, a single repository's stronger role
 * cannot compensate for another repository's missing capability, and
 * organization membership alone proves no repository access.
 */

import { describe, expect, test } from "vitest";

import {
  grantSupportedByCeiling,
  intersectRepositoryCapabilities,
  normalizeCapabilitySet,
  providerRoleCapabilities,
  requiredCapabilityForAction,
} from "../src/provider-access/repository-capabilities.js";

describe("provider role capability policy", () => {
  test("GitHub repository roles map conservatively", () => {
    expect(providerRoleCapabilities("github", "direct_collaborator", "read")).toEqual({
      supported: true,
      capabilities: ["code_read"],
      reason: "supported",
    });
    expect(
      providerRoleCapabilities("github", "direct_collaborator", "triage").capabilities,
    ).toEqual(["code_read", "issue_write"]);
    expect(providerRoleCapabilities("github", "direct_collaborator", "write").capabilities).toEqual(
      ["code_read", "issue_write", "repository_write"],
    );
    // `maintain` proves write but NOT management: workspace administration
    // requires administrator-level repository authority.
    expect(
      providerRoleCapabilities("github", "inherited_role", "maintain").capabilities,
    ).not.toContain("repository_manage");
    expect(providerRoleCapabilities("github", "direct_collaborator", "admin").capabilities).toEqual(
      ["code_read", "issue_write", "repository_write", "repository_manage"],
    );
  });

  test("GitLab access levels map conservatively", () => {
    expect(providerRoleCapabilities("gitlab", "group", "reporter").capabilities).toEqual([
      "code_read",
    ]);
    expect(providerRoleCapabilities("gitlab", "group", "developer").capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
    ]);
    expect(providerRoleCapabilities("gitlab", "group", "maintainer").capabilities).not.toContain(
      "repository_manage",
    );
    expect(providerRoleCapabilities("gitlab", "group", "owner").capabilities).toContain(
      "repository_manage",
    );
    // `guest` is a real provider fact that proves nothing: it is supported but
    // carries no capability, so it cannot establish admission.
    expect(providerRoleCapabilities("gitlab", "direct_collaborator", "guest")).toEqual({
      supported: true,
      capabilities: [],
      reason: "supported",
    });
  });

  test("organization membership alone proves no repository access", () => {
    expect(providerRoleCapabilities("github", "org_member", "member")).toEqual({
      supported: true,
      capabilities: [],
      reason: "organization_membership_only",
    });
    // GitHub org ownership is a provider fact about the organization.
    expect(providerRoleCapabilities("github", "org_owner", "owner").capabilities).toEqual([
      "code_read",
      "issue_write",
      "repository_write",
      "repository_manage",
    ]);
    // A contradictory row (org kind with a repository role) fails closed.
    expect(providerRoleCapabilities("github", "org_owner", "read").supported).toBe(false);
    expect(providerRoleCapabilities("github", "org_member", "write").capabilities).toEqual([]);
  });

  test("unknown, custom and cross-provider roles fail closed", () => {
    expect(providerRoleCapabilities("github", "direct_collaborator", "owner")).toEqual({
      supported: false,
      capabilities: [],
      reason: "unsupported_role",
    });
    expect(providerRoleCapabilities("github", "direct_collaborator", "maintainer")).toEqual({
      supported: false,
      capabilities: [],
      reason: "unsupported_role",
    });
    expect(providerRoleCapabilities("gitlab", "group", "planner")).toEqual({
      supported: false,
      capabilities: [],
      reason: "unsupported_role",
    });
    expect(providerRoleCapabilities("gitlab", "org_owner", "owner").supported).toBe(false);
    expect(providerRoleCapabilities("github", "group", "write").supported).toBe(false);
  });
});

describe("capability intersection", () => {
  test("write on A and read on B yields read only", () => {
    expect(
      intersectRepositoryCapabilities([
        ["code_read", "issue_write", "repository_write"],
        ["code_read"],
      ]),
    ).toEqual(["code_read"]);
  });

  test("a stronger role on one repository never compensates for another", () => {
    expect(
      intersectRepositoryCapabilities([
        ["code_read", "issue_write", "repository_write", "repository_manage"],
        ["code_read"],
      ]),
    ).toEqual(["code_read"]);
    expect(
      intersectRepositoryCapabilities([["code_read", "issue_write", "repository_write"], []]),
    ).toEqual([]);
  });

  test("an empty repository set proves nothing", () => {
    expect(intersectRepositoryCapabilities([])).toEqual([]);
  });

  test("capability sets are canonical and deduplicated", () => {
    expect(normalizeCapabilitySet(["repository_write", "code_read", "code_read"])).toEqual([
      "code_read",
      "repository_write",
    ]);
  });

  test("every action maps to a capability, and management is its own capability", () => {
    expect(requiredCapabilityForAction("read")).toBe("code_read");
    expect(requiredCapabilityForAction("stream")).toBe("code_read");
    expect(requiredCapabilityForAction("artifact_read")).toBe("code_read");
    expect(requiredCapabilityForAction("issue_sync")).toBe("issue_write");
    expect(requiredCapabilityForAction("write")).toBe("repository_write");
    expect(requiredCapabilityForAction("delivery")).toBe("repository_write");
    expect(requiredCapabilityForAction("approval")).toBe("repository_write");
    expect(requiredCapabilityForAction("manage")).toBe("repository_manage");
  });

  test("grants are only supported by the capability they depend on", () => {
    expect(grantSupportedByCeiling("checkout_read", ["code_read"])).toBe(true);
    expect(grantSupportedByCeiling("checkout_read", [])).toBe(false);
    expect(grantSupportedByCeiling("delivery_write", ["code_read"])).toBe(false);
    expect(grantSupportedByCeiling("delivery_write", ["code_read", "repository_write"])).toBe(true);
  });
});
