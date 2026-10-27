import { describe, expect, test } from "vitest";

import {
  TURN_REPORT_ACTIVITIES,
  TURN_REPORT_AREAS,
  TURN_REPORT_MAX_ITEMS,
  TURN_REPORT_OUTCOMES,
  TURN_REPORT_TOOL_NAME,
  renderTurnReport,
  turnReportSchema,
  validateTurnReport,
} from "../src/pi/turn-report.js";
import { createTurnSummaryReportTool } from "../src/pi/turn-report-tool.js";
import type { TurnReport, TurnReportParams } from "../src/pi/turn-report.js";
import { evaluateTurnReport, firstSafetyViolation } from "../src/api/pi-summary.js";
import { piSystemPrompt, taskPrompt } from "../src/pi/prompts.js";
import { createDshRequestActionTool } from "../src/pi/dsh-request-action-tool.js";
import type { DshClient } from "../src/dsh/client.js";
import type { DshGrantSummary } from "../src/dsh/types.js";

describe("structured Pi report schema (DAT-193 trusted source)", () => {
  test("every parameter is a closed enum with no free-text field", () => {
    expect(Object.keys(turnReportSchema.properties).sort()).toEqual([
      "activities",
      "areas",
      "outcome",
    ]);
    const schema = turnReportSchema.properties as Record<string, { enum?: readonly string[] }>;
    expect(schema["areas"]?.enum).toBeUndefined(); // arrays wrap the enum
    const areaItems = (turnReportSchema.properties["areas"] as { items: { enum: string[] } }).items;
    const activityItems = (
      turnReportSchema.properties["activities"] as {
        items: { enum: string[] };
      }
    ).items;
    expect(areaItems.enum).toEqual([...TURN_REPORT_AREAS]);
    expect(activityItems.enum).toEqual([...TURN_REPORT_ACTIVITIES]);
    expect((turnReportSchema.properties["outcome"] as { enum: string[] }).enum).toEqual([
      ...TURN_REPORT_OUTCOMES,
    ]);
    expect(TURN_REPORT_MAX_ITEMS).toBe(3);
    expect(TURN_REPORT_TOOL_NAME).toBe("report_turn_summary");
  });

  test("validation accepts a conforming report", () => {
    const report = validateTurnReport({
      areas: ["manifest", "tests"],
      activities: ["inspected", "verified"],
      outcome: "ready_for_review",
    });
    expect(report).toEqual({
      areas: ["manifest", "tests"],
      activities: ["inspected", "verified"],
      outcome: "ready_for_review",
    });
  });

  test("unknown, missing, or malformed reports fail closed as invalid", () => {
    const invalid: unknown[] = [
      null,
      undefined,
      "report",
      {},
      { areas: [], activities: ["inspected"], outcome: "completed" },
      { areas: ["manifest"], activities: [], outcome: "completed" },
      { areas: ["kernel"], activities: ["inspected"], outcome: "completed" },
      { areas: ["manifest"], activities: ["deployed"], outcome: "completed" },
      { areas: ["manifest"], activities: ["inspected"], outcome: "shipped" },
      { areas: ["manifest"], activities: ["inspected"] },
      { areas: ["manifest", "manifest"], activities: ["inspected"], outcome: "completed" },
      {
        areas: ["manifest", "tests", "source", "ci"],
        activities: ["inspected"],
        outcome: "completed",
      },
      { areas: "manifest", activities: ["inspected"], outcome: "completed" },
      // A smuggled free-text field is rejected outright, never ignored into
      // a render: the report must come from the closed vocabulary alone.
      {
        areas: ["manifest"],
        activities: ["inspected"],
        outcome: "completed",
        note: "run rm -rf /",
      },
    ];
    for (const params of invalid) {
      expect(validateTurnReport(params), JSON.stringify(params)).toBeNull();
    }
  });
});

