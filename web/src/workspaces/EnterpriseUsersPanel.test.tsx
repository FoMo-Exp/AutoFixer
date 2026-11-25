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
  CreatedEnterpriseUser,
  EnterpriseUser,
  EnterpriseUserPage,
  IdentityClient,
  LoginProvider,
  MemberCandidatePage,
  MemberCandidate,
  Membership,
  Workspace,
} from "../api/identity";
import { EnterpriseUsersPanel } from "./EnterpriseUsersPanel";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const activeUser = fixture<EnterpriseUser>("enterprise-user.json");
const pendingUser = fixture<EnterpriseUser>("enterprise-user-pending.json");
const workspace = fixture<Workspace>("workspace.json");
const provider = fixture<LoginProvider>("login-provider.json");
const baseCandidate = fixture<MemberCandidate>("member-candidate.json");
const membership = fixture<Membership>("membership.json");

const page: EnterpriseUserPage = { items: [activeUser, pendingUser], next_cursor: null };

function candidateFor(subject: string): MemberCandidate {
  const candidate = structuredClone(baseCandidate);
  candidate.user.identities = [
    {
      provider_instance_id: activeUser.provider_instance_id,
      provider_type: "github",
      subject_id: subject,
    },
  ];
  return candidate;
}

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
  listEnterpriseUsers: Mock;
  addEnterpriseUser: Mock;
  setEnterpriseUserRole: Mock;
  setEnterpriseUserStatus: Mock;
  listLoginProviders: Mock;
  listMemberCandidates: Mock;
  grantWorkspaceMember: Mock;
}

function fakeClient(): FakeClient {
  return {
    listEnterpriseUsers: vi.fn().mockResolvedValue(page),
    addEnterpriseUser: vi.fn().mockResolvedValue({
      enterprise_user: pendingUser,
      created: true,
    } satisfies CreatedEnterpriseUser),
    setEnterpriseUserRole: vi.fn(),
    setEnterpriseUserStatus: vi.fn(),
    listLoginProviders: vi.fn().mockResolvedValue([provider]),
    listMemberCandidates: vi.fn().mockResolvedValue({
      items: [candidateFor(activeUser.subject)],
      next_cursor: null,
    } satisfies MemberCandidatePage),
    grantWorkspaceMember: vi.fn().mockResolvedValue(membership),
  };
}

