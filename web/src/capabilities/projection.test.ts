import { describe, expect, it } from "vitest";
import verified from "../../../docs/fixtures/capability-api-v1/projection-verified.json";
import unverified from "../../../docs/fixtures/capability-api-v1/projection-unverified.json";
import downgraded from "../../../docs/fixtures/capability-api-v1/projection-downgraded.json";
import {
  CapabilityProjectionError,
  CAPABILITY_MODULES,
  actionAllowed,
  capabilityReasonLabel,
  moduleEnterable,
  moduleHasData,
  moduleVisible,
  parseWorkspaceCapabilities,
} from "./projection";

const NOW = Date.parse("2026-11-22T12:10:00.000Z");

function parse(raw: unknown = verified, workspaceId = "ws_payments") {
  return parseWorkspaceCapabilities(raw, { workspaceId, now: NOW });
}

describe("workspace capability projection", () => {
  it("normalizes the merged capture into the eight closed modules", () => {
    const snapshot = parse();
    expect(snapshot.trusted).toBe(true);
    expect(snapshot.dataBlocked).toBe(false);
    expect(snapshot.assignedRole).toBe("member");
    expect(Object.keys(snapshot.modules).sort()).toEqual([...CAPABILITY_MODULES].sort());
    expect(snapshot.modules.tasks.dataCeiling).toBe("repository");
    expect(snapshot.modules.memory.dataCeiling).toBe("internal");
    expect(snapshot.modules.dashboard.dataCeiling).toBe("operational");
    expect(snapshot.modules.security.visible).toBe(false);
    expect(snapshot.modules.security.reason).toBe("security_duty");
    expect(moduleVisible(snapshot, "tasks")).toBe(true);
    expect(moduleEnterable(snapshot, "tasks")).toBe(true);
    expect(moduleHasData(snapshot, "tasks")).toBe(true);
    expect(actionAllowed(snapshot, "tasks", "create")).toBe(true);
    expect(actionAllowed(snapshot, "tasks", "approve")).toBe(false);
  });

  it("keeps an unverified projection visible but withholds every data action", () => {
    const forged = structuredClone(unverified) as typeof unverified & {
      modules: Record<string, { actions: Record<string, unknown> }>;
    };
    // A malformed server cannot grant data on an unverified snapshot.
    forged.modules.tasks.actions.view = {
      allowed: true,
      required: "code_read",
      reason: "capability_unverified",
    };
    const snapshot = parse(forged);
    expect(snapshot.state).toBe("unverified");
    expect(snapshot.dataBlocked).toBe(true);
    expect(snapshot.trusted).toBe(true);
    expect(snapshot.modules.tasks.visible).toBe(true);
    expect(snapshot.modules.tasks.dataCeiling).toBe("none");
    expect(actionAllowed(snapshot, "tasks", "view")).toBe(false);
    expect(actionAllowed(snapshot, "tasks", "create")).toBe(false);
    expect(moduleHasData(snapshot, "tasks")).toBe(false);
  });

  it("keeps a repository downgrade read-only while the module stays visible", () => {
    const snapshot = parse(downgraded);
    expect(snapshot.state).toBe("verified");
    expect(snapshot.capabilities).toEqual(["code_read"]);
    expect(moduleVisible(snapshot, "tasks")).toBe(true);
    expect(actionAllowed(snapshot, "tasks", "view")).toBe(true);
    expect(actionAllowed(snapshot, "tasks", "create")).toBe(false);
    expect(actionAllowed(snapshot, "tasks", "manage")).toBe(false);
    expect(actionAllowed(snapshot, "tasks", "approve")).toBe(false);
    expect(actionAllowed(snapshot, "issues", "create")).toBe(false);
  });

  it("rejects an expired snapshot instead of treating it as a grant", () => {
    const snapshot = parseWorkspaceCapabilities(verified, {
      workspaceId: "ws_payments",
      now: Date.parse("2026-11-22T13:00:00.000Z"),
    });
    expect(snapshot.trusted).toBe(false);
    for (const module of CAPABILITY_MODULES) {
      expect(moduleVisible(snapshot, module)).toBe(false);
      expect(actionAllowed(snapshot, module, "view")).toBe(false);
    }
  });

  it("rejects a wrong schema version, a foreign workspace, and unparseable freshness", () => {
    expect(() =>
      parseWorkspaceCapabilities(
        { ...verified, schema_version: "workspace-capability-v1" },
        {
          workspaceId: "ws_payments",
          now: NOW,
        },
      ),
    ).toThrow(CapabilityProjectionError);
    expect(() => parse(verified, "ws_other")).toThrow(CapabilityProjectionError);
    expect(() =>
      parseWorkspaceCapabilities(
        { ...verified, freshness: { state: "fresh", checked_at: "nope" } },
        { workspaceId: "ws_payments", now: NOW },
      ),
    ).toThrow(CapabilityProjectionError);
  });

  it("fails closed on unknown modules, actions and ceilings", () => {
    const raw = structuredClone(verified) as unknown as {
      modules: Record<string, unknown>;
    };
    delete raw.modules.rsi;
    raw.modules.tasks = {
      visible: true,
      data_ceiling: "cosmic",
      reason: null,
      actions: { view: { allowed: true, required: "code_read" }, invented: { allowed: true } },
    };
    const snapshot = parse(raw);
    expect(snapshot.modules.rsi.visible).toBe(false);
    expect(snapshot.modules.rsi.dataCeiling).toBe("none");
    expect(actionAllowed(snapshot, "rsi", "view")).toBe(false);
    expect(snapshot.modules.tasks.dataCeiling).toBe("none");
    expect(moduleEnterable(snapshot, "tasks")).toBe(true);
    expect(moduleHasData(snapshot, "tasks")).toBe(false);
    expect(actionAllowed(snapshot, "tasks", "invented")).toBe(false);
    expect(actionAllowed(snapshot, "tasks", "stream")).toBe(false);
  });

  it("explains the safe denial reasons without exposing policy internals", () => {
    expect(capabilityReasonLabel("workspace_role:member")).toContain("member role");
    expect(capabilityReasonLabel("security_duty")).toContain("security duty");
    expect(capabilityReasonLabel("enterprise_admin")).toContain("enterprise");
    expect(capabilityReasonLabel("capability_unverified")).toContain("could not be verified");
  });
});
