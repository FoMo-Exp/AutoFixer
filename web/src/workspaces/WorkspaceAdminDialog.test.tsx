// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ApiError } from "../api/client";
import type { components } from "../api/contracts/schema";
import type {
  CreatedInvitation,
  IdentityClient,
  Membership,
  SessionInfo,
  Workspace,
} from "../api/identity";
import { WorkspaceAdminDialog } from "./WorkspaceAdminDialog";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const workspace = fixture<Workspace>("workspace.json");
const session = fixture<SessionInfo>("session.json");
const memberPage = fixture<{ items: Membership[]; next_cursor: string | null }>(
  "membership-page.json",
);
const team = fixture<components["schemas"]["Team"]>("team.json");
const createdInvitation = fixture<CreatedInvitation>("invitation-created.json");
const invitation = createdInvitation.invitation;

function errorPayload(code: string): components["schemas"]["Error"] {
  return {
    error: {
      envelope_version: 1,
      code,
      stage: "authorization",
      category: "denial",
      message: "Denied",
      retryable: false,
      retry_after_seconds: null,
      request_id: "req_case_9",
      details: {},
      next_action: "contact_admin",
    },
  };
}

interface FakeClient {
  listWorkspaces: Mock;
  listWorkspaceMembers: Mock;
  updateWorkspaceMember: Mock;
  removeWorkspaceMember: Mock;
  listWorkspaceTeams: Mock;
  createWorkspaceTeam: Mock;
  updateWorkspaceTeam: Mock;
  deleteWorkspaceTeam: Mock;
  listInvitations: Mock;
  createInvitation: Mock;
  revokeInvitation: Mock;
  listAuthAudit: Mock;
}

function fakeClient(): FakeClient {
  return {
    listWorkspaces: vi.fn().mockResolvedValue({ items: [workspace], next_cursor: null }),
    listWorkspaceMembers: vi.fn().mockResolvedValue(memberPage),
    updateWorkspaceMember: vi.fn(),
    removeWorkspaceMember: vi.fn().mockResolvedValue(undefined),
    listWorkspaceTeams: vi.fn().mockResolvedValue({ items: [team], next_cursor: null }),
    createWorkspaceTeam: vi.fn(),
    updateWorkspaceTeam: vi.fn(),
    deleteWorkspaceTeam: vi.fn().mockResolvedValue(undefined),
    listInvitations: vi.fn().mockResolvedValue({ items: [invitation], next_cursor: null }),
    createInvitation: vi.fn().mockResolvedValue(createdInvitation),
    revokeInvitation: vi.fn().mockResolvedValue(undefined),
    listAuthAudit: vi.fn().mockResolvedValue({
      items: [
        {
          id: "aud_1",
          at: "2026-11-03T12:00:00Z",
          event: "membership.granted",
          enterprise_id: workspace.enterprise_id,
          actor_kind: "user",
          actor_user_id: "usr_01J8Z5N4P7",
          subject_user_id: null,
          provider_instance_id: null,
          details: {},
        },
      ],
    }),
  };
}

function renderDialog(client: FakeClient, activeSession: SessionInfo = session) {
  return render(
    <WorkspaceAdminDialog
      client={client as unknown as IdentityClient}
      session={activeSession}
      onClose={() => undefined}
    />,
  );
}

