// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Approval, Candidate, ForgePilotClient } from "../api/client";
import { ForgePilotClient as Client } from "../api/client";
import type { components } from "../api/contracts/schema";
import { ChangeReviewCard } from "./ChangeReview";
import type { ChangeReviewCardProps } from "./ChangeReview";

const repoFixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/fixtures",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(repoFixtureDir, name), "utf8")) as T;
}

const candidate = fixture<Candidate>("collab-api-v1/candidate.json");
const approval = fixture<Approval>("collab-api-v1/approval.json");
const workspaceId = "ws_01J8Z1C3D4";

function makeClient(): ForgePilotClient {
  return new Client({
    baseUrl: "http://127.0.0.1:4567",
    token: "local-secret",
    fetchImpl: () => Promise.reject(new Error("unexpected network request")),
  });
}

function errorPayload(code: string): components["schemas"]["Error"] {
  return {
    error: {
      envelope_version: 1,
      code,
      stage: "policy",
      category: "stop",
      message: "Conflict",
      retryable: false,
      retry_after_seconds: null,
      request_id: "req_case_9",
      details: {},
      next_action: "refresh",
    },
  };
}

function renderCard(
  client: ForgePilotClient,
  overrides: Partial<ChangeReviewCardProps> = {},
): RenderResult {
  return render(
    <ChangeReviewCard
      client={client}
      workspaceId={workspaceId}
      issueId={candidate.issue_id}
      currentUserId="usr_luthiel"
      canMutate
      candidates={[candidate]}
      approvals={[approval]}
      loading={false}
      error={undefined}
      onRetry={vi.fn()}
      onApprovalUpdated={vi.fn()}
      onChanged={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("change review card", () => {
  it("shows the summary and the authorized diff, validation, risk, and provenance evidence", () => {
    renderCard(makeClient());

    expect(screen.getByText(candidate.summary)).toBeTruthy();
    expect(screen.getByText("src/retry.ts")).toBeTruthy();
    expect(screen.getByText("test/retry.test.ts")).toBeTruthy();
    expect(screen.getByText(/\+42 \/ −7 across 2 paths/)).toBeTruthy();
    expect(screen.getByText("node20-linux-x64-isolated")).toBeTruthy();
    expect(screen.getByText("npm test -- retry")).toBeTruthy();
    expect(screen.getByText("Pass")).toBeTruthy();
    expect(screen.getByText(/sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6/)).toBeTruthy();
    expect(
      screen.getAllByText(/evidence:\/\/events\/run_9c4e7a1b5d3f8024\/7/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("risk_low_approved")).toBeTruthy();
    expect(screen.getByText("art_patch_9c4e")).toBeTruthy();
    expect(screen.getByText("evidence://artifacts/run_9c4e7a1b5d3f8024/patch")).toBeTruthy();
    expect(screen.getByText("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBeTruthy();

    const toggle = screen.getByRole("button", { name: "Hide review evidence" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    return userEvent.click(toggle).then(() => {
      expect(screen.queryByText("src/retry.ts")).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "Expand review evidence" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
    });
  });

  it("records a confirmed approval with the reviewed diff digest and an idempotency key", async () => {
    const client = makeClient();
    const onApprovalUpdated = vi.fn();
    const onChanged = vi.fn();
    const decide = vi.spyOn(client, "decideIssueApproval").mockResolvedValue({
      ...approval,
      state: "approved",
      decided_at: "2026-11-02T12:00:00Z",
      decision: {
        decision: "approve",
        decided_by: approval.approver!,
        decided_at: "2026-11-02T12:00:00Z",
        note: null,
      },
    });
    renderCard(client, { onApprovalUpdated, onChanged });

    await userEvent.click(screen.getByRole("button", { name: "Approve candidate" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve frozen candidate" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve this candidate" }));

    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        workspaceId,
        candidate.issue_id,
        approval.approval_id,
        {
          decision: "approve",
          diff_digest: { algorithm: "sha256", value: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432" },
        },
        expect.stringMatching(/^forgepilot-ui-/),
      ),
    );
    expect(onApprovalUpdated).toHaveBeenCalledWith(expect.objectContaining({ state: "approved" }));
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requires a recorded reason before a rejection is submitted", async () => {
    const client = makeClient();
    const decide = vi.spyOn(client, "decideIssueApproval").mockResolvedValue({
      ...approval,
      state: "rejected",
      decided_at: "2026-11-02T12:05:00Z",
      decision: {
        decision: "reject",
        decided_by: approval.approver!,
        decided_at: "2026-11-02T12:05:00Z",
        note: "The retry guard misses the timeout path.",
      },
    });
    renderCard(client);

    await userEvent.click(screen.getByRole("button", { name: "Reject candidate" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject frozen candidate" });
    const submit = within(dialog).getByRole("button", { name: "Reject candidate" });
    expect(submit).toHaveProperty("disabled", true);

    await userEvent.type(
      within(dialog).getByLabelText(/Rejection reason/),
      "The retry guard misses the timeout path.",
    );
    expect(submit).toHaveProperty("disabled", false);
    await userEvent.click(submit);

    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        workspaceId,
        candidate.issue_id,
        approval.approval_id,
        {
          decision: "reject",
          diff_digest: { algorithm: "sha256", value: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432" },
          note: "The retry guard misses the timeout path.",
        },
        expect.stringMatching(/^forgepilot-ui-/),
      ),
    );
  });

  it("offers no decision to a user who is not the named approver", () => {
    renderCard(makeClient(), { currentUserId: "usr_someone_else" });

    expect(screen.queryByRole("button", { name: "Approve candidate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject candidate" })).toBeNull();
    expect(
      screen.getByText(
        "This request is addressed to Luthiel. Only that named approver can decide.",
      ),
    ).toBeTruthy();
  });

  it("refuses an expired approval", () => {
    renderCard(makeClient(), { approvals: [{ ...approval, state: "expired" }] });

    expect(screen.queryByRole("button", { name: "Approve candidate" })).toBeNull();
    expect(screen.getByText(/This approval is expired/)).toBeTruthy();
  });

  it("refuses an approval invalidated because the content changed", () => {
    renderCard(makeClient(), {
      approvals: [
        {
          ...approval,
          state: "invalidated",
          invalidated_at: "2026-11-02T12:05:00Z",
          invalidated_reason: "content_changed",
        },
      ],
    });

    expect(screen.queryByRole("button", { name: "Approve candidate" })).toBeNull();
    expect(screen.getAllByText(/content changed after review/).length).toBeGreaterThan(0);
    expect(screen.getByText("Approval invalidated")).toBeTruthy();
  });

  it("refuses an approval bound to a different revision", () => {
    renderCard(makeClient(), {
      approvals: [
        {
          ...approval,
          binding: {
            ...approval.binding,
            diff_digest: { algorithm: "sha256", value: "different-digest" },
          },
        },
      ],
    });

    expect(screen.queryByRole("button", { name: "Approve candidate" })).toBeNull();
    expect(screen.getByText(/binding no longer matches this frozen candidate/)).toBeTruthy();
  });

  it("refuses a superseded candidate even when its old approval is pending", async () => {
    const superseding: Candidate = {
      ...candidate,
      candidate_id: "cand_new_000000000001",
      head_sha: "b".repeat(40),
      created_at: "2026-11-02T12:00:00Z",
    };
    renderCard(makeClient(), { candidates: [candidate, superseding] });

    const group = screen.getByRole("group", { name: "Frozen candidates" });
    await userEvent.click(within(group).getByRole("button", { name: /cand_2d6f8a0c4e1b7935/ }));

    expect(screen.queryByRole("button", { name: "Approve candidate" })).toBeNull();
    expect(screen.getByText(/superseded by cand_new_000000000001/)).toBeTruthy();
    expect(screen.getByText("Superseded")).toBeTruthy();
  });

  it("disables decisions for a read-only workspace role", () => {
    renderCard(makeClient(), { canMutate: false });

    expect(screen.queryByRole("button", { name: "Approve candidate" })).toBeNull();
    expect(screen.getByText(/workspace role is read-only/)).toBeTruthy();
  });

  it("shows a recorded decision and no further actions once approved", () => {
    renderCard(makeClient(), {
      approvals: [
        {
          ...approval,
          state: "approved",
          decided_at: "2026-11-02T12:00:00Z",
          decision: {
            decision: "approve",
            decided_by: approval.approver!,
            decided_at: "2026-11-02T12:00:00Z",
            note: "Diff and tests match the frozen revision.",
          },
        },
      ],
    });

    expect(screen.getByText(/Approved by Luthiel/)).toBeTruthy();
    expect(screen.getByText("Diff and tests match the frozen revision.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve candidate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject candidate" })).toBeNull();
  });

  it("surfaces a stale-state conflict and asks for a refresh", async () => {
    const client = makeClient();
    const onChanged = vi.fn();
    vi.spyOn(client, "decideIssueApproval").mockRejectedValue(
      new ApiError(409, errorPayload("APPROVAL_STATE_CONFLICT"), "Conflict"),
    );
    renderCard(client, { onChanged });

    await userEvent.click(screen.getByRole("button", { name: "Approve candidate" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve frozen candidate" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve this candidate" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
