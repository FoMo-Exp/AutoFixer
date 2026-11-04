import { describe, expect, test } from "vitest";

import { collectRoster, fetchEffectivePermission } from "../src/provider-access/adapter.js";
import {
  IncompleteRosterError,
  MissingPermissionError,
  type ProviderCallContext,
  type RepositoryRef,
} from "../src/provider-access/types.js";
import { page, role, scriptedAdapter } from "./helpers/provider-access.js";

const CTX: ProviderCallContext = {
  enterprise_id: "ent_1",
  workspace_id: "ws_1",
  integration_id: "sint_1",
};
const REPO: RepositoryRef = {
  repository_id: "github:repo:9001",
  repository_name: "Luthiel/AutoFixer",
  provider_type: "github",
};

describe("roster collection completeness", () => {
  test("collects every page of a complete roster", async () => {
    const adapter = scriptedAdapter({
      pages: [
        page([role("1", "direct_collaborator", "write", "github:repo:9001")], {
          next_cursor: "1",
          has_more: true,
        }),
        page([role("2", "inherited_role", "read", "team:42")], {
          next_cursor: null,
          has_more: false,
        }),
      ],
    });
    const roster = await collectRoster(adapter, CTX, REPO);
    expect(roster.entries.map((entry) => entry.subject)).toEqual(["1", "2"]);
    expect(roster.pages_fetched).toBe(2);
    expect(roster.completed).toBe(true);
  });

  test("missing effective-permission visibility is an error, not an empty roster", async () => {
    const adapter = scriptedAdapter({ visibility: "none", pages: [page([])] });
    await expect(collectRoster(adapter, CTX, REPO)).rejects.toBeInstanceOf(MissingPermissionError);
    // The adapter is never consulted: a roster from it could not be complete.
    expect(adapter.fetchCount).toBe(0);
  });

  test("a service credential without the required token scope is an error", async () => {
    const adapter = scriptedAdapter({ required_token_scope: ["repo:read", "read:org"] });
    await expect(
      collectRoster(adapter, CTX, REPO, { available_token_scope: ["repo:read"] }),
    ).rejects.toBeInstanceOf(MissingPermissionError);
  });

  test("a truncated page is an error, never a shortened roster", async () => {
    const adapter = scriptedAdapter({
      pages: [
        page([role("1", "direct_collaborator", "write", "github:repo:9001")], { truncated: true }),
      ],
    });
    await expect(collectRoster(adapter, CTX, REPO)).rejects.toMatchObject({
      code: "PROVIDER_ROSTER_INCOMPLETE",
      reason: "truncated",
    });
  });

  test("more data with no continuation cursor is incomplete", async () => {
    const adapter = scriptedAdapter({
      pages: [
        page([role("1", "direct_collaborator", "write", "github:repo:9001")], {
          has_more: true,
          next_cursor: null,
        }),
      ],
    });
    await expect(collectRoster(adapter, CTX, REPO)).rejects.toMatchObject({
      reason: "missing_cursor",
    });
  });

  test("pagination past the declared page limit is incomplete", async () => {
    const adapter = scriptedAdapter({
      pages_max: 2,
      pages: [
        page([role("1", "direct_collaborator", "write", "github:repo:9001")], {
          has_more: true,
          next_cursor: "1",
        }),
        page([role("2", "direct_collaborator", "read", "github:repo:9001")], {
          has_more: true,
          next_cursor: "2",
        }),
        page([role("3", "direct_collaborator", "read", "github:repo:9001")]),
      ],
    });
    await expect(collectRoster(adapter, CTX, REPO)).rejects.toMatchObject({
      reason: "pagination_limit",
    });
    expect(adapter.fetchCount).toBe(2);
  });

  test("a rate limit exhausted before completion is incomplete", async () => {
    const adapter = scriptedAdapter({
      pages: [
        page([role("1", "direct_collaborator", "write", "github:repo:9001")], {
          has_more: true,
          next_cursor: "1",
          rate_limit: { remaining: 0, reset_at: "2026-11-03T12:05:00Z" },
        }),
      ],
    });
    await expect(collectRoster(adapter, CTX, REPO)).rejects.toMatchObject({
      reason: "rate_limited",
    });
  });

  test("an empty page while the provider claims more data is incomplete", async () => {
    const adapter = scriptedAdapter({
      pages: [page([], { has_more: true, next_cursor: "1" })],
    });
    await expect(collectRoster(adapter, CTX, REPO)).rejects.toMatchObject({ reason: "empty_page" });
  });

  test("an incomplete fetch never yields partial data to the caller", async () => {
    const adapter = scriptedAdapter({
      pages: [
        page([role("1", "direct_collaborator", "write", "github:repo:9001")], {
          has_more: true,
          next_cursor: "1",
        }),
        page([role("2", "direct_collaborator", "read", "github:repo:9001")], { truncated: true }),
      ],
    });
    const result = collectRoster(adapter, CTX, REPO);
    await expect(result).rejects.toBeInstanceOf(IncompleteRosterError);
    // The first page's entries are discarded with the failed collection:
    // absence from an incomplete fetch is never treated as removal.
    await expect(result).rejects.toMatchObject({ code: "PROVIDER_ROSTER_INCOMPLETE" });
  });
});

describe("effective permission queries", () => {
  test("provider 'no access' is null; 'cannot tell' is an error", async () => {
    const adapter = scriptedAdapter({
      effective: {
        "1": null,
        "2": role("2", "direct_collaborator", "write", "github:repo:9001"),
      },
    });
    await expect(fetchEffectivePermission(adapter, CTX, REPO, "1")).resolves.toBeNull();
    const found = await fetchEffectivePermission(adapter, CTX, REPO, "2");
    expect(found?.provider_role).toBe("write");

    const blind = scriptedAdapter({ denyPermissionQuery: true });
    await expect(fetchEffectivePermission(blind, CTX, REPO, "1")).rejects.toBeInstanceOf(
      MissingPermissionError,
    );
  });
});
