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
  EnterpriseUserPage,
  IdentityClient,
  LoginProvider,
  MemberCandidate,
  MemberCapabilityCeilingView,
  Membership,
  SessionInfo,
  Workspace,
} from "../api/identity";
import { WorkspaceAdminDialog } from "./WorkspaceAdminDialog";
import { capabilityProjection } from "../capabilities/test-projection";
import { enterpriseProjection } from "../capabilities/test-enterprise-projection";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

const capabilityFixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/capability-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

function capabilityFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(capabilityFixtureDir, name), "utf8")) as T;
}

const workspace = fixture<Workspace>("workspace.json");
const session = fixture<SessionInfo>("session.json");
const memberPage = fixture<{ items: Membership[]; next_cursor: string | null }>(
  "membership-page.json",
);
const enterpriseUserPage: EnterpriseUserPage = {
  items: [fixture("enterprise-user.json")],
  next_cursor: null,
};
const enterpriseUser = enterpriseUserPage.items[0];
const loginProvider = fixture<LoginProvider>("login-provider.json");
const candidate = fixture<MemberCandidate>("member-candidate.json");
const secondWorkspace: Workspace = {
  ...workspace,
  id: "ws_01J8Z1C3D5",
  name: "Second Payments",
  repository: { ...workspace.repository, repository_id: "987654321" },
};
const capabilityView = capabilityFixture<MemberCapabilityCeilingView>(
  "member-capability-ceiling.json",
);
const managedCapabilityView = structuredClone(capabilityView);
managedCapabilityView.capability_ceiling.can_manage = true;
managedCapabilityView.capability_ceiling.ceiling.promotion_available = true;
const team = fixture<components["schemas"]["Team"]>("team.json");
const serviceIntegration = fixture<components["schemas"]["ServiceIntegration"]>(
  "service-integration.json",
);
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
  listAllWorkspaces: Mock;
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
  getServiceIntegration: Mock;
  initializeServiceIntegration: Mock;
  deactivateServiceIntegration: Mock;
  getWorkspaceCapabilities: Mock;
  getEnterpriseCapabilities: Mock;
  listEnterpriseUsers: Mock;
  addEnterpriseUser: Mock;
  setEnterpriseUserRole: Mock;
  setEnterpriseUserStatus: Mock;
  listLoginProviders: Mock;
  listMemberCandidates: Mock;
  addWorkspaceMember: Mock;
  grantWorkspaceMember: Mock;
  getMemberCapability: Mock;
  reapproveMemberCapability: Mock;
}