const nonAdminSession: SessionInfo = { ...session, enterprise_roles: [] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkspaceAdminDialog", () => {
  it("shows the roster with provider-role provenance and manager controls", async () => {
    const client = fakeClient();
    renderDialog(client);

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText(/Inherited role/)).toBeTruthy();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Invitations" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audit" })).toBeTruthy();
    expect(client.listWorkspaceMembers).toHaveBeenCalledWith(workspace.id, undefined);
  });

  it("changes a role with the membership version and reflects the server result", async () => {
    const client = fakeClient();
    client.updateWorkspaceMember.mockResolvedValue({ ...memberPage.items[0], role: "admin" });
    renderDialog(client);

    const row = (await screen.findByText("Ada Lovelace")).closest("li");
    const select = within(row as HTMLElement).getByRole("combobox");
    await userEvent.click(select);
    await userEvent.click(within(row as HTMLElement).getByRole("option", { name: "Admin" }));

    await waitFor(() =>
      expect(client.updateWorkspaceMember).toHaveBeenCalledWith(workspace.id, "mem_01J8Z6E5F6", {
        role: "admin",
        version: 1,
      }),
    );
    expect(within(row as HTMLElement).getByRole("combobox").textContent).toContain("Admin");
  });

  it("renders an authority denial without pretending the role changed", async () => {
    const client = fakeClient();
    client.updateWorkspaceMember.mockRejectedValue(
      new ApiError(403, errorPayload("ROLE_NOT_ASSIGNABLE"), "Denied"),
    );
    renderDialog(client);

    const row = (await screen.findByText("Ada Lovelace")).closest("li");
    await userEvent.click(within(row as HTMLElement).getByRole("combobox"));
    await userEvent.click(within(row as HTMLElement).getByRole("option", { name: "Owner" }));

    expect(
      await screen.findByText("You cannot assign a role above your own authority."),
    ).toBeTruthy();
    expect(within(row as HTMLElement).getByRole("combobox").textContent).toContain("Member");
  });

  it("keeps a non-manager read-only and never requests the invitation list", async () => {
    const client = fakeClient();
    client.listWorkspaces.mockResolvedValue({
      items: [{ ...workspace, role: "member" }],
      next_cursor: null,
    });
    renderDialog(client, nonAdminSession);

    expect(await screen.findByText("Read-only roster")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Invitations" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Audit" })).toBeNull();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(client.listInvitations).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("tab", { name: "Teams" }));
    expect(await screen.findByText("Read-only teams")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New team" })).toBeNull();
  });

  it("reveals a new invitation's QR and grouped code exactly once", async () => {
    const client = fakeClient();
    renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Invitations" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create invitation" }));

    expect(await screen.findByText("Single-use invitation")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Invitation QR code" })).toBeTruthy();
    expect(screen.getByText(/inv_2ZxQ 7mK9/)).toBeTruthy();
    expect(client.createInvitation).toHaveBeenCalledWith(workspace.id, {
      expires_in_seconds: 86400,
    });
    expect(client.listInvitations).toHaveBeenCalledWith(workspace.id);

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/inv_2ZxQ 7mK9/)).toBeNull();
    expect(document.body.innerHTML).not.toContain(createdInvitation.token);
  });

  it("revokes only after the inline confirmation and refreshes the list", async () => {
    const client = fakeClient();
    renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Invitations" }));
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(client.revokeInvitation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(client.revokeInvitation).toHaveBeenCalledWith(workspace.id, invitation.id),
    );
    expect(client.listInvitations).toHaveBeenCalledTimes(2);
  });

  it("creates a team with the selected active leader", async () => {
    const client = fakeClient();
    client.createWorkspaceTeam.mockResolvedValue(team);
    renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Teams" }));
    await userEvent.click(await screen.findByRole("button", { name: "New team" }));
    await userEvent.type(screen.getByRole("textbox", { name: /Name/ }), "Payments");
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Ada Lovelace" }));
    await userEvent.click(screen.getByRole("button", { name: "Create team" }));

    await waitFor(() =>
      expect(client.createWorkspaceTeam).toHaveBeenCalledWith(workspace.id, {
        name: "Payments",
        leader_user_id: "usr_01J8Z5N4P7",
      }),
    );
  });

  it("shows the leader-membership rejection from the contract", async () => {
    const client = fakeClient();
    client.createWorkspaceTeam.mockRejectedValue(
      new ApiError(422, errorPayload("TEAM_LEADER_NOT_MEMBER"), "Denied"),
    );
    renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Teams" }));
    await userEvent.click(await screen.findByRole("button", { name: "New team" }));
    await userEvent.type(screen.getByRole("textbox", { name: /Name/ }), "Payments");
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Ada Lovelace" }));
    await userEvent.click(screen.getByRole("button", { name: "Create team" }));

    expect(
      await screen.findByText("A team leader must be an active workspace member."),
    ).toBeTruthy();
  });

  it("moves focus into the dialog, traps Tab, and restores the trigger on close", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open workspaces";
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const client = fakeClient();

    const { unmount } = render(
      <WorkspaceAdminDialog
        client={client as unknown as IdentityClient}
        session={session}
        onClose={onClose}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Workspaces" });
    await screen.findByText("Ada Lovelace");
    expect(dialog.contains(document.activeElement)).toBe(true);

    for (let step = 0; step < 30; step += 1) await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [role="combobox"]',
      ),
    ).filter((element) => element.closest("[hidden]") === null);
    focusables[focusables.length - 1]?.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(focusables[0]);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("lists the enterprise audit trail for enterprise administrators", async () => {
    const client = fakeClient();
    renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Audit" }));
    expect(await screen.findByText("membership.granted")).toBeTruthy();
    expect(client.listAuthAudit).toHaveBeenCalledWith(workspace.enterprise_id, 50);
  });
});
