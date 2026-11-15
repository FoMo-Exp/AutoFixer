import type { RuntimeDiagnostics } from "./diagnostics/runtime.js";
import { diagnoseEnvironment } from "./diagnostics/runtime.js";

/**
 * `forgepilot doctor` (DAT-257): a read-only, redacted report of the exact
 * deployment configuration and durable state this checkout would start with.
 *
 * Exit codes:
 *   0  startup, task, and model readiness are ready or merely degraded
 *   1  a readiness boundary is blocked (service can start, but the named work
 *      cannot: dsh unavailable, model egress denied, corrupt task projection)
 *   2  startup is blocked (invalid configuration / ambient credential bypass)
 *
 * It never creates, truncates, or repairs a state file, and it never prints a
 * token, credential, client secret, bootstrap secret, or key value.
 */

export const DOCTOR_EXIT = { ready: 0, blocked: 1, startup_blocked: 2 } as const;

/** Map a report to the documented doctor exit code. */
export function doctorExitCode(report: RuntimeDiagnostics): number {
  if (report.readiness.startup === "blocked") return DOCTOR_EXIT.startup_blocked;
  if (report.readiness.task === "blocked" || report.readiness.model === "blocked") {
    return DOCTOR_EXIT.blocked;
  }
  return DOCTOR_EXIT.ready;
}

function humanReport(report: RuntimeDiagnostics): string {
  const lines: string[] = [
    `ForgePilot runtime diagnostics (${report.service.version})`,
    `startup: ${report.readiness.startup}   task: ${report.readiness.task}   model: ${report.readiness.model}`,
    "",
  ];
  for (const entry of report.checks) {
    lines.push(
      `  ${entry.id.padEnd(12)} ${entry.status.padEnd(15)} ${entry.detail.split("\n")[0] ?? ""}`,
    );
    if (entry.detail.includes("\n")) {
      for (const extra of entry.detail.split("\n").slice(1)) {
        lines.push(`  ${" ".repeat(12)} ${" ".repeat(15)} ${extra}`);
      }
    }
  }
  if (report.blockers.length > 0) {
    lines.push("", `blockers: ${report.blockers.join(", ")}`);
    for (const entry of report.checks) {
      if (report.blockers.includes(entry.id) && entry.next_action !== null) {
        lines.push(`  ${entry.id}: ${entry.next_action}`);
      }
    }
  }
  const degraded = report.checks.filter(
    (entry) => entry.status === "degraded" && entry.next_action !== null,
  );
  if (degraded.length > 0) {
    lines.push("", "warnings:");
    for (const entry of degraded) lines.push(`  ${entry.id}: ${entry.next_action}`);
  }
  lines.push("", "notes:");
  for (const note of report.notes) lines.push(`  - ${note}`);
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: forgepilot-doctor [--json]\n\n" +
        "Read-only, redacted runtime configuration and readiness report.\n" +
        "Exit 0: ready/degraded; 1: a boundary is blocked; 2: startup is blocked.",
    );
    return DOCTOR_EXIT.ready;
  }
  const report = await diagnoseEnvironment(process.env, { includePaths: true });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(humanReport(report));
  }
  return doctorExitCode(report);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error("doctor failed:", error);
      process.exitCode = DOCTOR_EXIT.startup_blocked;
    },
  );
}
