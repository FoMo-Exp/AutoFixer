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
import type { IdentityClient, ServiceIntegration, Workspace } from "../api/identity";
import { ServiceIntegrationPanel, credentialRefIssue } from "./ServiceIntegrationPanel";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures/identity-api-v1",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const workspace = fixture<Workspace>("workspace.json");
const integration = fixture<ServiceIntegration>("service-integration.json");

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

function apiError(status: number, code: string): ApiError {
  return new ApiError(status, errorPayload(code), "Denied");
}

interface FakeClient {
  getServiceIntegration: Mock;
  initializeServiceIntegration: Mock;
  deactivateServiceIntegration: Mock;
}

function fakeClient(): FakeClient {
  return {
    getServiceIntegration: vi.fn().mockResolvedValue(integration),
    initializeServiceIntegration: vi.fn().mockResolvedValue(integration),
    deactivateServiceIntegration: vi.fn().mockResolvedValue(undefined),
  };
}

function renderPanel(client: FakeClient, canConfigure = true, target: Workspace = workspace) {
  return render(
    <ServiceIntegrationPanel
      client={client as unknown as IdentityClient}
      workspace={target}
      canConfigure={canConfigure}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ServiceIntegrationPanel", () => {
  it("shows the active binding without references or secrets", async () => {
    const client = fakeClient();
    renderPanel(client);

    expect(await screen.findByText("FoMo-Exp/AutoFixer")).toBeTruthy();
    expect(screen.getByText("github:FoMo-Exp/AutoFixer")).toBeTruthy();
    expect(screen.getByText("pi_github_main")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Visibility: Full")).toBeTruthy();
    expect(screen.getByText("Source: configured")).toBeTruthy();
    expect(screen.getByText("Checkout: configured")).toBeTruthy();
    expect(screen.getByText("Delivery: not configured")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Initialize integration" })).toBeNull();
    expect(client.getServiceIntegration).toHaveBeenCalledWith(
      workspace.enterprise_id,
      workspace.id,
    );
  });

  it("deactivates only after the inline confirmation and reports the fail-closed state", async () => {
    const client = fakeClient();
    renderPanel(client);

    await screen.findByText("Active");
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(client.deactivateServiceIntegration).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm deactivate" }));
    await waitFor(() =>
      expect(client.deactivateServiceIntegration).toHaveBeenCalledWith(
        workspace.enterprise_id,
        workspace.id,
      ),
    );
    expect(await screen.findByText(/fail closed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Initialize integration" })).toBeTruthy();
  });

  it("initializes with trimmed references and the optional capabilities only", async () => {
    const client = fakeClient();
    client.getServiceIntegration.mockRejectedValue(apiError(404, "SERVICE_INTEGRATION_NOT_FOUND"));
    renderPanel(client);

    expect(await screen.findByText(/No active service integration/)).toBeTruthy();
    await userEvent.type(
      screen.getByRole("textbox", { name: /Source credential reference/ }),
      "svc-source-1",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: /Checkout credential reference/ }),
      " svc-checkout-1 ",
    );
    await userEvent.click(screen.getByRole("button", { name: "Initialize integration" }));

    await waitFor(() =>
      expect(client.initializeServiceIntegration).toHaveBeenCalledWith(
        workspace.enterprise_id,
        workspace.id,
        { source_credential_ref: "svc-source-1", checkout_credential_ref: "svc-checkout-1" },
      ),
    );
    expect(await screen.findByText("Active")).toBeTruthy();
  });

  it("refuses a pasted secret locally without sending it anywhere", async () => {
    const client = fakeClient();
    client.getServiceIntegration.mockRejectedValue(apiError(404, "SERVICE_INTEGRATION_NOT_FOUND"));
    renderPanel(client);

    await userEvent.type(
      await screen.findByRole("textbox", { name: /Source credential reference/ }),
      "ghp_secretvalue",
    );
    await userEvent.click(screen.getByRole("button", { name: "Initialize integration" }));

    expect(await screen.findByText(/looks like a secret value/)).toBeTruthy();
    expect(client.initializeServiceIntegration).not.toHaveBeenCalled();
  });

  it("renders a 403 without offering any change", async () => {
    const client = fakeClient();
    client.getServiceIntegration.mockRejectedValue(apiError(403, "FORBIDDEN"));
    renderPanel(client);

    expect(await screen.findByText("Your role does not permit this action.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Initialize integration" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("hides every action for an archived workspace", async () => {
    const client = fakeClient();
    client.getServiceIntegration.mockRejectedValue(apiError(409, "WORKSPACE_ARCHIVED"));
    renderPanel(client, true, { ...workspace, status: "archived" });

    expect(
      await screen.findByText("Archived workspaces cannot carry a service integration."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Initialize integration" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("renders a non-active integration defensively and permits re-initialization", async () => {
    const client = fakeClient();
    client.getServiceIntegration.mockResolvedValue({
      ...integration,
      install_status: "suspended",
    });
    renderPanel(client);

    expect(await screen.findByText("Suspended")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(screen.getByRole("button", { name: "Initialize integration" })).toBeTruthy();
  });

  it("offers no write when the current integration could not be read", async () => {
    const client = fakeClient();
    client.getServiceIntegration.mockRejectedValue(new Error("network down"));
    renderPanel(client);

    expect(await screen.findByText("network down")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Initialize integration" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("re-reads the integration when the selected workspace changes", async () => {
    const client = fakeClient();
    const { rerender } = renderPanel(client);

    await screen.findByText("Active");
    const other = { ...workspace, id: "ws_other" };
    rerender(
      <ServiceIntegrationPanel
        client={client as unknown as IdentityClient}
        workspace={other}
        canConfigure
      />,
    );

    await waitFor(() =>
      expect(client.getServiceIntegration).toHaveBeenLastCalledWith(
        workspace.enterprise_id,
        other.id,
      ),
    );
  });

  it("rejects references that break the contract shape", () => {
    expect(credentialRefIssue("", true)).toBe("Enter a credential reference.");
    expect(credentialRefIssue("", false)).toBeUndefined();
    expect(credentialRefIssue("has space", true)).toBeTruthy();
    expect(credentialRefIssue("x".repeat(201), true)).toBeTruthy();
    expect(credentialRefIssue("svc-source-1", true)).toBeUndefined();
  });
});
