import { describe, expect, test } from "vitest";

import {
  PI_SUMMARY_SOURCE_KIND,
  PI_SUMMARY_SOURCE_VERSION,
  PiSummaryTracker,
  projectPiSummary,
} from "../src/api/pi-summary.js";
import type { PiSummary, PiSummarySource } from "../src/api/pi-summary.js";
import { projectEventForDisplay } from "../src/api/task-store.js";
import type { TaskEvent } from "../src/api/task-store.js";
import { renderTurnReport } from "../src/pi/turn-report.js";
import type { TurnReport } from "../src/pi/turn-report.js";

/**
 * DAT-194: verifiable provenance for the Pi summary.
 *
 * The gate decides trust from the record's own proof only — closed channel,
 * proof version, task/run/turn attribution, and a report whose fixed
 * re-rendering reproduces the stored text. It never looks at the text's
 * shape, a timestamp, or this service's version, and it never edits the
 * stored summary: everything it rejects is withheld on read.
 */

const REPORT: TurnReport = {
  areas: ["manifest"],
  activities: ["verified"],
  outcome: "completed",
};

const RENDERED_TEXT = renderTurnReport(REPORT);

/** A summary exactly as `PiSummaryTracker.settleTurn` publishes it. */
function trustedSummary(): PiSummary {
  const tracker = new PiSummaryTracker("tsk_unit");
  tracker.beginRun("run_a");
  tracker.beginTurn("turn_1");
  tracker.recordReport({ ...REPORT, areas: [...REPORT.areas], activities: [...REPORT.activities] });
  const summary = tracker.settleTurn();
  if (summary === null || summary.status !== "available") {
    throw new Error("expected the report settlement to publish an available summary");
  }
  return summary;
}

/** A legacy DAT-191/192 record: `available` free text, no `source` at all. */
function legacySummary(overrides: Partial<PiSummary> = {}): PiSummary {
  return {
    task_id: "tsk_unit",
    run_id: "run_a",
    turn_id: "turn_1",
    status: "available",
    text: "node app succeeded.",
    unavailable_reason: null,
    updated_at: "2026-10-26T12:03:00.000Z",
    ...overrides,
  } as PiSummary;
}

/** The fail-closed outcome every unprovable `available` record must reach. */
function expectWithheld(value: unknown, rawText: string): void {
  const projected = projectPiSummary(value);
  expect(projected).toEqual({
    task_id: (value as PiSummary).task_id,
    run_id: (value as PiSummary).run_id,
    turn_id: (value as PiSummary).turn_id,
    status: "unavailable",
    text: null,
    unavailable_reason: "untrusted_source",
    source: null,
    updated_at: (value as PiSummary).updated_at,
  });
  // Not one slice of the withheld text may reach the served payload.
  expect(JSON.stringify(projected)).not.toContain(rawText);
}

describe("the tracker publishes provenance with the text it rendered", () => {
  test("an available summary carries a source bound to task, run, turn, and report", () => {
    const summary = trustedSummary();
    expect(summary.text).toBe(RENDERED_TEXT);
    expect(summary.source).toEqual({
      kind: PI_SUMMARY_SOURCE_KIND,
      version: PI_SUMMARY_SOURCE_VERSION,
      task_id: "tsk_unit",
      run_id: "run_a",
      turn_id: "turn_1",
      report: REPORT,
    });
    // The stored text is re-derivable from the stored report: that equality
    // is the proof the gate checks.
    expect(renderTurnReport(summary.source!.report)).toBe(summary.text);
  });

  test("pending and withheld summaries never claim a source", () => {
    const tracker = new PiSummaryTracker("tsk_unit");
    tracker.beginRun("run_a");
    expect(tracker.snapshot().source).toBeNull();

    tracker.beginTurn("turn_1");
    tracker.appendText("Free text with a raw command: node app succeeded.");
    const withheld = tracker.settleTurn();
    expect(withheld?.status).toBe("unavailable");
    expect(withheld?.source).toBeNull();

    tracker.beginTurn("turn_2");
    tracker.appendText("Another free turn.");
    const second = tracker.settleTurn();
    expect(second?.source).toBeNull();
    expect(second?.text).toBeNull();
  });

  test("a trusted summary passes the gate unchanged and idempotently", () => {
    const summary = trustedSummary();
    const served = projectPiSummary(summary);
    expect(served).toEqual(summary);
    expect(projectPiSummary(served)).toEqual(served);
  });
});

