// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ApiError } from "../api/client";
import type { components } from "../api/contracts/schema";
import type { CreatedInvitation, IdentityClient, SessionInfo } from "../api/identity";
import { InviteJoin } from "./InviteJoin";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const session = fixture<SessionInfo>("session.json");
const preview = fixture<components["schemas"]["InvitationPreview"]>("invitation-preview.json");
const redemption = fixture<components["schemas"]["InvitationRedemption"]>("invitation-redeem.json");
const created = fixture<CreatedInvitation>("invitation-created.json");

interface JoinClient {
  getSession: Mock;
  listLoginProviders: Mock;
  previewInvitation: Mock;
  redeemInvitation: Mock;
}

function fakeClient(): JoinClient {
  return {
    getSession: vi.fn().mockResolvedValue(session),
    listLoginProviders: vi.fn().mockResolvedValue([]),
    previewInvitation: vi.fn().mockResolvedValue(preview),
    redeemInvitation: vi.fn().mockResolvedValue(redemption),
  };
}

function renderJoin(token = created.token, client: JoinClient = fakeClient()) {
  render(
    <InviteJoin
      client={client as unknown as IdentityClient}
      token={token}
      onDismiss={() => undefined}
    />,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InviteJoin", () => {
  it("requires a session before previewing and never redeems without explicit confirmation", async () => {
    const client = renderJoin();

    await waitFor(() => expect(client.previewInvitation).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Acme Payments")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join workspace" })).toBeTruthy();
    expect(client.redeemInvitation).not.toHaveBeenCalled();
  });

  it("stops at the sign-in gate for an unauthenticated visitor", async () => {
    const client = fakeClient();
    client.getSession.mockRejectedValue(
      new ApiError(401, fixture("error-unauthenticated.json"), "Unauthorized"),
    );
    renderJoin(created.token, client);

    expect(await screen.findByText(/Sign in/)).toBeTruthy();
    expect(client.previewInvitation).not.toHaveBeenCalled();
    expect(client.redeemInvitation).not.toHaveBeenCalled();
  });

  it("joins only after the explicit confirmation and shows the membership role", async () => {
    const client = renderJoin();
    await screen.findByRole("button", { name: "Join workspace" });

    await userEvent.click(screen.getByRole("button", { name: "Join workspace" }));

    expect(await screen.findByText("Joined as member")).toBeTruthy();
    expect(client.redeemInvitation).toHaveBeenCalledWith(created.token);
    expect(document.body.innerHTML).not.toContain(created.token);
  });

  it("renders the single non-enumerating denial and allows a fresh preview", async () => {
    const client = fakeClient();
    client.previewInvitation
      .mockRejectedValueOnce(
        new ApiError(403, fixture("error-invitation-not-accepted.json"), "Denied"),
      )
      .mockResolvedValueOnce(preview);
    renderJoin(created.token, client);

    expect(
      await screen.findByText(
        "This invitation cannot be used. Ask the workspace owner for a new invitation.",
      ),
    ).toBeTruthy();
    expect(client.redeemInvitation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Acme Payments")).toBeTruthy();
    expect(client.previewInvitation).toHaveBeenCalledTimes(2);
  });

  it("surfaces the retry window when rate limited", async () => {
    const client = fakeClient();
    client.previewInvitation.mockRejectedValue(
      new ApiError(429, fixture("error-rate-limited.json"), "Limited"),
    );
    renderJoin(created.token, client);

    expect(
      await screen.findByText(/Too many attempts\. Try again later\. Retry in 30s\./),
    ).toBeTruthy();
  });

  it("replays an already-joined invitation instead of offering a second join", async () => {
    const client = fakeClient();
    client.previewInvitation.mockResolvedValue({ ...preview, already_joined: true });
    renderJoin(created.token, client);

    expect(await screen.findByText("Already joined")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });
});
