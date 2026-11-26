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
import type {
  IdentityClient,
  RepositorySetAdditionCommitResult,
  RepositorySetAdditionConfirmation,
  RepositorySetAdditionPreview,
  Workspace,
} from "../api/identity";
import { RepositorySetAdditionPanel } from "./RepositorySetAdditionPanel";

const repositorySetFixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/repository-set-api-v1",
);
const identityFixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

function fixture<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
}

const workspace = fixture<Workspace>(identityFixtureDir, "workspace.json");
const reductionPreview = fixture<RepositorySetAdditionPreview>(
  repositorySetFixtureDir,
  "addition-preview-reduction.json",
);
const unknownEvidencePreview = fixture<RepositorySetAdditionPreview>(
  repositorySetFixtureDir,
  "addition-preview-unknown-evidence.json",
);
const lastOwnerPreview = fixture<RepositorySetAdditionPreview>(
  repositorySetFixtureDir,
  "addition-preview-last-owner.json",
);
const confirmation = fixture<RepositorySetAdditionConfirmation>(
  repositorySetFixtureDir,
  "addition-confirmation.json",
);
const commitResult = fixture<RepositorySetAdditionCommitResult>(
  repositorySetFixtureDir,
  "addition-commit-result.json",
);

interface FakeClient {
  previewRepositorySetAddition: Mock;
  confirmRepositorySetAddition: Mock;
  commitRepositorySetAddition: Mock;
}

function fakeClient(preview: RepositorySetAdditionPreview = reductionPreview): FakeClient {
  return {
    previewRepositorySetAddition: vi.fn().mockResolvedValue(preview),
    confirmRepositorySetAddition: vi.fn().mockResolvedValue(confirmation),
    commitRepositorySetAddition: vi.fn().mockResolvedValue(commitResult),
  };
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
      request_id: "req_repository_set_1",
      details: {},
      next_action: "contact_admin",
    },
  };
}

function renderPanel(client: FakeClient, canManage = true) {
  return render(
    <RepositorySetAdditionPanel
      client={client as unknown as IdentityClient}
      workspace={workspace}
      canManage={canManage}
    />,
  );
}

interface TypingUser {
  type: (element: Element, text: string) => Promise<void>;
}

async function proposeRepositories(user: TypingUser): Promise<void> {
  await user.type(screen.getByLabelText("Installation reference"), "sint_installation_b");
  await user.type(screen.getByLabelText("Repository id"), "gitlab:repo:9100");
}

