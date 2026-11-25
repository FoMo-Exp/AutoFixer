import { describe, expect, it } from "vitest";
import { enterpriseProjection } from "./test-enterprise-projection";
import {
  EnterpriseProjectionError,
  enterpriseActionAllowed,
  enterpriseModuleHasData,
  enterpriseModuleVisible,
  parseEnterpriseCapabilities,
} from "./enterprise";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");

describe("enterprise capability projection", () => {
  it("parses the merged capture and exposes only the directory actions it grants", () => {
    const snapshot = parseEnterpriseCapabilities(enterpriseProjection({ now: NOW }), {
      enterpriseId: "ent_acme",
      now: NOW,
    });
    expect(snapshot.trusted).toBe(true);
    expect(enterpriseModuleVisible(snapshot, "enterprise_directory")).toBe(true);
    expect(enterpriseModuleHasData(snapshot, "enterprise_directory", "view")).toBe(true);
    expect(enterpriseActionAllowed(snapshot, "enterprise_directory", "add_user")).toBe(true);
    expect(enterpriseActionAllowed(snapshot, "enterprise_directory", "change_role")).toBe(true);
    expect(enterpriseActionAllowed(snapshot, "workspace_data", "view_tasks")).toBe(false);
  });

  it("denies every action but keeps the entry when an administrator action is not granted", () => {
    const snapshot = parseEnterpriseCapabilities(
      enterpriseProjection({ now: NOW, deny: ["add_user"] }),
      { enterpriseId: "ent_acme", now: NOW },
    );
    expect(enterpriseActionAllowed(snapshot, "enterprise_directory", "view")).toBe(true);
    expect(enterpriseActionAllowed(snapshot, "enterprise_directory", "add_user")).toBe(false);
  });

  it("rejects a foreign enterprise and an unknown schema", () => {
    expect(() =>
      parseEnterpriseCapabilities(enterpriseProjection({ now: NOW }), {
        enterpriseId: "ent_other",
        now: NOW,
      }),
    ).toThrow(EnterpriseProjectionError);
    const raw = {
      ...enterpriseProjection({ now: NOW }),
      schema_version: "enterprise-capability-v2",
    };
    expect(() => parseEnterpriseCapabilities(raw, { enterpriseId: "ent_acme", now: NOW })).toThrow(
      EnterpriseProjectionError,
    );
  });

  it("fails closed when the window expired or the member is not an administrator", () => {
    const expired = parseEnterpriseCapabilities(
      enterpriseProjection({ now: NOW - 60 * 60 * 1000 }),
      { enterpriseId: "ent_acme", now: NOW },
    );
    expect(expired.trusted).toBe(false);
    expect(enterpriseModuleVisible(expired, "enterprise_directory")).toBe(false);
    expect(enterpriseActionAllowed(expired, "enterprise_directory", "view")).toBe(false);

    const member = parseEnterpriseCapabilities(enterpriseProjection({ now: NOW, role: "member" }), {
      enterpriseId: "ent_acme",
      now: NOW,
    });
    expect(member.trusted).toBe(false);
    expect(enterpriseActionAllowed(member, "enterprise_directory", "view")).toBe(false);
  });

  it("fails closed on an unparseable freshness window", () => {
    const raw = enterpriseProjection({ now: NOW });
    const broken = {
      ...raw,
      freshness: { ...raw.freshness, expires_at: "not-a-date" },
    };
    expect(() =>
      parseEnterpriseCapabilities(broken, { enterpriseId: "ent_acme", now: NOW }),
    ).toThrow(EnterpriseProjectionError);
  });
});