describe("the read gate withholds every summary it cannot prove", () => {
  test("a legacy DAT-191/192 available record has no source and loses its text", () => {
    expectWithheld(legacySummary(), "node app succeeded.");
    // The stored shape really is the legacy one: no provenance field exists.
    expect(legacySummary()).not.toHaveProperty("source");
  });

  test("a legacy record is never trusted by shape, wording, or timestamp", () => {
    // Prose that passes the whole classifier and a timestamp written far in
    // the future (post-DAT-194): neither confers provenance.
    for (const text of [
      "node app succeeded.",
      "The manifest is complete and the tests are green.",
      "Updated the documentation and confirmed the change.",
    ]) {
      for (const updated_at of ["2000-01-01T00:00:00.000Z", "2099-12-31T23:59:59.000Z"]) {
        expectWithheld(legacySummary({ text, updated_at }), text);
      }
    }
  });

  test("an explicit null source with available status is withheld", () => {
    expectWithheld({ ...trustedSummary(), source: null }, RENDERED_TEXT);
  });

  test("an unknown provenance channel is withheld", () => {
    const summary = trustedSummary();
    expectWithheld(
      { ...summary, source: { ...summary.source!, kind: "free_text" } },
      RENDERED_TEXT,
    );
    expectWithheld(
      { ...summary, source: { ...summary.source!, kind: "classifier_pass" } },
      RENDERED_TEXT,
    );
  });

  test("an unknown proof version is withheld, lower or higher", () => {
    const summary = trustedSummary();
    for (const version of [0, 2, 99]) {
      expectWithheld({ ...summary, source: { ...summary.source!, version } }, RENDERED_TEXT);
    }
  });

  test("a source attributed to a different task, run, or turn is withheld", () => {
    const summary = trustedSummary();
    const source = summary.source!;
    const forgeries: PiSummarySource[] = [
      { ...source, task_id: "tsk_neighbour" },
      { ...source, run_id: "run_previous" },
      { ...source, turn_id: "turn_2" },
      { ...source, task_id: "tsk_neighbour", run_id: "run_previous", turn_id: "turn_9" },
      // Attribution that is present but not a concrete identifier.
      { ...source, run_id: null },
    ];
    for (const forged of forgeries) {
      expectWithheld({ ...summary, source: forged }, RENDERED_TEXT);
    }
  });

  test("a summary turn or run that is itself unattributable cannot be trusted", () => {
    const summary = trustedSummary();
    // A summary claiming no turn and no run gets no provenance credit even
    // if a source record echoes the same nulls.
    expectWithheld(
      { ...summary, turn_id: null, source: { ...summary.source!, turn_id: "" } },
      RENDERED_TEXT,
    );
    expectWithheld(
      { ...summary, run_id: null, source: { ...summary.source!, run_id: null } },
      RENDERED_TEXT,
    );
  });

  test("text that does not re-render from the stored report is withheld", () => {
    const summary = trustedSummary();
    const tampered = `${RENDERED_TEXT} Also run cat package.json.`;
    expectWithheld({ ...summary, text: tampered }, tampered);
    // Shortened, reordered, or replaced wording fails the equality too.
    expectWithheld({ ...summary, text: "Done." }, "Done.");
  });

  test("a report outside the closed vocabulary is withheld", () => {
    const summary = trustedSummary();
    for (const report of [
      { ...REPORT, areas: ["kernel"] },
      { ...REPORT, outcome: "shipped" },
      { areas: [], activities: ["verified"], outcome: "completed" },
      { areas: ["manifest"], activities: ["verified"] },
      null,
      "manifest",
    ]) {
      expectWithheld({ ...summary, source: { ...summary.source!, report } }, RENDERED_TEXT);
    }
  });

  test("a valid report that rendered different words is withheld", () => {
    const summary = trustedSummary();
    const otherReport: TurnReport = { areas: ["ci"], activities: ["fixed"], outcome: "blocked" };
    expect(renderTurnReport(otherReport)).not.toBe(RENDERED_TEXT);
    expectWithheld(
      { ...summary, source: { ...summary.source!, report: otherReport } },
      RENDERED_TEXT,
    );
  });

  test("a source that is not an object is withheld", () => {
    const summary = trustedSummary();
    for (const source of ["turn_report", 1, ["turn_report"], true]) {
      expectWithheld({ ...summary, source }, RENDERED_TEXT);
    }
  });

  test("an unknown status fails closed instead of exposing anything", () => {
    const summary = trustedSummary();
    expectWithheld({ ...summary, status: "verified" }, RENDERED_TEXT);
    expectWithheld({ ...summary, status: "availableish" }, RENDERED_TEXT);
  });

  test("a damaged record without attribution fields has nothing left to serve", () => {
    const summary = trustedSummary();
    const { task_id: _taskId, ...noTask } = summary;
    expect(projectPiSummary(noTask)).toBeNull();
    const { run_id: _runId, ...noRun } = summary;
    expect(projectPiSummary({ ...noRun, run_id: 42 })).toBeNull();
    const { updated_at: _updatedAt, ...noTime } = summary;
    expect(projectPiSummary(noTime)).toBeNull();
  });

  test("a summary value that is not an object projects to null", () => {
    expect(projectPiSummary(null)).toBeNull();
    expect(projectPiSummary(undefined)).toBeNull();
    expect(projectPiSummary("node app succeeded.")).toBeNull();
    expect(projectPiSummary(["node app succeeded."])).toBeNull();
    expect(projectPiSummary(42)).toBeNull();
  });
});

