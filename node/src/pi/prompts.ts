import type { DshGrantSummary } from "../dsh/types.js";

/**
 * System prompt for the remediation agent.
 *
 * States the authority boundary the whole milestone rests on: Pi holds no
 * executor, and every action is an intent that dsh re-checks independently.
 */
export function piSystemPrompt(): string {
  return [
    "You are the ForgePilot remediation agent. You prepare auditable, bounded",
    "repository changes without bypassing repository governance.",
    "",
    "You have two tools and exactly one action capability: dsh_request_action.",
    "You cannot run commands, edit files, read the filesystem, or reach the",
    "network directly, and you must never pretend otherwise. Every action you",
    "want becomes one dsh_request_action call carrying a registered tool id,",
    "structured arguments, the repository-relative paths it touches, and a",
    "rationale.",
    "",
    "The second tool, report_turn_summary, executes nothing: it records a",
    "structured report of a turn's work for display. Its parameters are closed",
    "enums with no free-text field; only a recorded report is ever displayed,",
    "and the free text you write is never shown to anyone.",
    "",
    "The dsh control plane independently checks each request against this run's",
    "allow-list and capability grant before anything executes. A denial is final",
    "for that intent: it means the request was outside the grant. Do not retry a",
    "denied intent unchanged, do not try to work around a denial, and do not ask",
    "for tools you were not given. When the task is done, or when you cannot",
    "proceed within the grant, say so plainly and stop.",
  ].join("\n");
}

export interface TaskPromptInput {
  summary: string;
  sourceReference: string | null;
  acceptanceCriteria: string[];
  repositoryId: string;
  baseRef: string;
  baseSha: string;
  grant: DshGrantSummary;
}

/** Build the task prompt bound to the exact grant dsh issued. */
export function taskPrompt(input: TaskPromptInput): string {
  const lines = [
    `Task for repository ${input.repositoryId} at ${input.baseRef} (${input.baseSha}).`,
    "",
    `Summary: ${input.summary}`,
  ];
  if (input.sourceReference) {
    lines.push(`Source reference: ${input.sourceReference}`);
  }
  if (input.acceptanceCriteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const criterion of input.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  const tools = input.grant.permitted_tools
    .map((tool) => `${tool.identity} (allowed arguments: ${tool.allowed_arguments.join(", ")})`)
    .join("; ");
  lines.push(
    "",
    "This run's capability grant, issued and enforced by dsh:",
    `- permitted tools: ${tools}`,
    `- permitted paths: ${input.grant.permitted_paths.join(", ")}`,
    `- expires at: ${input.grant.expires_at}`,
    `- maximum wall clock: ${input.grant.max_wall_clock_seconds} seconds`,
    "",
    "Work only through dsh_request_action, only within this grant. Finish every",
    "turn by calling report_turn_summary once: use its closed vocabulary to",
    "describe the specific work of the turn — what you did, to which parts, and",
    "how it ended. Only that structured report becomes a displayable summary;",
    "the free text you write is never displayed, and a turn without a valid",
    "report shows no summary.",
  );
  return lines.join("\n");
}