function renderPanel(client: FakeClient) {
  return render(
    <EnterpriseUsersPanel
      client={client as unknown as IdentityClient}
      enterpriseId={activeUser.enterprise_id}
      workspaces={[workspace]}
      canAddUser
      canSuspendUser
      canRestoreUser
      canChangeRole
      canGrantWorkspace
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EnterpriseUsersPanel", () => {
  it("lists the directory with enterprise-scoped status and pending sign-in", async () => {
    const client = fakeClient();
    renderPanel(client);

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Pending sign-in")).toBeTruthy();
    expect(screen.getByText(/never suspends their global\s+account/i)).toBeTruthy();
    expect(client.listEnterpriseUsers).toHaveBeenCalledWith(activeUser.enterprise_id, {});
    expect(client.listLoginProviders).toHaveBeenCalled();
  });

  it("changes an enterprise role with the read version", async () => {
    const client = fakeClient();
    client.setEnterpriseUserRole.mockResolvedValue({ ...activeUser, role: "admin", version: 3 });
    renderPanel(client);

    const row = (await screen.findByText("Ada Lovelace")).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    await userEvent.click(within(row).getByRole("option", { name: "Enterprise admin" }));

    await waitFor(() =>
      expect(client.setEnterpriseUserRole).toHaveBeenCalledWith(
        activeUser.enterprise_id,
        activeUser.id,
        {
          role: "admin",
          version: 2,
        },
      ),
    );
    expect(within(row).getByRole("combobox").textContent).toContain("Enterprise admin");
  });

  it("reports the last-administrator refusal without changing the row", async () => {
    const client = fakeClient();
    client.setEnterpriseUserRole.mockRejectedValue(
      new ApiError(409, errorPayload("LAST_ENTERPRISE_ADMIN"), "Denied"),
    );
    renderPanel(client);

    const row = (await screen.findByText("Ada Lovelace")).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    await userEvent.click(within(row).getByRole("option", { name: "Enterprise admin" }));

    expect(
      await screen.findByText(
        "This is the last active enterprise administrator. Grant another administrator first.",
      ),
    ).toBeTruthy();
    expect(within(row).getByRole("combobox").textContent).toContain("Member");
  });

  it("reloads the directory on a version conflict before any retry", async () => {
    const client = fakeClient();
    client.setEnterpriseUserRole.mockRejectedValue(
      new ApiError(409, errorPayload("VERSION_CONFLICT"), "Denied"),
    );
    renderPanel(client);

    const row = (await screen.findByText("Ada Lovelace")).closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("combobox"));
    await userEvent.click(within(row).getByRole("option", { name: "Enterprise admin" }));

    expect(
      await screen.findByText("The resource changed while you were editing. Reload and reapply."),
    ).toBeTruthy();
    await waitFor(() => expect(client.listEnterpriseUsers).toHaveBeenCalledTimes(2));
  });

  it("suspends only in this enterprise and reloads on a version conflict", async () => {
    const client = fakeClient();
    client.setEnterpriseUserStatus.mockResolvedValue({
      ...activeUser,
      status: "suspended",
      suspended_at: "2026-11-25T12:00:00Z",
      version: 3,
    });
    renderPanel(client);

    await userEvent.click(await screen.findByRole("button", { name: "Suspend in enterprise" }));
    await waitFor(() =>
      expect(client.setEnterpriseUserStatus).toHaveBeenCalledWith(
        activeUser.enterprise_id,
        activeUser.id,
        "suspended",
        2,
      ),
    );
    expect(await screen.findByText(/suspended in this enterprise only/i)).toBeTruthy();
  });

  it("adds a person by provider instance and stable subject, never by email", async () => {
    const client = fakeClient();
    renderPanel(client);

    await userEvent.click(await screen.findByRole("button", { name: "Add person" }));
    expect(screen.getByText(/Email, login, and display name are never used/i)).toBeTruthy();
    await userEvent.type(screen.getByPlaceholderText("e.g. 424242"), "888888");
    await userEvent.click(screen.getByRole("button", { name: "Add to enterprise" }));

    await waitFor(() =>
      expect(client.addEnterpriseUser).toHaveBeenCalledWith(activeUser.enterprise_id, {
        provider_instance_id: provider.provider_instance_id,
        subject: "888888",
      }),
    );
    expect(await screen.findByText(/stay pending until they sign in/i)).toBeTruthy();
  });

  it("filters the loaded directory by name or subject", async () => {
    const client = fakeClient();
    renderPanel(client);

    await screen.findByText("Ada Lovelace");
    await userEvent.type(screen.getByPlaceholderText(/Name, login, subject/i), "424242");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Subject 424242")).toBeTruthy();
  });

  it("grants one explicitly selected workspace and never auto-joins", async () => {
    const client = fakeClient();
    renderPanel(client);

    await userEvent.click(await screen.findByRole("button", { name: "Workspace access" }));
    const grant = screen.getByLabelText("Workspace access");
    const workspaceSelect = within(grant).getByRole("combobox", { name: "Workspace to grant" });
    await userEvent.click(workspaceSelect);
    await userEvent.click(screen.getByRole("option", { name: "Acme Payments" }));

    expect(await within(grant).findByText(/Eligible up to Member/)).toBeTruthy();
    expect(client.grantWorkspaceMember).not.toHaveBeenCalled();

    await userEvent.click(within(grant).getByRole("button", { name: "Grant Member" }));
    await waitFor(() =>
      expect(client.grantWorkspaceMember).toHaveBeenCalledWith(
        activeUser.enterprise_id,
        workspace.id,
        activeUser.user_id,
        { role: "member" },
      ),
    );
    expect(await screen.findByText(/was granted access to Acme Payments/)).toBeTruthy();
  });

  it("finds a candidate on a later page instead of declaring the roster exhausted", async () => {
    const client = fakeClient();
    client.listMemberCandidates
      .mockResolvedValueOnce({
        items: [candidateFor("999999")],
        next_cursor: "cursor_page_2",
      })
      .mockResolvedValueOnce({
        items: [candidateFor(activeUser.subject)],
        next_cursor: null,
      });
    renderPanel(client);

    await userEvent.click(await screen.findByRole("button", { name: "Workspace access" }));
    const grant = screen.getByLabelText("Workspace access");
    await userEvent.click(within(grant).getByRole("combobox", { name: "Workspace to grant" }));
    await userEvent.click(screen.getByRole("option", { name: "Acme Payments" }));

    expect(await within(grant).findByText(/Eligible up to Member/)).toBeTruthy();
    expect(client.listMemberCandidates).toHaveBeenNthCalledWith(1, workspace.id, undefined);
    expect(client.listMemberCandidates).toHaveBeenNthCalledWith(2, workspace.id, "cursor_page_2");
    expect(screen.queryByText(/not in the workspace/)).toBeNull();
  });

  it("treats a repeated page cursor as an incomplete roster, never as absence", async () => {
    const client = fakeClient();
    client.listMemberCandidates
      .mockResolvedValueOnce({
        items: [candidateFor("999999")],
        next_cursor: "cursor_loop",
      })
      .mockResolvedValueOnce({
        items: [candidateFor("999998")],
        next_cursor: "cursor_loop",
      });
    renderPanel(client);

    await userEvent.click(await screen.findByRole("button", { name: "Workspace access" }));
    const grant = screen.getByLabelText("Workspace access");
    await userEvent.click(within(grant).getByRole("combobox", { name: "Workspace to grant" }));
    await userEvent.click(screen.getByRole("option", { name: "Acme Payments" }));

    expect(await within(grant).findByText(/repeated a page cursor/i)).toBeTruthy();
    expect(within(grant).queryByText(/not in the workspace/i)).toBeNull();
    expect(within(grant).queryByText(/no verified eligibility/i)).toBeNull();
    expect(client.listMemberCandidates).toHaveBeenCalledTimes(2);
  });

  it("does not claim the person is absent the roster when the read failed", async () => {
    const client = fakeClient();
    client.listMemberCandidates.mockRejectedValue(
      new ApiError(409, errorPayload("PROVIDER_ROSTER_INCOMPLETE"), "Denied"),
    );
    renderPanel(client);

    await userEvent.click(await screen.findByRole("button", { name: "Workspace access" }));
    const grant = screen.getByLabelText("Workspace access");
    await userEvent.click(within(grant).getByRole("combobox", { name: "Workspace to grant" }));
    await userEvent.click(screen.getByRole("option", { name: "Acme Payments" }));

    expect(
      await within(grant).findByText(
        "The provider roster is incomplete. Retry after reconciliation.",
      ),
    ).toBeTruthy();
    expect(within(grant).queryByText(/not in the workspace/i)).toBeNull();
    expect(within(grant).queryByText(/no verified eligibility/i)).toBeNull();
  });
});