function fakeClient(): FakeClient {
  return {
    listAllWorkspaces: vi.fn().mockResolvedValue([workspace]),
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
    getServiceIntegration: vi.fn().mockResolvedValue(serviceIntegration),
    initializeServiceIntegration: vi.fn().mockResolvedValue(serviceIntegration),
    deactivateServiceIntegration: vi.fn().mockResolvedValue(undefined),
    getWorkspaceCapabilities: vi.fn().mockResolvedValue(
      capabilityProjection({
        role: "owner",
        workspaceId: workspace.id,
        enterpriseId: workspace.enterprise_id,
        enterpriseAdmin: true,
      }),
    ),
    getEnterpriseCapabilities: vi
      .fn()
      .mockResolvedValue(enterpriseProjection({ enterpriseId: workspace.enterprise_id })),
    listEnterpriseUsers: vi.fn().mockResolvedValue(enterpriseUserPage),
    addEnterpriseUser: vi.fn().mockResolvedValue({
      enterprise_user: enterpriseUser,
      created: true,
    }),
    setEnterpriseUserRole: vi.fn(),
    setEnterpriseUserStatus: vi.fn(),
    listLoginProviders: vi.fn().mockResolvedValue([loginProvider]),
    listMemberCandidates: vi.fn().mockResolvedValue({
      items: [candidate],
      next_cursor: null,
    }),
    addWorkspaceMember: vi.fn().mockResolvedValue(memberPage.items[0]),
    grantWorkspaceMember: vi.fn().mockResolvedValue(memberPage.items[0]),
    getMemberCapability: vi.fn().mockResolvedValue(managedCapabilityView),
    reapproveMemberCapability: vi
      .fn()
      .mockResolvedValue(managedCapabilityView.capability_ceiling.evaluation.ceiling),
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
    expect(screen.getByRole("tab", { name: "Repositories" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Invitations" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audit" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Integration" })).toBeTruthy();
    expect(client.listWorkspaceMembers).toHaveBeenCalledWith(workspace.id, undefined);
  });

  it("opens directly on the requested setup tab", async () => {
    const client = fakeClient();
    render(
      <WorkspaceAdminDialog
        client={client as unknown as IdentityClient}
        session={session}
        onClose={() => undefined}
        initialTab="teams"
      />,
    );

    expect(await screen.findByText("Payments Core")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Teams" }).getAttribute("aria-selected")).toBe("true");
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
    client.listAllWorkspaces.mockResolvedValue([{ ...workspace, role: "member" }]);
    client.getWorkspaceCapabilities.mockResolvedValue(
      capabilityProjection({
        role: "member",
        workspaceId: workspace.id,
        enterpriseId: workspace.enterprise_id,
      }),
    );
    renderDialog(client, nonAdminSession);

    expect(await screen.findByText("Read-only roster")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Repositories" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Invitations" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Audit" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Integration" })).toBeNull();
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

  it("opens the service integration for the selected workspace", async () => {
    const client = fakeClient();
    renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Integration" }));
    expect(await screen.findByText("FoMo-Exp/AutoFixer")).toBeTruthy();
    expect(client.getServiceIntegration).toHaveBeenCalledWith(
      workspace.enterprise_id,
      workspace.id,
    );
  });

  it("offers the enterprise directory only to enterprise administrators", async () => {
    const client = fakeClient();
    const admin = renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Enterprise people" }));
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(client.listEnterpriseUsers).toHaveBeenCalledWith(workspace.enterprise_id, {});
    expect(client.getEnterpriseCapabilities.mock.calls[0][0]).toBe(workspace.enterprise_id);
    admin.unmount();

    renderDialog(client, nonAdminSession);
    expect(screen.queryByRole("tab", { name: "Enterprise people" })).toBeNull();
  });

  it("reads per-repository evidence and reapproves inside the verified intersection", async () => {
    const client = fakeClient();
    renderDialog(client);

    const row = (await screen.findByText("Ada Lovelace")).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Verification" }));

    expect(await screen.findByText("github:acme/payments")).toBeTruthy();
    expect(client.getMemberCapability).toHaveBeenCalledWith(
      workspace.enterprise_id,
      workspace.id,
      "usr_01J8Z5N4P7",
    );
    await userEvent.click(screen.getByRole("button", { name: "Reapprove verified ceiling" }));
    await waitFor(() =>
      expect(client.reapproveMemberCapability).toHaveBeenCalledWith(
        workspace.enterprise_id,
        workspace.id,
        "usr_01J8Z5N4P7",
        { version: 2 },
      ),
    );
  });

  it("shows candidate eligibility and grants only the selected account and role", async () => {
    const client = fakeClient();
    renderDialog(client);

    await userEvent.click(await screen.findByRole("button", { name: "Provider candidates" }));
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
    expect(client.listMemberCandidates).toHaveBeenCalledWith(workspace.id, undefined);

    await userEvent.type(screen.getByPlaceholderText("usr_…"), "usr_01J8Z8R3S5");
    await userEvent.click(screen.getByRole("button", { name: "Grant membership" }));
    await waitFor(() =>
      expect(client.addWorkspaceMember).toHaveBeenCalledWith(workspace.id, {
        user_id: "usr_01J8Z8R3S5",
        role: "member",
      }),
    );
  });

  it("renders a provider refusal as ineligibility, never as an empty roster", async () => {
    const client = fakeClient();
    client.listMemberCandidates.mockResolvedValue({
      items: [
        {
          ...candidate,
          eligible: false,
          max_role: null,
          assignable_roles: [],
          ineligible_reason: "authority_stale",
        },
      ],
      next_cursor: null,
    });
    renderDialog(client);

    await userEvent.click(await screen.findByRole("button", { name: "Provider candidates" }));
    expect(await screen.findByText(/Provider authority is stale/i)).toBeTruthy();
    expect(screen.queryByText(/^Eligible up to/)).toBeNull();
  });

  it("explains the last-owner refusal and keeps the member", async () => {
    const client = fakeClient();
    client.removeWorkspaceMember.mockRejectedValue(
      new ApiError(409, errorPayload("LAST_WORKSPACE_OWNER"), "Denied"),
    );
    renderDialog(client);

    const row = (await screen.findByText("Grace Hopper")).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "This is the workspace's last owner. Assign another owner before removing or demoting them.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
  });

  it("reaches the enterprise directory without any visible workspace", async () => {
    const client = fakeClient();
    client.listAllWorkspaces.mockResolvedValue([]);
    renderDialog(client);

    const nav = await screen.findByRole("navigation", { name: "Workspaces" });
    await userEvent.click(within(nav).getByRole("button", { name: /Enterprise people/ }));

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(client.listEnterpriseUsers).toHaveBeenCalledWith(workspace.enterprise_id, {});
  });

  it("renders an incomplete provider roster as a refusal, not an empty list", async () => {
    const client = fakeClient();
    client.listMemberCandidates.mockRejectedValue(
      new ApiError(409, errorPayload("PROVIDER_ROSTER_INCOMPLETE"), "Denied"),
    );
    renderDialog(client);

    await userEvent.click(await screen.findByRole("button", { name: "Provider candidates" }));
    expect(
      await screen.findByText("The provider roster is incomplete. Retry after reconciliation."),
    ).toBeTruthy();
  });

  it("keeps a cross-enterprise directory read non-enumerating", async () => {
    const client = fakeClient();
    client.listEnterpriseUsers.mockRejectedValue(
      new ApiError(404, errorPayload("NOT_FOUND"), "Denied"),
    );
    renderDialog(client);

    await userEvent.click(await screen.findByRole("tab", { name: "Enterprise people" }));
    expect(
      await screen.findByText("The requested resource was not found in your visible scope."),
    ).toBeTruthy();
  });

  it("offers workspaces beyond the first page and grants only the chosen one", async () => {
    const client = fakeClient();
    client.listAllWorkspaces.mockResolvedValue([workspace, secondWorkspace]);
    client.listMemberCandidates.mockResolvedValue({
      items: [
        {
          ...candidate,
          user: {
            display_name: "Ada Lovelace",
            identities: [
              {
                provider_instance_id: enterpriseUser.provider_instance_id,
                provider_type: "github",
                subject_id: enterpriseUser.subject,
              },
            ],
          },
        },
      ],
      next_cursor: null,
    });
    renderDialog(client);

    const nav = await screen.findByRole("navigation", { name: "Workspaces" });
    expect(within(nav).getByRole("button", { name: /Second Payments/ })).toBeTruthy();
    await userEvent.click(within(nav).getByRole("button", { name: /Enterprise people/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Workspace access" }));

    const grant = screen.getByLabelText("Workspace access");
    await userEvent.click(within(grant).getByRole("combobox", { name: "Workspace to grant" }));
    await userEvent.click(screen.getByRole("option", { name: "Second Payments" }));
    expect(await within(grant).findByText(/Eligible up to Member/)).toBeTruthy();
    await userEvent.click(within(grant).getByRole("button", { name: "Grant Member" }));

    await waitFor(() =>
      expect(client.grantWorkspaceMember).toHaveBeenCalledWith(
        workspace.enterprise_id,
        secondWorkspace.id,
        enterpriseUser.user_id,
        { role: "member" },
      ),
    );
  });
});
