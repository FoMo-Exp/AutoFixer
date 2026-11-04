import { describe, expect, it } from "vitest";
import type { IssueEvent } from "../api/client";
import {
  HARNESS_STATE_NOTE,
  harnessStateLabel,
  isTerminalProductState,
  isTerminalTaskState,
  issueEventLabel,
  issueEventSummary,
  issueTaskStateLabel,
  productStateDescription,
  productStateLabel,
  runRequiresDisposition,
  stageChangeNeedsDisposition,
  stageChangeNeedsReason,
} from "./issues";

function event(type: string, data: Record<string, unknown>): IssueEvent {
  return {
    event_id: "evt_1",
    sequence: 1,
    occurred_at: "2026-11-02T11:41:00Z",
    issue_id: "iss_1",
    type: type as IssueEvent["type"],
    data,
  };
}

describe("product stage and harness state are distinct", () => {
  it("labels awaiting_change_approval as a product stage with no PR", () => {
    expect(productStateLabel("awaiting_change_approval")).toBe("Awaiting change approval");
    expect(productStateDescription("awaiting_change_approval")).toContain("No remote branch or PR");
    expect(productStateLabel("awaiting_change_approval")).not.toBe(
      harnessStateLabel("awaiting_review"),
    );
    expect(harnessStateLabel("awaiting_review")).toBe("Awaiting review");
    expect(HARNESS_STATE_NOTE).toContain("not product stages");
  });

  it("makes an unknown product stage explicit and infers nothing", () => {
    expect(productStateLabel("quarantined")).toBe("Unknown product stage (quarantined)");
    expect(productStateDescription("quarantined")).toContain("does not recognise");
    expect(harnessStateLabel("paused")).toBe("Unknown harness state (paused)");
    expect(issueTaskStateLabel("someday")).toBe("Unknown task state (someday)");
  });

  it("treats only completed and cancelled as terminal product stages", () => {
    expect(isTerminalProductState("completed")).toBe(true);
    expect(isTerminalProductState("cancelled")).toBe(true);
    expect(isTerminalProductState("needs_human")).toBe(false);
    expect(isTerminalProductState("delivering")).toBe(false);
    expect(isTerminalTaskState("done")).toBe(true);
    expect(isTerminalTaskState("cancelled")).toBe(true);
    expect(isTerminalTaskState("active")).toBe(false);
  });
});

describe("disposition requirements", () => {
  it("requires a reason for stop and cancellation edges", () => {
    expect(stageChangeNeedsReason("needs_human")).toBe(true);
    expect(stageChangeNeedsReason("cancelled")).toBe(true);
    expect(stageChangeNeedsReason("planning")).toBe(false);
  });

  it("requires a disposition reference only when leaving needs_human", () => {
    expect(stageChangeNeedsDisposition("needs_human")).toBe(true);
    expect(stageChangeNeedsDisposition("validating")).toBe(false);
  });

  it("treats stopped and timed-out runs as needing disposition, merged as done", () => {
    expect(runRequiresDisposition("stopped")).toBe(true);
    expect(runRequiresDisposition("timed_out")).toBe(true);
    expect(runRequiresDisposition("expired")).toBe(true);
    expect(runRequiresDisposition("rejected")).toBe(true);
    expect(runRequiresDisposition("cancelled")).toBe(true);
    expect(runRequiresDisposition("merged")).toBe(false);
    expect(runRequiresDisposition("running")).toBe(false);
  });
});

describe("issue event projection", () => {
  it("summarises a stage change from documented fields only", () => {
    const summary = issueEventSummary(
      event("issue.stage_changed", {
        from: "implementing",
        to: "needs_human",
        reason: "Validation failed twice",
      }),
    );
    expect(summary).toContain("Implementing");
    expect(summary).toContain("Needs human disposition");
    expect(summary).toContain("Validation failed twice");
  });

  it("summarises a run stop without inventing data", () => {
    const summary = issueEventSummary(
      event("run.state_changed", {
        run_id: "run_1",
        state: "stopped",
        stop_reason: "Policy stop",
      }),
    );
    expect(summary).toBe("Run run_1 is Stopped. Stop reason: Policy stop");
  });

  it("renders an unknown event type explicitly instead of guessing", () => {
    expect(issueEventLabel("future.signal")).toBe("Unrecognized event (future.signal)");
    const summary = issueEventSummary(event("future.signal", { anything: true }));
    expect(summary).toContain("Unrecognized event type future.signal");
  });

  it("falls back to the label for a known event without a documented payload", () => {
    expect(issueEventSummary(event("approval.decided", {}))).toBe("Approval decided recorded.");
  });
});