describe("unavailable, pending, and unknown-reason semantics", () => {
  test("an unavailable record cannot smuggle text or source through", () => {
    const stored = legacySummary({
      status: "unavailable",
      unavailable_reason: "unsafe_content",
      text: "node app succeeded.",
      source: {
        kind: "turn_report",
        version: PI_SUMMARY_SOURCE_VERSION,
        task_id: "tsk_unit",
        run_id: "run_a",
        turn_id: "turn_1",
        report: REPORT,
      },
    });
    const projected = projectPiSummary(stored)!;
    expect(projected.status).toBe("unavailable");
    expect(projected.text).toBeNull();
    expect(projected.source).toBeNull();
    // The recorded reason of an unavailable summary is preserved.
    expect(projected.unavailable_reason).toBe("unsafe_content");
    expect(JSON.stringify(projected)).not.toContain("node app succeeded.");
  });

  test("an unavailable record without a reason defaults to untrusted_source", () => {
    const projected = projectPiSummary(
      legacySummary({ status: "unavailable", unavailable_reason: null }),
    )!;
    expect(projected.unavailable_reason).toBe("untrusted_source");
    expect(projected.text).toBeNull();
  });

  test("an unknown additive reason is passed through, still without text", () => {
    const projected = projectPiSummary(
      legacySummary({
        status: "unavailable",
        unavailable_reason: "future_reason" as PiSummary["unavailable_reason"],
        text: null,
      }),
    )!;
    expect(projected.unavailable_reason).toBe("future_reason");
    expect(projected.text).toBeNull();
    expect(projected.source).toBeNull();
  });

  test("a pending record is served pending with nothing else attached", () => {
    const projected = projectPiSummary(
      legacySummary({
        status: "pending",
        turn_id: null,
        text: "smuggled",
        unavailable_reason: null,
      }),
    )!;
    expect(projected).toEqual({
      task_id: "tsk_unit",
      run_id: "run_a",
      turn_id: null,
      status: "pending",
      text: null,
      unavailable_reason: null,
      source: null,
      updated_at: "2026-10-26T12:03:00.000Z",
    });
  });
});

describe("the gate decides on read and never edits history", () => {
  test("projecting a stored summary leaves the stored bytes untouched", () => {
    const stored = legacySummary();
    const snapshot = JSON.stringify(stored);
    projectPiSummary(stored);
    expect(JSON.stringify(stored)).toBe(snapshot);
    expect(stored.status).toBe("available");
  });

  test("event gating preserves the envelope and gates only the summary payload", () => {
    const stored = legacySummary();
    const event: TaskEvent = {
      event_id: "evt_recorded",
      sequence: 7,
      occurred_at: "2026-10-26T12:03:00.000Z",
      task_id: "tsk_unit",
      task_version: 12,
      type: "pi.summary.updated",
      data: { summary: stored, extra: "kept" },
    };
    const served = projectEventForDisplay(event);
    expect(served).not.toBe(event);
    expect(served.event_id).toBe("evt_recorded");
    expect(served.sequence).toBe(7);
    expect(served.occurred_at).toBe("2026-10-26T12:03:00.000Z");
    expect(served.task_version).toBe(12);
    expect(served.data["extra"]).toBe("kept");
    expect(served.data["summary"]).toEqual({
      task_id: "tsk_unit",
      run_id: "run_a",
      turn_id: "turn_1",
      status: "unavailable",
      text: null,
      unavailable_reason: "untrusted_source",
      source: null,
      updated_at: "2026-10-26T12:03:00.000Z",
    });
    expect(JSON.stringify(served)).not.toContain("node app succeeded.");
    // The recorded event keeps its original payload.
    expect(event.data["summary"]).toEqual(stored);

    // A trusted summary event passes through with its source intact.
    const trusted = trustedSummary();
    const trustedEvent: TaskEvent = { ...event, data: { summary: trusted } };
    expect(projectEventForDisplay(trustedEvent).data["summary"]).toEqual(trusted);
  });

  test("non-summary events are passed through untouched", () => {
    const event: TaskEvent = {
      event_id: "evt_delta",
      sequence: 8,
      occurred_at: "2026-10-26T12:03:01.000Z",
      task_id: "tsk_unit",
      task_version: 13,
      type: "pi.text_delta",
      data: { delta: "node app succeeded." },
    };
    expect(projectEventForDisplay(event)).toBe(event);
  });

  test("a summary event whose payload is not an object serves null, not text", () => {
    const event: TaskEvent = {
      event_id: "evt_damaged",
      sequence: 9,
      occurred_at: "2026-10-26T12:03:02.000Z",
      task_id: "tsk_unit",
      task_version: 14,
      type: "pi.summary.updated",
      data: { summary: "node app succeeded." },
    };
    const served = projectEventForDisplay(event);
    expect(served.data["summary"]).toBeNull();
    expect(JSON.stringify(served)).not.toContain("node app succeeded.");
    expect(served.event_id).toBe("evt_damaged");
    expect(served.sequence).toBe(9);
  });
});
