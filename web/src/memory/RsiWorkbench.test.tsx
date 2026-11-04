// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgePilotClient } from "../api/client";
import type {
  RsiControls,
  RsiProposal,
  RsiProposalList,
  RsiStatus,
  Workspace,
} from "../api/client";
import { RsiWorkbench } from "./RsiWorkbench";

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")) as T;
}

const identityWorkspaces = fixture<{ items: Workspace[] }>(
  "identity-api-v1/workspace-page.json",
).items;
const baseWorkspace = identityWorkspaces.find((workspace) => workspace.status === "active")!;
const status = fixture<RsiStatus>("rsi-api-v1/status.json");
const killedControls = fixture<{ controls: RsiControls }>(
  "rsi-api-v1/kill-switch-engaged.json",
).controls;
const listedProposals = fixture<RsiProposalList>("rsi-api-v1/proposals.json").proposals;
const awaiting = fixture<RsiProposal>("rsi-api-v1/proposal-awaiting-approval.json");
const ready = fixture<RsiProposal>("rsi-api-v1/proposal-ready.json");
const canary = fixture<RsiProposal>("rsi-api-v1/proposal-canary.json");
const rolledBack = fixture<RsiProposal>("rsi-api-v1/proposal-rolled-back.json");
const failed = fixture<RsiProposal>("rsi-api-v1/proposal-failed.json");

function makeClient(): ForgePilotClient {
  return new ForgePilotClient({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl: () => Promise.reject(new Error("unexpected network request")),
  });
}

function workspace(role: Workspace["role"]): Workspace {
  return { ...baseWorkspace, role };
}

function renderSurface(
  client: ForgePilotClient,
  proposals: RsiProposal[],
  details: RsiProposal[] = proposals,
  role: Workspace["role"] = "owner",
): void {
  vi.spyOn(client, "listWorkspaces").mockResolvedValue([workspace(role)]);
  vi.spyOn(client, "getRsiStatus").mockResolvedValue(status);
  vi.spyOn(client, "listRsiProposals").mockResolvedValue(proposals);
  vi.spyOn(client, "getRsiProposal").mockImplementation(async (_workspace, proposalId) => {
    const found = details.find((entry) => entry.proposal_id === proposalId);
    if (!found) throw new Error(`unexpected proposal ${proposalId}`);
    return found;
  });
  render(<RsiWorkbench client={client} currentUserId="usr_operator" />);
}

