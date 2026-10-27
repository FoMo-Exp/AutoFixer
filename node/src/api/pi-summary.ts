/**
 * Safe Pi text summary (forgepilot-api/v1 display contract).
 *
 * The raw `pi.text_delta` stream is free model text: it can interleave
 * secrets, commands, absolute workspace paths, or unredacted log output, and
 * the UI must never display it on the strength of client-side filtering
 * alone. This module is the Node-side, auditable summary source: it
 * accumulates the assistant text of one Pi turn, and at settlement runs the
 * whole assembled turn text through an ordered, reviewable safety-rule table
 * before anything is exposed as a summary.
 *
 * Fail-closed posture (DAT-191 acceptance 1):
 * - A summary is `available` only when the entire settled turn text passes
 *   every safety rule; the displayed text is a bounded excerpt of that same
 *   validated text.
 * - Any rule hit - or a failure inside the gate itself - yields an explicit
 *   `unavailable` summary whose `text` is always null. The turn's raw text is
 *   never copied into an unavailable summary, a timeline event, or the task
 *   projection, so no partial or transformed leak is possible.
 * - An unsettled turn is `pending`, never a summary.
 *
 * The rule table is deliberately regex-based and deterministic: every accept
 * or reject decision can be traced to a named rule, and no model, network
 * call, or widening permission is involved in judging the text.
 */

export const PI_SUMMARY_STATUSES = ["pending", "available", "unavailable"] as const;

export type PiSummaryStatus = (typeof PI_SUMMARY_STATUSES)[number];

export const PI_SUMMARY_UNAVAILABLE_REASONS = [
  /** The settled turn produced no displayable text at all. */
  "no_content",
  /** At least one safety rule matched the turn text; fail closed. */
  "unsafe_content",
  /** The safety gate itself could not complete a verdict; fail closed. */
  "gate_error",
] as const;

export type PiSummaryUnavailableReason = (typeof PI_SUMMARY_UNAVAILABLE_REASONS)[number];

/**
 * One display-safe summary of the latest settled Pi turn for a task's run.
 *
 * Lifecycle: absent (`null` on the task) until a Pi session exists for the
 * task; `pending` from session start until the first turn settles; then
 * exactly one of `available` / `unavailable` per settled turn, each new
 * settlement replacing the previous summary. `run_id` attributes the summary
 * to the run whose session produced it - a new run resets to `pending` and
 * never inherits a previous run's text.
 */
export interface PiSummary {
  task_id: string;
  run_id: string | null;
  /** Pi turn whose text this summary describes; null before any turn opens. */
  turn_id: string | null;
  status: PiSummaryStatus;
  /** The safe excerpt; non-null if and only if status is `available`. */
  text: string | null;
  /** Why the summary is unavailable; non-null iff status is `unavailable`. */
  unavailable_reason: PiSummaryUnavailableReason | null;
  updated_at: string;
}

/** Upper bound for one summary; longer turns are excerpted, never streamed. */
export const PI_SUMMARY_MAX_CHARS = 240;

export interface PiSummarySafetyRule {
  /** Stable rule identifier; the only detail an unavailable summary implies. */
  code: string;
  /** What the rule keeps out of displayable summaries. */
  keepsOut: string;
  pattern: RegExp;
}

/**
 * The ordered fail-closed rule table. Every rule is evaluated against the
 * fully assembled turn text, so material split across stream fragments (a
 * token broken between two deltas, a path broken across three) is judged only
 * in its assembled form and cannot slip through a fragment-level check.
 */
