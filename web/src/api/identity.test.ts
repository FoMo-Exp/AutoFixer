import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ApiError } from "./client";
import type { JsonFetch } from "./client";
import type { components } from "./contracts/schema";
import { IdentityClient } from "./identity";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(
  fetchImpl: Mock,
  options: { token?: string; csrfToken?: string } = {},
): IdentityClient {
  const csrfToken = options.csrfToken;
  return new IdentityClient({
    baseUrl: "http://127.0.0.1:4567/",
    token: options.token ?? "",
    ...(csrfToken === undefined ? {} : { csrfToken: () => csrfToken }),
    fetchImpl: fetchImpl as unknown as JsonFetch,
  });
}

const memberPage = fixture<components["schemas"]["Membership"]>("membership.json");

describe("IdentityClient", () => {
  it("lists workspace members with the opaque cursor and schema shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(fixture("membership-page.json")));
    const page = await client(fetchImpl, { token: "local-secret" }).listWorkspaceMembers(
      "ws_01J8Z1C3D4",
      "cur_02",
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_01J8Z1C3D4/members?cursor=cur_02",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer local-secret" }),
      }),
    );
    expect(page.items.map((item) => item.id)).toEqual(["mem_01J8Z6E5F6", "mem_01J8Z7J8K9"]);
    expect(page.next_cursor).toBeNull();
  });

  it("changes a role with the membership's optimistic version", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(memberPage));
    await client(fetchImpl).updateWorkspaceMember("ws_1", "mem_1", {
      role: "admin",
      version: 4,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4567/api/v1/workspaces/ws_1/members/mem_1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ role: "admin", version: 4 });
  });

  it("echoes the CSRF token only on cookie-authenticated writes", async () => {
    const cookieFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await client(cookieFetch, { csrfToken: "csrf_9f2c" }).revokeInvitation("ws_1", "inv_1");

    const bearerFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await client(bearerFetch, { token: "local-secret", csrfToken: "csrf_9f2c" }).revokeInvitation(
      "ws_1",
      "inv_1",
    );

    expect(
      (cookieFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ "X-CSRF-Token": "csrf_9f2c" });
    expect(
      (bearerFetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>,
    ).not.toHaveProperty("X-CSRF-Token");
  });

  it("creates an invitation and returns the only copy of the bearer token", async () => {
    const created = fixture<components["schemas"]["CreatedInvitation"]>("invitation-created.json");
    const fetchImpl = vi.fn().mockResolvedValue(json(created, 201));

    const result = await client(fetchImpl).createInvitation("ws_1", { expires_in_seconds: 3600 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4567/api/v1/workspaces/ws_1/invitations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ expires_in_seconds: 3600 });
    expect(result.token).toBe(created.token);
    expect(result.invite_url).toContain(`#${created.token}`);
  });

  it("lists invitations without any token field", async () => {
    const listed = {
      items: [
        fixture<components["schemas"]["CreatedInvitation"]>("invitation-created.json").invitation,
      ],
      next_cursor: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(json(listed));

    const page = await client(fetchImpl).listInvitations("ws_1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4567/api/v1/workspaces/ws_1/invitations");
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(page)).not.toContain("2ZxQ7mK9pR4tW8vY1uB6cD3eF5gH0jL");
    expect(page.items[0]).not.toHaveProperty("token");
  });

  it("previews and redeems only through authenticated POST bodies", async () => {
    const preview = fixture<components["schemas"]["InvitationPreview"]>("invitation-preview.json");
    const redemption =
      fixture<components["schemas"]["InvitationRedemption"]>("invitation-redeem.json");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json(redemption));
    const api = client(fetchImpl, { token: "local-secret" });
    const token = "inv_2ZxQ7mK9pR4tW8vY1uB6cD3eF5gH0jL";

    expect(await api.previewInvitation(token)).toEqual(preview);
    expect(await api.redeemInvitation(token)).toEqual(redemption);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4567/api/v1/invitations/preview");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:4567/api/v1/invitations/redeem");
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ token });
      expect(String(call[0])).not.toContain(token);
    }
  });

  it("revokes with DELETE and treats 204 as success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client(fetchImpl).revokeInvitation("ws_1", "inv_1")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4567/api/v1/workspaces/ws_1/invitations/inv_1",
      expect.objectContaining({ method: "DELETE", redirect: "error" }),
    );
  });

  it("surfaces the non-enumerating invitation denial with its case reference", async () => {
    const denied = fixture<components["schemas"]["Error"]>("error-invitation-not-accepted.json");
    const fetchImpl = vi.fn().mockResolvedValue(json(denied, 403));

    const error = await client(fetchImpl)
      .redeemInvitation("inv_denied")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe("INVITATION_NOT_ACCEPTED");
    expect(apiError.status).toBe(403);
    expect(apiError.requestId).toBe("req_01J8Z0G7H8I9");
    expect(apiError.retryable).toBe(false);
  });

  it("requests the enterprise auth audit with a bounded limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ items: [] }));
    await client(fetchImpl).listAuthAudit("ent_1", 25);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4567/api/v1/admin/enterprises/ent_1/auth-audit?limit=25",
    );
  });

  it("builds the sign-in URL on the configured API origin, not the page origin", () => {
    const api = client(vi.fn());
    expect(api.loginUrl("pi_github_main")).toBe(
      "http://127.0.0.1:4567/api/v1/auth/login?provider_instance_id=pi_github_main&return_to=%2F",
    );
    // return_to stays a relative same-deployment path.
    expect(api.loginUrl("pi_github_main", "https://evil.example/steal")).toContain("return_to=%2F");
  });
});
