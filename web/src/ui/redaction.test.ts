import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import { buildTimelineRows, eventSummary, piTurnSummary } from "./format";
import { redactText, sanitizeValue } from "./redaction";

describe("redaction", () => {
  it("removes credentials and local paths from user-facing text", () => {
    expect(
      redactText("Bearer ghp_12345 token=abc /Users/alice/project/file.ts C:\\work\\secret.txt"),
    ).toBe("Bearer [redacted] token: [redacted] [path redacted] [path redacted]");
  });

  it("sanitizes nested artifact values", () => {
    expect(
      sanitizeValue({
        output: "/home/alice/task",
        nested: ["sk-live_abc"],
        command: "git diff --stat",
        stdout: "raw log output",
        logs: "an unredacted log line",
      }),
    ).toEqual({
      output: "[redacted]",
      nested: ["[redacted]"],
      command: "[redacted]",
      stdout: "[redacted]",
      logs: "[redacted]",
    });
  });

  it("redacts generic Unix paths and shell commands", () => {
    expect(redactText("run git status in /etc/example and /srv/forgepilot")).toBe(
      "run [command redacted]",
    );
    expect(redactText("/secret")).toBe("[path redacted]");
    expect(redactText("echo hello")).toBe("[command redacted]");
  });

  it("never renders raw Pi text that was split across streaming deltas", () => {
    const first = {
      event_id: "evt_1",
      sequence: 1,
      occurred_at: "2026-10-27T00:00:00Z",
      task_id: "tsk_1",
      task_version: 1,
      type: "pi.text_delta",
      data: { delta: "Output: Bearer ghp_" },
    } as TaskEvent;
    const second = {
      ...first,
      event_id: "evt_2",
      sequence: 2,
      data: { delta: "secret123 and /sec" },
    } as TaskEvent;
    const rows = buildTimelineRows([first, second]);
    const [turn] = rows;

    const rendered = [
      eventSummary(first),
      ...(turn?.kind === "pi_turn" ? [piTurnSummary(turn)] : []),
    ].join(" ");
    expect(rendered).toContain("hidden for safety");
    expect(rendered).not.toContain("ghp_");
    expect(rendered).not.toContain("/sec");
  });
});