export const PI_SUMMARY_SAFETY_RULES: readonly PiSummarySafetyRule[] = [
  {
    code: "secret_material",
    keepsOut:
      "credential-shaped material: provider API keys and tokens (OpenAI/Anthropic-style sk-, " +
      "GitHub, AWS AKIA/ASIA, Slack, GitLab, Stripe sk_live/sk_test, Google AIza, npm, " +
      "SendGrid SG., Datadog dop_v1_, legacy SK hex), PEM private keys, authorization " +
      "headers, credential assignments",
    pattern:
      /\bsk-[A-Za-z0-9_-]{16,}|\bsk_(?:live|test)_[0-9A-Za-z]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bglpat-[A-Za-z0-9_-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|\bnpm_[0-9A-Za-z]{36}\b|\bSG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}|\bdop_v1_[0-9A-Za-z]{16,}|\bSK[0-9a-f]{32}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?key|password|passwd|private[_-]?key)\s*[:=]\s*\S{6,}/i,
  },
  {
    code: "shell_command",
    keepsOut:
      "raw command material: fenced code, command-shaped code spans, shell prompts, and bare invocations of shell utilities, interpreters, or git/package-manager/build subcommands",
    pattern:
      // Utilities take any argument; interpreters need a flag or file-shaped
      // argument so prose like "node is fast" stays displayable; subcommand
      // verbs (git/npm/...) need a real subcommand or flag, not any next word.
      /```[\s\S]*?```|`[^`\n]*[\s|&;>$][^`\n]*`|`(?:sudo|su|chmod|chown|rm|mv|cp|curl|wget|ssh|scp|rsync|sh|bash|zsh|python[23]?|node|npm|npx|pnpm|yarn|pip[3]?|docker|kubectl|git|systemctl|service|launchctl|make|cargo)\b[^`]*`|^\s*\$\s+\S|\b(?:sudo|su|chmod|chown|rm|mv|cp|curl|wget|ssh|scp|rsync|sh|bash|zsh|docker|kubectl|systemctl|launchctl)\s+\S|\b(?:python[23]?|node|java|ruby|perl|php|deno)\s+(?:-{1,2}\S|\S+\.(?:py|js|mjs|cjs|ts|tsx|sh|bash|rb|pl|php|jar|go|rs))|\b(?:npm|pnpm|yarn|bun|deno|pip[3]?|git|cargo|make|go)\s+(?:-{1,2}\S+|(?:status|add|commit|push|pull|fetch|clone|checkout|switch|restore|rebase|merge|log|diff|stash|branch|tag|reset|cherry-pick|worktree|blame|show|remote|revert|apply|init|bisect|clean|gc|config|install|i|ci|run|test|start|build|dev|serve|publish|exec|create|audit|link|unlink|outdated|pack|dlx|update|lint|fmt|vet|get|mod|generate|list|doc|check|clippy|new|all|dist|release|deploy|coverage|fix)\b)/i,
  },
  {
    code: "absolute_path",
    keepsOut:
      "absolute local filesystem paths (user home, workspace, and system roots) on any platform",
    pattern:
      /\/(?:Users|home|root|tmp|var|private|etc|opt|mnt|media|srv|proc|usr|bin|sbin|Library|System|Applications|Volumes|workspace|workdir)\/[A-Za-z0-9._-]+|[A-Za-z]:\\[^\s"']+/,
  },
  {
    code: "raw_log",
    keepsOut:
      "unredacted log and diagnostic output: stack traces, log-level lines, fatal:/error:-style diagnostics, ANSI escapes, log timestamps",
    pattern:
      // The stack branch uses [^()\n]* before the opening paren so a long
      // paren-heavy line stays linear (no backtracking blow-up on settlement).
      // eslint-disable-next-line no-control-regex -- the ESC byte itself is the signal: raw ANSI output must fail closed.
      /\x1b\[[0-9;]*[A-Za-z]|^\s*at\s+[^()\n]*\([^)\n]*:\d+:\d+\)|Traceback \(most recent call last\)|Exception in thread|^\s*Caused by:|^\s*(?:\[[^\]\n]+\]\s*)?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b[:\s]|\b(?:fatal|error|warning|critical)\s*:|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\b/m,
  },
  {
    code: "high_entropy",
    keepsOut:
      "opaque long strings (digests, hex blobs, base64-shaped material at or above 32 characters) whose safety cannot be determined from the text",
    pattern: /\b[0-9a-f]{32,}\b|(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/i,
  },
];

/** First matching rule for one assembled turn text, or null when all pass. */
export function firstSafetyViolation(
  text: string,
  rules: readonly PiSummarySafetyRule[] = PI_SUMMARY_SAFETY_RULES,
): PiSummarySafetyRule | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return rule;
    }
  }
  return null;
}

export type PiSummaryEvaluation =
  | { outcome: "available"; text: string }
  | { outcome: "unavailable"; reason: PiSummaryUnavailableReason };

/**
 * Judge one fully assembled turn and produce the display-safe outcome.
 *
 * The gate validates the complete turn text first; only a turn that passes in
 * full yields an excerpt, and that excerpt is re-validated before release.
 * Unavailable outcomes carry no text of any kind.
 */
export function evaluateTurnText(
  turnText: string,
  rules: readonly PiSummarySafetyRule[] = PI_SUMMARY_SAFETY_RULES,
): PiSummaryEvaluation {
  let violation: PiSummarySafetyRule | null;
  try {
    violation = firstSafetyViolation(turnText, rules);
  } catch {
    // A gate that cannot produce a verdict cannot produce a summary.
    return { outcome: "unavailable", reason: "gate_error" };
  }
  if (violation !== null) {
    return { outcome: "unavailable", reason: "unsafe_content" };
  }
  let excerpt: string;
  try {
    excerpt = excerptTurnText(turnText);
    // A turn that produced nothing displayable is explicitly unavailable,
    // distinct from a rule hit.
    if (excerpt.length === 0) {
      return { outcome: "unavailable", reason: "no_content" };
    }
    // The excerpt derives from validated text, but never trust derivation:
    // judge the exact bytes that will be exposed, one last time.
    if (firstSafetyViolation(excerpt, rules) !== null) {
      return { outcome: "unavailable", reason: "unsafe_content" };
    }
  } catch {
    return { outcome: "unavailable", reason: "gate_error" };
  }
  return { outcome: "available", text: excerpt };
}

/** First non-empty paragraph of a turn, single-spaced and length-bounded. */
export function excerptTurnText(turnText: string, maxChars: number = PI_SUMMARY_MAX_CHARS): string {
  const paragraph = turnText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0);
  if (paragraph === undefined) {
    return "";
  }
  const single = paragraph.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) {
    return single;
  }
  const cut = single.slice(0, maxChars - 3); // reserve room for the ellipsis
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > cut.length / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/**
 * Accumulates one task's Pi turns into the projected summary.
 *
 * One tracker belongs to one task's session lifecycle: `beginRun` opens the
 * run's summary (resetting any previous run's text), `beginTurn` /
 * `appendText` accumulate the streaming deltas of one turn, and `settleTurn`
 * evaluates and closes it. The tracker never retains the raw text of a
 * settled turn after evaluation, so an unavailable turn leaves no copy of its
 * content anywhere in Node.
 */
export class PiSummaryTracker {
  private readonly taskId: string;
  private readonly now: () => Date;
  private summary: PiSummary;
  private openTurnId: string | null = null;
  private buffer: string[] = [];

  constructor(taskId: string, options: { now?: () => Date } = {}) {
    this.taskId = taskId;
    this.now = options.now ?? (() => new Date());
    this.summary = this.pendingSummary(null);
  }

  /** Open a run: reset to `pending`; no text of any earlier run survives. */
  beginRun(runId: string | null): PiSummary {
    this.openTurnId = null;
    this.buffer = [];
    this.summary = this.pendingSummary(runId);
    return this.snapshot();
  }

  /** Open one turn; deltas appended before this are dropped, not judged. */
  beginTurn(turnId: string): void {
    this.openTurnId = turnId;
    this.buffer = [];
  }

  /** Accumulate one streamed delta of the open turn. */
  appendText(delta: string): void {
    if (this.openTurnId !== null) {
      this.buffer.push(delta);
    }
  }

  /**
   * Evaluate the open turn and replace the projected summary. Returns null
   * when no turn is open — a duplicated settlement path (a provider error
   * emits `agent_error` and then `agent_settled`) must publish exactly one
   * summary for the turn, so callers publish only real settlements.
   */
  settleTurn(): PiSummary | null {
    const turnId = this.openTurnId;
    if (turnId === null) {
      return null;
    }
    const turnText = this.buffer.join("");
    this.openTurnId = null;
    this.buffer = [];
    const evaluation = evaluateTurnText(turnText);
    this.summary = {
      task_id: this.taskId,
      run_id: this.summary.run_id,
      turn_id: turnId,
      status: evaluation.outcome,
      text: evaluation.outcome === "available" ? evaluation.text : null,
      unavailable_reason: evaluation.outcome === "unavailable" ? evaluation.reason : null,
      updated_at: this.now().toISOString(),
    };
    return this.snapshot();
  }

  /** Current projected summary; callers receive copies, never live state. */
  snapshot(): PiSummary {
    return structuredClone(this.summary);
  }

  private pendingSummary(runId: string | null): PiSummary {
    return {
      task_id: this.taskId,
      run_id: runId,
      turn_id: null,
      status: "pending",
      text: null,
      unavailable_reason: null,
      updated_at: this.now().toISOString(),
    };
  }
}
