import { describe, expect, test } from "vitest";

import {
  evaluateTurnText,
  excerptTurnText,
  firstSafetyViolation,
  PI_SUMMARY_MAX_CHARS,
  PI_SUMMARY_SAFETY_RULES,
  PI_SUMMARY_UNAVAILABLE_REASONS,
  PiSummaryTracker,
} from "../src/api/pi-summary.js";
import type { PiSummarySafetyRule } from "../src/api/pi-summary.js";

/**
 * Credential-shaped examples assembled at runtime: GitHub push protection
 * rejects commits containing complete token literals even when they are
 * fabricated test data, while the gate must still see each value as one
 * whole string.
 */
const SLACK_TOKEN_EXAMPLE = ["xox", "b-1234567890-abcde", "fghijklmnop"].join("");
const GITLAB_TOKEN_EXAMPLE = ["glpat-", "WjU2sNvwTkyiD", "xxxYyyy"].join("");
const STRIPE_KEY_EXAMPLE = ["sk_live_", "51H8xYzAbCdEfGhIjKlMnOpQrStUv"].join("");
const TWILIO_KEY_EXAMPLE = ["SK", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"].join("");

/** A settled summary must never echo any slice of the raw turn text. */
function expectNoLeak(serialized: string, rawTurnText: string): void {
  const slices = [rawTurnText];
  for (let size = 4; size <= Math.min(rawTurnText.length, 24); size += 4) {
    for (let start = 0; start + size <= rawTurnText.length; start += 7) {
      slices.push(rawTurnText.slice(start, start + size));
    }
  }
  for (const slice of slices) {
    if (/[A-Za-z0-9]/.test(slice)) {
      expect(serialized).not.toContain(slice);
    }
  }
}

describe("safety gate: accepted real Pi content", () => {
  test("a benign turn yields an available summary with the actual Pi content", () => {
    const evaluation = evaluateTurnText(
      "Checked the echo tool and confirmed it prints hello. The patch is ready for review.",
    );
    expect(evaluation).toEqual({
      outcome: "available",
      text: "Checked the echo tool and confirmed it prints hello. The patch is ready for review.",
    });
  });

  test("repo-relative paths and prose punctuation are allowed", () => {
    const evaluation = evaluateTurnText(
      "Updated node/src/api/task-service.ts and web/src/ui/format.ts to fix the export.",
    );
    expect(evaluation.outcome).toBe("available");
  });

  test("the excerpt is the first paragraph, single-spaced", () => {
    expect(excerptTurnText("First line\ncontinues here.\n\nSecond paragraph.")).toBe(
      "First line continues here.",
    );
  });

  test("long turns are truncated at the bound, at a word boundary", () => {
    const long = `${"word ".repeat(120)}end.`;
    const excerpt = excerptTurnText(long);
    expect(excerpt.length).toBeLessThanOrEqual(PI_SUMMARY_MAX_CHARS);
    expect(excerpt.endsWith("...")).toBe(true);
    expect(excerpt.startsWith("word word word")).toBe(true);
  });
});

describe("safety gate: fail-closed rules", () => {
  const unsafeTurns: Array<[label: string, rule: string, text: string]> = [
    ["provider API key", "secret_material", "The key sk-abc123def456ghi789jkl0 was used."],
    ["GitHub token", "secret_material", "Found ghp_1234567890abcdefghij1234567890ab in a file."],
    ["GitHub PAT", "secret_material", "Rotated github_pat_11ABCDEFGHijklMNOPQRSTUVWXYZ12 now."],
    ["AWS access key", "secret_material", "The instance used AKIAIOSFODNN7EXAMPLE."],
    [
      "AWS secret access key",
      "high_entropy",
      "The secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY rotated.",
    ],
    ["Stripe live key", "secret_material", `Used ${STRIPE_KEY_EXAMPLE} for billing.`],
    [
      "Google API key",
      "secret_material",
      "Configured AIzaSy000000000000000000000000000000000 in the client.",
    ],
    ["npm token", "secret_material", "Published with npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789."],
    [
      "docker basic-auth blob",
      "high_entropy",
      "Header was dXNlcjpwYXNzd29yZDEyMzQ1Njc4OTA= and then stopped.",
    ],
    [
      "sendgrid key",
      "secret_material",
      "Send SG.x1y2z3a4b5c6d7e8f9g0h1.ijklmnopqrst0123456789 via mail.",
    ],
    ["datadog key", "secret_material", "Ship dop_v1_abcdef1234567890ABCD to the agent."],
    ["legacy sk hex key", "secret_material", `Legacy ${TWILIO_KEY_EXAMPLE} was kept.`],
    ["Slack token", "secret_material", `Leaked ${SLACK_TOKEN_EXAMPLE} in chat.`],
    ["GitLab token", "secret_material", `Saw ${GITLAB_TOKEN_EXAMPLE} in the log output.`],
    [
      "private key block",
      "secret_material",
      "The file contains -----BEGIN RSA PRIVATE KEY----- material.",
    ],
    ["bearer header", "secret_material", "Sent Authorization: Bearer abcdef123456 upstream."],
    ["credential assignment", "secret_material", "The env showed api_key=supersecretvalue123."],
    ["fenced code block", "shell_command", "Summary:\n```sh\nnpm run build\n```\ndone."],
    [
      "command code span",
      "shell_command",
      "Ran `git status --porcelain` and `ls | wc -l` earlier.",
    ],
    ["executable code span", "shell_command", "The step `npm ci --no-audit` completed."],
    [
      "shell prompt line",
      "shell_command",
      "Output was:\n$ sudo rm -rf /var/cache\nfollowed by ok.",
    ],
    ["plain command", "shell_command", "You should curl https://example.invalid for details."],
    ["git subcommand in prose", "shell_command", "I ran git status in the repository."],
    ["npm subcommand in prose", "shell_command", "I ran npm test after the change."],
    ["rm invocation in prose", "shell_command", "I ran rm -rf node_modules and rebuilt."],
    [
      "macOS absolute path",
      "absolute_path",
      "The file at /Users/ludwig/work/repo/node/x.ts was changed.",
    ],
    [
      "linux absolute path",
      "absolute_path",
      "Copied from /home/runner/work/cache/artifact to the repo.",
    ],
    [
      "windows absolute path",
      "absolute_path",
      "Looked at C:\\Users\\ludwig\\code\\AutoFixer\\main.go.",
    ],
    ["usr absolute path", "absolute_path", "Run by /usr/local/bin/node during the turn."],
    ["bin absolute path", "absolute_path", "The path /bin/sh."],
    [
      "library absolute path",
      "absolute_path",
      "Config lives in /Library/Application Support/AutoFixer/settings.json.",
    ],
    [
      "node stack trace",
      "raw_log",
      "Failed.\n    at Object.<anonymous> (/repo/index.js:10:5)\nbye.",
    ],
    ["log level line", "raw_log", "Output:\nERROR database connection refused\nbye."],
    ["bracketed log level", "raw_log", "Output:\n[2026-10-27] INFO starting worker\nbye."],
    ["log timestamp", "raw_log", "Last seen at 2026-10-27T12:00:00Z before the crash."],
    ["traceback", "raw_log", "It failed with Traceback (most recent call last):\nthen stopped."],
    [
      "diagnostic line without a level",
      "raw_log",
      "output: fatal: not a git repository (or any of the parent directories): .git",
    ],
    ["hex digest", "high_entropy", "The head is 9ef01234567890abcdef9ef01234567890abcdef."],
    [
      "base64 blob",
      "high_entropy",
      "Payload YSBmYWlybHkgbG9uZyBvcGFxdWUgYmxvYiBvZiBieXRlcyB0aGF0IG5vIGh1bWFuIHdvdWxkIHdyaXRlIGEgZmFpcmx5IGxvbmcgb3BhcXVlIGJsb2Igb2YgYnl0ZXMgdGhhdCBubyBodW1hbiB3b3VsZCB3cml0ZSA= was stored.",
    ],
    ["ansi escape", "raw_log", `Printed ${"\u001b"}[31mred error${"\u001b"}[0m and then stopped.`],
  ];

  for (const [label, rule, text] of unsafeTurns) {
    test(`${label} fails closed as ${rule}`, () => {
      const evaluation = evaluateTurnText(text);
      expect(evaluation).toEqual({ outcome: "unavailable", reason: "unsafe_content" });
      const violation = firstSafetyViolation(text);
      expect(violation?.code).toBe(rule);
      // Unavailable outcomes must not carry the raw text, not even a slice.
      expectNoLeak(JSON.stringify(evaluation), text);
    });
  }

  test("unsafe material anywhere in the turn fails the whole turn", () => {
    const evaluation = evaluateTurnText(
      "Harmless introduction paragraph.\n\nSecond paragraph mentions ghp_abcdefghijklmnopqrstuvwx123456 later on.",
    );
    expect(evaluation).toEqual({ outcome: "unavailable", reason: "unsafe_content" });
  });

  test("an empty or whitespace-only turn is unavailable with no_content", () => {
    for (const text of ["", "   \n\t  ", "\n\n\n"]) {
      expect(evaluateTurnText(text)).toEqual({ outcome: "unavailable", reason: "no_content" });
    }
  });

  test("a gate failure fails closed as gate_error", () => {
    const exploding: PiSummarySafetyRule = {
      code: "boom",
      keepsOut: "always throws",
      pattern: {
        test() {
          throw new Error("gate exploded");
        },
      } as unknown as RegExp,
    };
    expect(evaluateTurnText("Perfectly benign text", [exploding])).toEqual({
      outcome: "unavailable",
      reason: "gate_error",
    });
  });

  test("a paren-heavy pathological line is judged in linear time (QA B4)", () => {
    // 40,003 bytes: "at " + 20k open parens + 20k x. The stack-frame branch
    // must not pair [^\\n]* with [^)\\n]* (quadratic backtracking took ~500ms
    // on this input before the fix; settlement runs on the event loop).
    const pathological = `at ${"(".repeat(20_000)}${"x".repeat(20_000)}`;
    expect(pathological).toHaveLength(40_003);
    const started = performance.now();
    const evaluation = evaluateTurnText(pathological);
    const elapsed = performance.now() - started;
    // The x-run fails closed as opaque material; the point is the time bound.
    expect(evaluation).toEqual({ outcome: "unavailable", reason: "unsafe_content" });
    expect(elapsed, `evaluateTurnText took ${elapsed.toFixed(1)}ms`).toBeLessThan(250);
  });

  test("the gate verdict depends only on the rule table", () => {
    expect(PI_SUMMARY_SAFETY_RULES.map((rule) => rule.code)).toEqual([
      "secret_material",
      "shell_command",
      "absolute_path",
      "raw_log",
      "high_entropy",
    ]);
    const evaluation = evaluateTurnText("mentions ghp_abcdefghijklmnopqrstuvwx123456 inline");
    expect(evaluation).toEqual({ outcome: "unavailable", reason: "unsafe_content" });
    if (evaluation.outcome === "unavailable") {
      expect(PI_SUMMARY_UNAVAILABLE_REASONS).toContain(evaluation.reason);
    }
  });
});

describe("safety gate: cross-fragment assembly", () => {
  test("a token split across deltas is caught once assembled", () => {
    const tracker = new PiSummaryTracker("tsk_unit");
    tracker.beginRun("run_a");
    tracker.beginTurn("turn_1");
    // Streamed as three fragments; no fragment alone looks like a token.
    for (const fragment of ["The credential sk-", "abc123def456ghi7", "8jkl012345 was leaked."]) {
      tracker.appendText(fragment);
    }
    const summary = tracker.settleTurn();
    expect(summary).toMatchObject({
      status: "unavailable",
      unavailable_reason: "unsafe_content",
    });
    expectNoLeak(JSON.stringify(summary), "sk-abc123def456ghi78jkl012345");
  });

  test("an absolute path split across deltas is caught once assembled", () => {
    const tracker = new PiSummaryTracker("tsk_unit");
    tracker.beginRun("run_a");
    tracker.beginTurn("turn_1");
    for (const fragment of ["Edited /Us", "ers/ludwig/worksp", "ace/repo/node/src/x.ts today."]) {
      tracker.appendText(fragment);
    }
    const summary = tracker.settleTurn();
    expect(summary?.status).toBe("unavailable");
    expectNoLeak(JSON.stringify(summary), "/Users/ludwig/workspace/repo/node/src/x.ts");
  });

  test("a benign turn streamed in fragments stays available", () => {
    const tracker = new PiSummaryTracker("tsk_unit");
    tracker.beginRun("run_a");
    tracker.beginTurn("turn_1");
    for (const fragment of ["Verified the ", "export ", "flow end to end."]) {
      tracker.appendText(fragment);
    }
    expect(tracker.settleTurn()).toMatchObject({
      status: "available",
      text: "Verified the export flow end to end.",
    });
  });
});

describe("PiSummaryTracker lifecycle and attribution", () => {
  function newTracker(taskId = "tsk_unit", runId = "run_a"): PiSummaryTracker {
    const tracker = new PiSummaryTracker(taskId, {
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    tracker.beginRun(runId);
    return tracker;
  }

  test("starts pending with run attribution and no turn or text", () => {
    const summary = newTracker().snapshot();
    expect(summary).toEqual({
      task_id: "tsk_unit",
      run_id: "run_a",
      turn_id: null,
      status: "pending",
      text: null,
      unavailable_reason: null,
      updated_at: "2099-01-01T00:00:00.000Z",
    });
  });

  test("deltas appended before a turn opens are dropped, not judged", () => {
    const tracker = newTracker();
    tracker.appendText("secret ghp_abcdefghijklmnopqrstuvwx123456 before any turn");
    // No open turn: nothing to settle, and the pending projection stands.
    expect(tracker.settleTurn()).toBeNull();
    expect(tracker.snapshot().status).toBe("pending");
  });

  test("a duplicate settlement call publishes nothing (QA B3)", () => {
    const tracker = newTracker();
    tracker.beginTurn("turn_1");
    tracker.appendText("First turn summary text.");
    const first = tracker.settleTurn();
    expect(first).toMatchObject({ status: "available", text: "First turn summary text." });
    // The agent_error + agent_settled double emission must not re-publish:
    // the second call reports that no turn was settled instead.
    expect(tracker.settleTurn()).toBeNull();
    expect(tracker.snapshot()).toEqual(first);
  });

  test("each settled turn replaces the previous summary", () => {
    const tracker = newTracker();
    tracker.beginTurn("turn_1");
    tracker.appendText("First settled turn.");
    expect(tracker.settleTurn()).toMatchObject({
      turn_id: "turn_1",
      status: "available",
      text: "First settled turn.",
    });
    tracker.beginTurn("turn_2");
    tracker.appendText("Turn two mentions nothing sensitive.");
    expect(tracker.settleTurn()).toMatchObject({
      turn_id: "turn_2",
      status: "available",
      text: "Turn two mentions nothing sensitive.",
    });
    expect(JSON.stringify(tracker.snapshot())).not.toContain("First settled turn.");
  });

  test("an unsafe turn replaces a previously available summary without leaking", () => {
    const tracker = newTracker();
    tracker.beginTurn("turn_1");
    tracker.appendText("Clean first summary.");
    tracker.settleTurn();
    tracker.beginTurn("turn_2");
    tracker.appendText("Now I echo password=hunter2secret here.");
    const summary = tracker.settleTurn();
    expect(summary?.status).toBe("unavailable");
    expect(summary?.text).toBeNull();
    expectNoLeak(JSON.stringify(summary), "password=hunter2secret");
  });

  test("a new run resets to pending and never inherits the earlier run's text", () => {
    const tracker = newTracker();
    tracker.beginTurn("turn_1");
    tracker.appendText("Run A summary that must not survive.");
    tracker.settleTurn();

    const reset = tracker.beginRun("run_b");
    expect(reset).toMatchObject({
      run_id: "run_b",
      turn_id: null,
      status: "pending",
      text: null,
      unavailable_reason: null,
    });
    expectNoLeak(JSON.stringify(tracker.snapshot()), "Run A summary that must not survive.");
  });

  test("summaries never cross task trackers", () => {
    const a = newTracker("tsk_a", "run_a");
    a.beginTurn("turn_1");
    a.appendText("Task A content.");
    a.settleTurn();
    const b = newTracker("tsk_b", "run_b");
    expect(b.snapshot().task_id).toBe("tsk_b");
    expect(JSON.stringify(b.snapshot())).not.toContain("Task A content.");
  });

  test("snapshots are copies, not live state", () => {
    const tracker = newTracker();
    const snapshot = tracker.snapshot();
    (snapshot as { status: string }).status = "available";
    expect(tracker.snapshot().status).toBe("pending");
  });
});
