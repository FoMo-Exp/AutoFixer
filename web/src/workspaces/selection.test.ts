import { describe, expect, it } from "vitest";
import type { Workspace } from "../api/identity";
import {
  clearStoredWorkspaceId,
  readStoredWorkspaceId,
  resolveWorkspace,
  storeWorkspaceId,
  workspaceStorageKey,
} from "./selection";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function workspace(id: string): Workspace {
  return {
    id,
    enterprise_id: "ent_1",
    name: id,
    status: "active",
    repository: {
      repository_id: `github:Luthiel/${id}`,
      provider_instance_id: "pi_1",
      provider_type: "github",
    },
    role: "member",
    version: 1,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

describe("workspace selection storage", () => {
  it("stores the locator per user and never a credential", () => {
    const storage = memoryStorage();
    storeWorkspaceId(storage, "usr_1", "wsp_a");
    expect(storage.getItem(workspaceStorageKey("usr_1"))).toBe("wsp_a");
    expect(readStoredWorkspaceId(storage, "usr_2")).toBeUndefined();
    clearStoredWorkspaceId(storage, "usr_1");
    expect(readStoredWorkspaceId(storage, "usr_1")).toBeUndefined();
  });

  it("treats unavailable storage as no stored selection", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredWorkspaceId(broken, "usr_1")).toBeUndefined();
    expect(() => storeWorkspaceId(broken, "usr_1", "wsp_a")).not.toThrow();
    expect(() => clearStoredWorkspaceId(broken, "usr_1")).not.toThrow();
  });
});

describe("resolveWorkspace", () => {
  it("restores a stored workspace that is still accessible", () => {
    const [a, b] = [workspace("wsp_a"), workspace("wsp_b")];
    expect(resolveWorkspace([a, b], "wsp_b")?.id).toBe("wsp_b");
  });

  it("drops a revoked stored workspace instead of resurrecting it", () => {
    expect(resolveWorkspace([workspace("wsp_b")], "wsp_a")?.id).toBe("wsp_b");
    expect(resolveWorkspace([workspace("wsp_b"), workspace("wsp_c")], "wsp_a")).toBeUndefined();
  });

  it("defaults only when exactly one workspace is accessible", () => {
    expect(resolveWorkspace([workspace("wsp_a")], undefined)?.id).toBe("wsp_a");
    expect(resolveWorkspace([], undefined)).toBeUndefined();
    expect(resolveWorkspace([workspace("wsp_a"), workspace("wsp_b")], undefined)).toBeUndefined();
  });
});