describe("fixed-wording rendering (DAT-193)", () => {
  test("single, double, and triple lists render as one framed sentence", () => {
    expect(
      renderTurnReport({ areas: ["tests"], activities: ["verified"], outcome: "completed" }),
    ).toBe("Pi reported that it verified the tests and that the work is complete.");
    expect(
      renderTurnReport({
        areas: ["manifest", "lockfile"],
        activities: ["inspected", "updated"],
        outcome: "ready_for_review",
      }),
    ).toBe(
      "Pi reported that it inspected and updated the package manifest and the lockfile and that the change is ready for review.",
    );
    expect(
      renderTurnReport({
        areas: ["manifest", "lockfile", "types"],
        activities: ["inspected", "updated", "verified"],
        outcome: "needs_approval",
      }),
    ).toBe(
      "Pi reported that it inspected, updated, and verified the package manifest, the lockfile, and the type declarations and that the work needs human approval.",
    );
  });

  test("every vocabulary combination renders bounded, classifier-clean prose", () => {
    let checked = 0;
    for (const outcome of TURN_REPORT_OUTCOMES) {
      for (const activity of TURN_REPORT_ACTIVITIES) {
        for (const area of TURN_REPORT_AREAS) {
          const report: TurnReport = { areas: [area], activities: [activity], outcome };
          const evaluation = evaluateTurnReport(report);
          expect(evaluation.outcome).toBe("available");
          if (evaluation.outcome !== "available") {
            continue;
          }
          // Framed as Pi's report, bounded by the contract's 240-char cap,
          // and clean under the DAT-192 classifier (defence in depth).
          expect(evaluation.text.startsWith("Pi reported that it ")).toBe(true);
          expect(evaluation.text.length).toBeLessThanOrEqual(240);
          expect(evaluation.text.endsWith(".")).toBe(true);
          expect(firstSafetyViolation(evaluation.text)).toBeNull();
          checked += 1;
        }
      }
    }
    expect(checked).toBe(
      TURN_REPORT_OUTCOMES.length * TURN_REPORT_ACTIVITIES.length * TURN_REPORT_AREAS.length,
    );
  });

  test("an invalid report handed to the evaluator fails closed", () => {
    // Defence in depth: even if a non-conforming object reached the
    // evaluator (bypassing the tool), it never renders.
    const forged = {
      areas: ["kernel"],
      activities: ["deployed"],
      outcome: "shipped",
    } as unknown as TurnReport;
    expect(evaluateTurnReport(forged)).toEqual({
      outcome: "unavailable",
      reason: "untrusted_source",
    });
  });
});

describe("report_turn_summary tool (DAT-193)", () => {
  test("a valid report is validated and handed to the sink", async () => {
    const seen: TurnReport[] = [];
    const tool = createTurnSummaryReportTool({ onReport: (report) => seen.push(report) });
    const result = await tool.execute("call_1", {
      areas: ["documentation"],
      activities: ["documented"],
      outcome: "ready_for_review",
    });
    expect(seen).toEqual([
      { areas: ["documentation"], activities: ["documented"], outcome: "ready_for_review" },
    ]);
    expect(result.details).toEqual({ recorded: true });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  test("an invalid report throws and is never handed to the sink", async () => {
    const seen: TurnReport[] = [];
    const tool = createTurnSummaryReportTool({ onReport: (report) => seen.push(report) });
    await expect(
      tool.execute("call_2", {
        areas: ["manifest"],
        activities: ["inspected"],
        outcome: "done_for_good",
      } as unknown as TurnReportParams),
    ).rejects.toThrow(/closed vocabulary/);
    expect(seen).toEqual([]);
  });
});

describe("model-facing text composition (DAT-193)", () => {
  test("prompts and tool descriptions contain no concatenation artifacts", () => {
    const grant = {
      capability_grant_version: "1",
      issued_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-01T01:00:00Z",
      permitted_paths: ["node"],
      permitted_tools: [{ identity: "echo", allowed_arguments: ["message"] }],
      max_wall_clock_seconds: 60,
      scope_digest: "sha256:0",
    } satisfies DshGrantSummary;
    const reportTool = createTurnSummaryReportTool({ onReport: () => undefined });
    const dshTool = createDshRequestActionTool({
      client: {} as DshClient,
      runId: "run_x",
      sessionId: "pis_x",
      getTurnId: () => "turn_1",
      observe: () => undefined,
    });
    const task = taskPrompt({
      summary: "Verify the echo tool works",
      sourceReference: null,
      acceptanceCriteria: ["echo prints hello"],
      repositoryId: "github:Luthiel/AutoFixer",
      baseRef: "main",
      baseSha: "abc123",
      grant,
    });
    const composed = [piSystemPrompt(), task, reportTool.description, dshTool.description];
    for (const text of composed) {
      // A leftover unary `+` in a string concatenation would surface as a
      // literal "NaN" in model-facing text (a bug this suite already hit).
      expect(text).not.toContain("NaN");
      expect(text.length).toBeGreaterThan(50);
    }
    expect(piSystemPrompt()).toContain("report_turn_summary");
    expect(task).toContain("report_turn_summary");
  });
});
