// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityClient, WorkspaceSession } from "../api/identity";
import { NoWorkspaceScreen } from "./LoginScreen";

const adminSession: WorkspaceSession = {
  user: { id: "usr_admin", display_name: "Admin", status: "active" },
  enterprise_roles: [{ enterprise_id: "ent_1", role: "admin" }],
  memberships: [],
};

function fakeClient() {
  return {
    listLoginProviders: vi.fn().mockResolvedValue([
      {
        provider_instance_id: "pi_github",
        provider_type: "github",
        display_origin: "https://github.com",
      },
    ]),
    createWorkspace: vi.fn().mockResolvedValue({}),
  };
}

afterEach(cleanup);

describe("NoWorkspaceScreen", () => {
  it("lets an enterprise admin create a workspace and refresh membership", async () => {
    const client = fakeClient();
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(
      <NoWorkspaceScreen
        session={adminSession}
        client={client as unknown as IdentityClient}
        onRetry={onRetry}
        onSignOut={vi.fn().mockResolvedValue(undefined)}
        onJoinToken={vi.fn()}
      />,
    );

    await waitFor(() => expect(client.listLoginProviders).toHaveBeenCalled());
    await userEvent.type(screen.getByRole("textbox", { name: /Workspace name/ }), "Platform");
    await userEvent.type(
      screen.getByRole("textbox", { name: /Repository ID/ }),
      "github:org/platform",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() =>
      expect(client.createWorkspace).toHaveBeenCalledWith({
        name: "Platform",
        repository_id: "github:org/platform",
        provider_instance_id: "pi_github",
      }),
    );
    expect(onRetry).toHaveBeenCalled();
  });

  it("offers invitation joining to a member without workspace access", async () => {
    const client = fakeClient();
    const onJoinToken = vi.fn();
    render(
      <NoWorkspaceScreen
        session={{ ...adminSession, enterprise_roles: [] }}
        client={client as unknown as IdentityClient}
        onRetry={vi.fn().mockResolvedValue(undefined)}
        onSignOut={vi.fn().mockResolvedValue(undefined)}
        onJoinToken={onJoinToken}
      />,
    );

    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: /Invitation code/ }), "invite-token");
    await userEvent.click(screen.getByRole("button", { name: "Preview invitation" }));
    expect(onJoinToken).toHaveBeenCalledWith("invite-token");
  });
});
