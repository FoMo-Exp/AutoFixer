// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candidate, Delivery, ForgePilotClient } from "../api/client";
import { ForgePilotClient as Client } from "../api/client";
import { DeliveryStatusCard } from "./DeliveryStatus";

const repoFixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(repoFixtureDir, name), "utf8")) as T;
}

const delivery = fixture<Delivery>("collab-api-v1/delivery.json");
const candidate = fixture<Candidate>("collab-api-v1/candidate.json");
const workspaceId = "ws_01J8Z1C3D4";

function makeClient(): ForgePilotClient {
  return new Client({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl: () => Promise.reject(new Error("unexpected network request")),
  });
}

function renderCard(client: ForgePilotClient, deliveries: Delivery[] = [delivery]): void {
  render(
    <DeliveryStatusCard
      client={client}
      workspaceId={workspaceId}
      issueId={delivery.issue_id}
      deliveries={deliveries}
      candidates={[candidate]}
      loading={false}
      error={undefined}
      canMutate
      onRetry={vi.fn()}
      onDeliveryUpdated={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("delivery status card", () => {
  it("renders a partial outcome as an explicit non-success with its provider evidence", () => {
    renderCard(makeClient());

    expect(screen.getByText("Partial — branch pushed, PR not confirmed")).toBeTruthy();
    expect(screen.getByText(/This is not success/)).toBeTruthy();
    expect(screen.getByText("autofixer/iss_7f3c2a9e51b84d0fa1c6")).toBeTruthy();
    expect(screen.getByText("PROVIDER_ERROR")).toBeTruthy();
    expect(screen.getByText("None confirmed")).toBeTruthy();
    expect(screen.queryByText("Delivered — pull request opened")).toBeNull();
  });

  it("reconciles an unknown outcome and records the returned state", async () => {
    const client = makeClient();
    const onDeliveryUpdated = vi.fn();
    const unknown: Delivery = {
      ...delivery,
      state: "unknown",
      branch: null,
      error_code: "DELIVERY_OUTCOME_UNKNOWN",
    };
    const reconcile = vi.spyOn(client, "reconcileIssueDelivery").mockResolvedValue({
      ...unknown,
      state: "delivered",
      pr_id: "42",
      pr_url: "https://github.com/acme/payments-api/pull/42",
      reconciled_at: "2026-11-02T12:20:00Z",
    });
    render(
      <DeliveryStatusCard
        client={client}
        workspaceId={workspaceId}
        issueId={unknown.issue_id}
        deliveries={[unknown]}
        candidates={[candidate]}
        loading={false}
        error={undefined}
        canMutate
        onRetry={vi.fn()}
        onDeliveryUpdated={onDeliveryUpdated}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Unknown — reconcile before retrying")).toBeTruthy();
    expect(screen.getByText(/The provider outcome is unknown/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Reconcile outcome" }));
    const dialog = await screen.findByRole("dialog", { name: "Reconcile delivery outcome" });
    await userEvent.type(
      within(dialog).getByLabelText(/Reconciliation note/),
      "Provider shows PR 42",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Record reconciliation" }));

    await waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(
        workspaceId,
        unknown.issue_id,
        unknown.delivery_id,
        { note: "Provider shows PR 42" },
        expect.stringMatching(/^forgepilot-ui-/),
      ),
    );
    expect(onDeliveryUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ state: "delivered", pr_id: "42" }),
    );
  });

  it("shows a delivered PR without claiming a merge", () => {
    render(
      <DeliveryStatusCard
        client={makeClient()}
        workspaceId={workspaceId}
        issueId={delivery.issue_id}
        deliveries={[
          {
            ...delivery,
            state: "delivered",
            pr_id: "42",
            pr_url: "https://github.com/acme/payments-api/pull/42",
            error_code: null,
          },
        ]}
        candidates={[candidate]}
        loading={false}
        error={undefined}
        canMutate
        onRetry={vi.fn()}
        onDeliveryUpdated={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Delivered — pull request opened")).toBeTruthy();
    expect(
      screen.getByText(/https:\/\/github.com\/acme\/payments-api\/pull\/42 · #42/),
    ).toBeTruthy();
    expect(screen.getByText(/never merges/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconcile outcome" })).toBeNull();
  });

  it("hides the reconciliation remedy from a read-only role", () => {
    render(
      <DeliveryStatusCard
        client={makeClient()}
        workspaceId={workspaceId}
        issueId={delivery.issue_id}
        deliveries={[{ ...delivery, state: "unknown" }]}
        candidates={[candidate]}
        loading={false}
        error={undefined}
        canMutate={false}
        onRetry={vi.fn()}
        onDeliveryUpdated={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Reconcile outcome" })).toBeNull();
    expect(screen.getByText(/workspace role is read-only/)).toBeTruthy();
  });

  it("states that no delivery exists before an approval", () => {
    renderCard(makeClient(), []);

    expect(screen.getByText(/No delivery operation exists yet/)).toBeTruthy();
    expect(screen.getByText(/candidate-bound human approval/)).toBeTruthy();
  });
});