async function openProposal(name: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
  await screen.findByRole("heading", { name, level: 2 });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RSI workbench", () => {
  it("renders controls, budget, holdout aggregate, risk ladder, and proposals", async () => {
    const client = makeClient();
    renderSurface(client, listedProposals);

    await screen.findByRole("heading", { name: "Bounded self-improvement" });
    await waitFor(() => expect(screen.getAllByText("Kill switch off").length).toBeGreaterThan(0));
    expect(screen.getByText("0 / 3 · 3 remaining")).toBeTruthy();
    expect(screen.getByText(/198,320/)).toBeTruthy();

    const holdout = screen.getByRole("region", { name: "Aggregate only" });
    expect(within(holdout).getByText("20")).toBeTruthy();
    expect(within(holdout).getByText("Content withheld")).toBeTruthy();
    expect(within(holdout).getByText(/Only its aggregate sample counts/)).toBeTruthy();

    expect(screen.getByRole("heading", { name: "Target → approval gate" })).toBeTruthy();
    expect(screen.getByText("Rejected by RSI")).toBeTruthy();
    expect(screen.getAllByText(/Bounded relevance change/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Rejected retrieval bound change/)).toBeTruthy();
  });

  it("surfaces security events and regression evidence, and never holdout content", async () => {
    const client = makeClient();
    renderSurface(client, [failed]);
    await openProposal("Rejected retrieval bound change");

    expect(screen.getByText("Security event recorded")).toBeTruthy();
    expect(screen.getByText(/forbidden item injection/)).toBeTruthy();
    expect(screen.getByText("Regression evidence")).toBeTruthy();
    expect(screen.getAllByText("Security events")).toHaveLength(1);
    expect(screen.getByText("Server-reported blockers")).toBeTruthy();
    expect(screen.getByText("offline replay did not pass")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/HOLDOUT-SECRET/);
    expect(document.body.textContent).toContain("case content is never part of any response");

    const holdoutEvaluation = failed.evaluations.find((entry) => entry.dataset === "holdout")!;
    const holdoutCard = screen.getByRole("article", {
      name: "Holdout evaluation aggregate",
    });
    expect(within(holdoutCard).getByText("Yes")).toBeTruthy();
    expect(within(holdoutCard).getByText(String(holdoutEvaluation.sample_size))).toBeTruthy();
    for (const text of [
      "Success",
      "Rework",
      "Context cost",
      "Security events",
      "Verifier",
      "Policy",
      "Reflection tokens",
      "Fail",
      "Pass",
    ]) {
      expect(within(holdoutCard).queryByText(text)).toBeNull();
    }
    expect(within(holdoutCard).queryByText(/Δ success/)).toBeNull();
    expect(within(holdoutCard).queryByText(/95% CI/)).toBeNull();
    expect(within(holdoutCard).queryByText(holdoutEvaluation.verifier.reference)).toBeNull();
    expect(within(holdoutCard).queryByText(holdoutEvaluation.policy_hash)).toBeNull();
    expect(within(holdoutCard).queryByText(holdoutEvaluation.memory_version)).toBeNull();
    expect(document.body.textContent).not.toContain(holdoutEvaluation.verifier.reference);

    const diff = screen.getByLabelText("Proposal artifact diff");
    expect(diff.textContent).toContain("- max_items: 8");
    expect(diff.textContent).toContain("+ max_items: 12");
  });

  it("runs the replay, records approval, and starts the canary from a ready proposal", async () => {
    const client = makeClient();
    renderSurface(client, [ready]);
    const evaluate = vi.spyOn(client, "evaluateRsiProposal").mockResolvedValue(awaiting);
    const approve = vi.spyOn(client, "approveRsiProposal").mockResolvedValue(ready);
    const startCanary = vi.spyOn(client, "startRsiCanary").mockResolvedValue(canary);

    await openProposal("Bounded relevance change");

    await userEvent.click(screen.getByRole("button", { name: "Run offline replay" }));
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    expect(evaluate).toHaveBeenCalledWith(baseWorkspace.id, ready.proposal_id, [
      "golden",
      "holdout",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Record approval" }));
    const approvalDialog = await screen.findByRole("dialog", {
      name: "Record a named approval",
    });
    await userEvent.type(
      within(approvalDialog).getByLabelText("Note (optional)"),
      "reviewed replay",
    );
    await userEvent.click(within(approvalDialog).getByRole("button", { name: "Record approval" }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledWith(baseWorkspace.id, ready.proposal_id, "reviewed replay");

    await userEvent.click(screen.getByRole("button", { name: "Start 10% canary" }));
    await waitFor(() => expect(startCanary).toHaveBeenCalledTimes(1));
  });

  it("records a canary observation and requires a reason to roll back", async () => {
    const client = makeClient();
    renderSurface(client, [canary]);
    const observe = vi.spyOn(client, "recordRsiCanaryObservation").mockResolvedValue(canary);
    const rollback = vi.spyOn(client, "rollbackRsiProposal").mockResolvedValue(rolledBack);

    await openProposal("Bounded relevance change");
    expect(screen.getByText("Inconclusive")).toBeTruthy();
    expect(screen.getByText(/pin-set:/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Record stage observation" }));
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Roll back" }));
    const dialog = await screen.findByRole("dialog", { name: "Roll back this proposal" });
    const confirm = within(dialog).getByRole("button", { name: "Roll back" });
    expect(confirm).toHaveProperty("disabled", true);
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "security review");
    await userEvent.click(confirm);
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
    expect(rollback).toHaveBeenCalledWith(baseWorkspace.id, canary.proposal_id, "security review");
  });

  it("does not offer evaluation or approval to the proposal's own author", async () => {
    const client = makeClient();
    vi.spyOn(client, "listWorkspaces").mockResolvedValue([workspace("owner")]);
    vi.spyOn(client, "getRsiStatus").mockResolvedValue(status);
    vi.spyOn(client, "listRsiProposals").mockResolvedValue([awaiting]);
    vi.spyOn(client, "getRsiProposal").mockResolvedValue(awaiting);
    render(<RsiWorkbench client={client} currentUserId={awaiting.proposer.id} />);
    await openProposal("Bounded relevance change");

    expect(screen.getByRole("button", { name: "Run offline replay" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Record approval" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("The proposer cannot evaluate its own proposal.")).toBeTruthy();
    expect(screen.getByText("The proposer cannot approve its own proposal.")).toBeTruthy();
  });

  it("gates owner-only and admin-only actions by workspace role", async () => {
    const adminClient = makeClient();
    vi.spyOn(adminClient, "listWorkspaces").mockResolvedValue([workspace("admin")]);
    vi.spyOn(adminClient, "getRsiStatus").mockResolvedValue(status);
    vi.spyOn(adminClient, "listRsiProposals").mockResolvedValue([awaiting]);
    vi.spyOn(adminClient, "getRsiProposal").mockResolvedValue(awaiting);
    render(<RsiWorkbench client={adminClient} currentUserId="usr_operator" />);
    await openProposal("Bounded relevance change");

    expect(screen.getByRole("button", { name: "Record approval" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Run offline replay" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Start 10% canary" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    expect(screen.getByText("Owner role required to run the replay.")).toBeTruthy();
    expect(screen.getByText("Owner role required to start a canary.")).toBeTruthy();

    cleanup();
    const memberClient = makeClient();
    vi.spyOn(memberClient, "listWorkspaces").mockResolvedValue([workspace("member")]);
    vi.spyOn(memberClient, "getRsiStatus").mockResolvedValue(status);
    vi.spyOn(memberClient, "listRsiProposals").mockResolvedValue([awaiting]);
    vi.spyOn(memberClient, "getRsiProposal").mockResolvedValue(awaiting);
    render(<RsiWorkbench client={memberClient} currentUserId="usr_operator" />);
    await openProposal("Bounded relevance change");
    expect(screen.getByRole("button", { name: "Record approval" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("refuses to read RSI on a viewer membership", async () => {
    const client = makeClient();
    const listStatus = vi.spyOn(client, "getRsiStatus");
    const listProposals = vi.spyOn(client, "listRsiProposals");
    vi.spyOn(client, "listWorkspaces").mockResolvedValue([workspace("viewer")]);
    render(<RsiWorkbench client={client} />);

    expect(await screen.findByText("RSI requires the member role")).toBeTruthy();
    expect(listStatus).not.toHaveBeenCalled();
    expect(listProposals).not.toHaveBeenCalled();
  });

  it("engages the kill switch with a reason and refuses to raise a budget", async () => {
    const client = makeClient();
    renderSurface(client, []);
    const killSwitch = vi.spyOn(client, "setRsiKillSwitch").mockResolvedValue(killedControls);
    const updateControls = vi.spyOn(client, "updateRsiControls");

    await screen.findByRole("heading", { name: "Bounded self-improvement" });
    await userEvent.click(await screen.findByRole("button", { name: "Engage kill switch" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Engage the workspace kill switch",
    });
    const confirm = within(dialog).getByRole("button", { name: "Engage kill switch" });
    expect(confirm).toHaveProperty("disabled", true);
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "security incident");
    await userEvent.click(confirm);
    await waitFor(() => expect(killSwitch).toHaveBeenCalledTimes(1));
    expect(killSwitch).toHaveBeenCalledWith(baseWorkspace.id, true, "security incident");

    const changeBudget = screen.getByLabelText("Weekly change budget");
    await userEvent.clear(changeBudget);
    await userEvent.type(changeBudget, "9");
    await userEvent.click(screen.getByRole("button", { name: "Save controls" }));
    expect(await screen.findByText(/may only tighten the workspace budget/)).toBeTruthy();
    expect(updateControls).not.toHaveBeenCalled();

    await userEvent.clear(changeBudget);
    await userEvent.type(changeBudget, "2");
    await userEvent.click(screen.getByRole("button", { name: "Save controls" }));
    await waitFor(() => expect(updateControls).toHaveBeenCalledTimes(1));
    expect(updateControls).toHaveBeenCalledWith(baseWorkspace.id, {
      auto_promote_low_risk: false,
      weekly_change_budget: 2,
      weekly_reflection_token_budget: 200000,
    });
  });
});
