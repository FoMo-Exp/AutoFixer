import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import type { components } from "../api/contracts/schema";
import type { Membership, SessionInfo, Workspace } from "../api/identity";
import {
  MAX_INVITE_EXPIRY_SECONDS,
  authoritySummary,
  canManageWorkspace,
  describeError,
  isEnterpriseAdmin,
  isUnauthenticated,
  parseInviteExpiry,
} from "./identity-format";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const workspace = fixture<Workspace>("workspace.json");
const session = fixture<SessionInfo>("session.json");
const membership = fixture<Membership>("membership.json");

function errorPayload(
  code: string,
  overrides: Partial<components["schemas"]["Error"]["error"]> = {},
) {
  return {
    error: {
      envelope_version: 1,
      code,
      stage: "authorization",
      category: "denial",
      message: "Server message for " + code,
      retryable: false,
      retry_after_seconds: null,
      request_id: "req_case_1",
      details: {},
      next_action: null,
      ...overrides,
    },
  } as components["schemas"]["Error"];
}

describe("workspace authority", () => {
  it("shows administrative controls only for manager roles", () => {
    expect(canManageWorkspace(workspace, session)).toBe(true);
    expect(canManageWorkspace({ ...workspace, role: "member" }, session)).toBe(true);
    const memberSession: SessionInfo = { ...session, enterprise_roles: [] };
    expect(canManageWorkspace({ ...workspace, role: "member" }, memberSession)).toBe(false);
    expect(canManageWorkspace({ ...workspace, role: "viewer" }, memberSession)).toBe(false);
    expect(canManageWorkspace(undefined, session)).toBe(false);
  });

  it("recognizes enterprise administration by enterprise id", () => {
    expect(isEnterpriseAdmin(session, workspace.enterprise_id)).toBe(true);
    expect(isEnterpriseAdmin(session, "ent_other")).toBe(false);
    expect(isEnterpriseAdmin(undefined, workspace.enterprise_id)).toBe(false);
  });

  it("fails closed when provider authority is missing", () => {
    expect(authoritySummary({ ...membership, authority: undefined })).toBe(
      "No provider authority recorded",
    );
    expect(authoritySummary(membership)).toContain("Inherited role");
  });
});

describe("invitation expiry", () => {
  it("accepts only the contract's shorten-only range", () => {
    expect(parseInviteExpiry("1")).toBe(1);
    expect(parseInviteExpiry(String(MAX_INVITE_EXPIRY_SECONDS))).toBe(MAX_INVITE_EXPIRY_SECONDS);
    expect(parseInviteExpiry("0")).toBeUndefined();
    expect(parseInviteExpiry(String(MAX_INVITE_EXPIRY_SECONDS + 1))).toBeUndefined();
    expect(parseInviteExpiry("1.5")).toBeUndefined();
    expect(parseInviteExpiry("forever")).toBeUndefined();
  });
});

describe("error guidance", () => {
  it("keeps the non-enumerating invitation copy and its case reference", () => {
    const denied = fixture<components["schemas"]["Error"]>("error-invitation-not-accepted.json");
    const described = describeError(new ApiError(403, denied, "fallback"));

    expect(described).toEqual({
      message: "This invitation cannot be used. Ask the workspace owner for a new invitation.",
      code: "INVITATION_NOT_ACCEPTED",
      requestId: "req_01J8Z0G7H8I9",
    });
  });

  it("surfaces the server's retry window for rate limiting", () => {
    const limited = fixture<components["schemas"]["Error"]>("error-rate-limited.json");
    expect(describeError(new ApiError(429, limited, "fallback"))).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 30,
    });
  });

  it("maps local authority denials and falls back to the envelope message for unknown codes", () => {
    expect(describeError(new ApiError(403, errorPayload("ROLE_NOT_ASSIGNABLE"), "x")).message).toBe(
      "You cannot assign a role above your own authority.",
    );
    expect(
      describeError(new ApiError(422, errorPayload("TEAM_LEADER_NOT_MEMBER"), "x")).message,
    ).toBe("A team leader must be an active workspace member.");
    expect(describeError(new ApiError(400, errorPayload("FUTURE_CODE"), "x")).message).toBe(
      "Server message for FUTURE_CODE",
    );
  });

  it("recognizes the uniform 401 and network failures", () => {
    const unauth = fixture<components["schemas"]["Error"]>("error-unauthenticated.json");
    expect(isUnauthenticated(new ApiError(401, unauth, "x"))).toBe(true);
    expect(isUnauthenticated(new TypeError("Failed to fetch"))).toBe(false);
    expect(describeError(new TypeError("Failed to fetch"))).toMatchObject({
      message: "Failed to fetch",
      code: "REQUEST_FAILED",
    });
  });
});