const expectedProposal = [
  {
    provider_instance_id: workspace.repository.provider_instance_id,
    installation_ref: "sint_installation_b",
    repository_id: "gitlab:repo:9100",
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RepositorySetAdditionPanel", () => {
  it("previews the full-set reduction and confirms exactly the impact it showed", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderPanel(client);

    await proposeRepositories(user);
    await user.click(screen.getByRole("button", { name: "Preview impact" }));

    await waitFor(() =>
      expect(client.previewRepositorySetAddition).toHaveBeenCalledWith(workspace.id, {
        additional_repositories: expectedProposal,
      }),
    );
    expect(await screen.findByText("Impact preview")).toBeTruthy();
    expect(screen.getByText(/Preview only — this authorizes no access/)).toBeTruthy();
    expect(
      screen.getByText("Current capabilities: Read code, Write issues, Write repository"),
    ).toBeTruthy();
    expect(screen.getByText("Proposed capabilities: Read code")).toBeTruthy();
    expect(screen.getByText("Removes: Write issues, Write repository")).toBeTruthy();
    expect(screen.getByText("Assigned role: Member")).toBeTruthy();
    expect(screen.getByText("Effective owner")).toBeTruthy();

    const confirm = screen.getByRole("button", { name: "Confirm impact" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await user.click(screen.getByRole("checkbox"));
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);

    await waitFor(() =>
      expect(client.confirmRepositorySetAddition).toHaveBeenCalledWith(workspace.id, {
        expected_set_version: reductionPreview.set_version,
        additional_repositories: expectedProposal,
        confirmed_reductions: reductionPreview.reductions_required,
      }),
    );

    expect(await screen.findByText("Confirmation recorded")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Commit addition" }));

    await waitFor(() =>
      expect(client.commitRepositorySetAddition).toHaveBeenCalledWith(
        workspace.id,
        confirmation.confirmation_id,
      ),
    );
    expect(await screen.findByText("Addition committed")).toBeTruthy();
    expect(screen.getByText(/Set version 1 → 2/)).toBeTruthy();
  });

  it("renders unknown evidence as unverified instead of a confirmed loss and refuses confirmation", async () => {
    const user = userEvent.setup();
    const client = fakeClient(unknownEvidencePreview);
    renderPanel(client);

    await proposeRepositories(user);
    await user.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(await screen.findByText("Access not verified")).toBeTruthy();
    expect(screen.queryByText("Loses access")).toBeNull();
    expect(screen.getByText("Proposed capabilities: not verified")).toBeTruthy();
    expect(screen.getByText("Evidence: Evidence unknown")).toBeTruthy();
    expect(
      screen.getByText(/At least one current member would not keep verified code read/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm impact" })).toBeNull();
    expect(client.confirmRepositorySetAddition).not.toHaveBeenCalled();
  });

  it("blocks an addition that would leave no effective owner", async () => {
    const user = userEvent.setup();
    const client = fakeClient(lastOwnerPreview);
    renderPanel(client);

    await proposeRepositories(user);
    await user.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(
      await screen.findByText(/No owner would keep verified repository management/),
    ).toBeTruthy();
    expect(screen.getByText("Repository management would not survive")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm impact" })).toBeNull();
  });

  it("previews an addition with no capability change and still records the decision", async () => {
    const user = userEvent.setup();
    const noImpact = structuredClone(reductionPreview);
    for (const member of noImpact.members) {
      member.reduction = [];
      member.proposed_capabilities = [...member.current_capabilities];
    }
    noImpact.reductions_required = [];
    noImpact.impact.reduced_members = 0;
    noImpact.impact.removed_capabilities = 0;
    const client = fakeClient(noImpact);
    renderPanel(client);

    await proposeRepositories(user);
    await user.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(
      await screen.findByText(
        /No member loses a capability or verified access\. Confirming records that you accepted this specific impact/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm impact" }));

    await waitFor(() =>
      expect(client.confirmRepositorySetAddition).toHaveBeenCalledWith(workspace.id, {
        expected_set_version: noImpact.set_version,
        additional_repositories: expectedProposal,
        confirmed_reductions: [],
      }),
    );
  });

  it("reports a closed rollout gate as non-committable", async () => {
    const user = userEvent.setup();
    const gated = structuredClone(reductionPreview);
    gated.multi_repository_gate = "disabled";
    gated.committable = false;
    gated.commit_blocked_reasons = ["MULTI_REPOSITORY_GATE_DISABLED"];
    const client = fakeClient(gated);
    renderPanel(client);

    await proposeRepositories(user);
    await user.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(await screen.findByText("Rollout gate closed")).toBeTruthy();
    expect(
      screen.getByText(
        /The multi-repository rollout gate is closed\. This preview is informational/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm impact" })).toBeNull();
  });

  it("drops the preview and its acknowledgement when the proposal changes", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderPanel(client);

    await proposeRepositories(user);
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText("Impact preview")).toBeTruthy();
    await user.click(screen.getByRole("checkbox"));

    await user.type(screen.getByLabelText("Repository id"), "-changed");

    expect(screen.queryByText("Impact preview")).toBeNull();
    expect(screen.queryByText("Confirm the impact")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm impact" })).toBeNull();
    expect(client.confirmRepositorySetAddition).not.toHaveBeenCalled();
  });

  it("never reuses a confirmation the server refused as stale", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    client.commitRepositorySetAddition.mockRejectedValue(
      new ApiError(
        409,
        errorPayload("REPOSITORY_SET_CHANGE_CONFIRMATION_STALE"),
        "Confirmation stale",
      ),
    );
    renderPanel(client);

    await proposeRepositories(user);
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    await screen.findByText("Impact preview");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Confirm impact" }));
    await screen.findByText("Confirmation recorded");
    await user.click(screen.getByRole("button", { name: "Commit addition" }));

    expect(
      await screen.findByText(
        "The confirmed impact no longer matches the current facts. Preview and confirm again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Impact preview")).toBeNull();
    expect(screen.queryByText("Confirmation recorded")).toBeNull();
    expect(screen.queryByRole("button", { name: "Commit addition" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview impact" })).toBeTruthy();
  });

  it("requires the immutable repository identity before previewing", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderPanel(client);

    await user.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(await screen.findByText("Enter the approved installation reference.")).toBeTruthy();
    expect(screen.getByText("Enter the provider-assigned repository id.")).toBeTruthy();
    expect(client.previewRepositorySetAddition).not.toHaveBeenCalled();
  });

  it("submits the preview from the keyboard", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderPanel(client);

    await user.type(screen.getByLabelText("Installation reference"), "sint_installation_b");
    await user.type(screen.getByLabelText("Repository id"), "gitlab:repo:9100{Enter}");

    await waitFor(() => expect(client.previewRepositorySetAddition).toHaveBeenCalled());
  });

  it("disables the proposal without the administration decision", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderPanel(client, false);

    expect(
      screen.getByText(/Your current capabilities do not allow repository-set changes/),
    ).toBeTruthy();
    expect((screen.getByLabelText("Installation reference") as HTMLInputElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(client.previewRepositorySetAddition).not.toHaveBeenCalled();
  });
});
