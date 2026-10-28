/**
 * Safe Pi text summary (forgepilot-api/v1 display contract).
 *
 * The raw `pi.text_delta` stream is free model text: it can interleave
 * secrets, commands, absolute workspace paths, or unredacted log output, and
 * the UI must never display it on the strength of client-side filtering
 * alone. This module is the Node-side summary projection: it accumulates the
 * assistant text of one Pi turn and, at settlement, decides what the task's
 * `pi_summary` may expose.
 *
 * Trust boundary (DAT-193): displayability comes from provenance, not from
 * inspecting text. `available` requires an auditable trusted source, and
 * this version has exactly one: the structured Pi turn report channel
 * (`node/src/pi/turn-report.ts`), where the model labels a turn's work
 * through a strict closed-enum schema, Node validates that report
 * server-side, and Node itself composes the displayed sentence from fixed
 * phrases framed as Pi's own report. Free model output has no such
 * provenance: any turn, in any wording, may carry commands, credentials,
 * absolute paths, or raw logs, and no deterministic rule table can prove
 * that arbitrary free text contains none (DAT-191/192 hardened the table
 * across three QA rounds and QA still reproduced raw commands reaching
 * `available`: `node app succeeded.`,
 * `The team used poetry lock to pin versions.`). Therefore a settled
 * model turn's free text is never displayable, whatever the rule table
 * says: without a valid structured report the turn fails closed.
 *
 * The DAT-192 rule table stays in place as the *classifier*: it names why
 * withheld free text is unsafe or uncertifiable, so clients and operators
 * can see what was kept out. Every layer only ever adds a rejection:
 * 1. Structural command material fails closed wherever it appears: shell
 *    syntax (fences, code spans, prompts, pipes, redirections, `$VAR`),
 *    argument material (flags, `./` paths, `//target` arguments,
 *    `NAME=value` assignments), and invocation shapes (polysemous head +
 *    subcommand / file / quoted / path argument, plus a non-starter word
 *    immediately followed by a base command verb).
 * 2. Sentence and line openers must be recognised narrative prose:
 *    capitalisation confers no exemption, and every line start (not just
 *    paragraph and list starts) is judged. An opener that is a base
 *    command/speech verb (`Deploy…`, `Install…`, `Ensure…`) is an
 *    imperative and never classifies as prose, whatever marker the sentence
 *    carries; any other opener — polysemous command heads included —
 *    classifies only when the same segment carries a narrative marker (a
 *    copula/auxiliary/modal token or a participial `-ed` verb form).
 * 3. Execution reports ("I ran <something>") are undecidable: the text does
 *    not say what was executed.
 * 4. Command vocabularies are defence in depth on top: tokens with no
 *    ordinary prose use (`ls`, `cat`, `grep`, `sed`, …) fail on sight;
 *    polysemous heads (`git`, `make`, `node`, `find`, …) fail on structural
 *    evidence mid-sentence (`git status`, `node server.js`,
 *    `cat package.json`), and as segment openers they additionally need an
 *    in-segment narrative marker.
 * Vocabularies only ever add rejections; they are not the safety claim.
 *
 * Fail-closed posture (DAT-191/DAT-192/DAT-193 acceptance):
 * - Every settled turn publishes exactly one summary; `text` is non-null
 *   only when `status` is `available`, which requires the validated
 *   structured report of that turn. A turn without one — the model never
 *   called the tool, called it with an invalid report, or the turn
 *   produced nothing displayable — fails closed: a rule hit reports
 *   `unsafe_content`, a turn the classifier cannot recognise as prose
 *   reports `undecidable`, an empty turn reports `no_content`, a failure
 *   inside the classifier reports `gate_error`, and a turn whose only
 *   content is free text reports `untrusted_source`. The classifier's
 *   pass can never certify displayability.
 * - The rendered report text is itself run through the classifier before
 *   release (defence in depth; in this direction the classifier only ever
 *   adds a rejection, never an allowance). An unavailable summary never
 *   carries the raw turn text — in any field, event, or projection — so no
 *   partial or transformed leak is possible.
 * - An unsettled turn is `pending`, never a summary.
 *
 * The classifier is deliberately regex-based and deterministic: every
 * decision can be traced to a named rule with a declared reason, and no
 * model, network call, or widening permission is involved in judging the
 * text. Determinism is what makes the *classification* auditable; it is not
 * what makes text displayable — only provenance does that.
 *
 * Provenance (DAT-194): a client cannot tell a DAT-193 report-rendered
 * sentence from a DAT-191/192 free-text settlement by looking at `text`, so
 * every summary carries an explicit, server-verifiable `source` record — the
 * closed channel that produced the text (`kind`), the proof format's
 * `version`, the task/run/turn attribution it is bound to, and the validated
 * structured report the text was fixed-rendered from. Displayability stays a
 * server decision: `projectPiSummary` re-proves any `available` summary from
 * its stored source on the way out (valid closed-enum report, re-rendered
 * wording equal to the stored text, attribution identical, known kind and
 * version) and withholds anything it cannot prove — a summary with no source,
 * an unknown kind or version, a mismatched task/run/turn, tampered text, a
 * damaged record, or an unknown status all project to
 * `unavailable`/`untrusted_source` with `text: null`. Nothing about the
 * decision may come from the text's shape, a timestamp, or the running
 * service's own version, and no stored record or recorded event is ever
 * rewritten: the gate runs on read, for the REST projection, the timeline,
 * and SSE replay alike, so a legacy free-text `available` record keeps its
 * bytes on disk but is never served as displayable.
 *
 * Scope note (DAT-193, per the Architect's ruling on this issue): the
 * structured report channel is the available path for a real task's
 * natural-language summary — closed enums only, server-side validation,
 * fixed wording labelled as Pi's report rather than verified fact, no
 * additional model, external network, or widened permission, and unknown,
 * missing, or invalid reports fail closed. The free-text gap stays
 * recorded: no free model sentence can be certified displayable, and this
 * module never claims rules can prove arbitrary free text safe.
 */

import { renderTurnReport, validateTurnReport } from "../pi/turn-report.js";
import type { TurnReport } from "../pi/turn-report.js";

export const PI_SUMMARY_STATUSES = ["pending", "available", "unavailable"] as const;

export type PiSummaryStatus = (typeof PI_SUMMARY_STATUSES)[number];

export const PI_SUMMARY_UNAVAILABLE_REASONS = [
  /** The settled turn produced no displayable text at all. */
  "no_content",
  /** At least one safety rule identified unsafe material; fail closed. */
  "unsafe_content",
  /**
   * The classifier could not recognise the turn as narrative prose (an
   * execution report or an unrecognised sentence opener); fail closed. The
   * reason enum is additive — clients render an unknown reason as a plain
   * unavailable state.
   */
  "undecidable",
  /** The safety gate itself could not complete a verdict; fail closed. */
  "gate_error",
  /**
   * The content has no auditable trusted source: free model output (or a
   * structured report that fails server-side validation), so it is never
   * displayable (DAT-193). A pass of the rule table is a classification,
   * not a certification; fail closed without exposing any of the text.
   */
  "untrusted_source",
] as const;

export type PiSummaryUnavailableReason = (typeof PI_SUMMARY_UNAVAILABLE_REASONS)[number];

/** The reason a matched rule yields; `no_content`/`gate_error` are not rule hits. */
export type PiSummaryRuleReason = Extract<
  PiSummaryUnavailableReason,
  "unsafe_content" | "undecidable"
>;

/**
 * Closed set of provenance channels a summary source may name (DAT-194).
 * `turn_report` is the only one this contract defines: the model's
 * closed-enum `report_turn_summary` tool, validated by Node server-side and
 * fixed-rendered by Node (`node/src/pi/turn-report.ts`). Any other kind — a
 * free-text channel, a legacy label, a value this code has never heard of —
 * is not a trusted source and fails closed on read.
 */
export const PI_SUMMARY_SOURCE_KINDS = ["turn_report"] as const;

export type PiSummarySourceKind = (typeof PI_SUMMARY_SOURCE_KINDS)[number];

/** The single provenance channel this contract version can verify. */
export const PI_SUMMARY_SOURCE_KIND: PiSummarySourceKind = "turn_report";

/**
 * Version of the source proof format: the meaning of `kind`, the shape of
 * the record, and the fixed-rendering vocabulary `report` is judged against.
 * Carried by the record, never inferred from the writer's code version: a
 * record claiming an unknown version is unverifiable and fails closed.
 */
export const PI_SUMMARY_SOURCE_VERSION = 1;

/**
 * Verifiable provenance of a displayable summary's `text` (DAT-194).
 *
 * The record is the client-visible proof behind `status: "available"`:
 * - `kind` names the channel (closed enum; only `turn_report` exists),
 * - `version` versions the proof format and its rendering vocabulary,
 * - `task_id` / `run_id` / `turn_id` bind the proof to the exact task, run,
 *   and turn the summary claims to describe (attribution is compared, never
 *   trusted),
 * - `report` echoes the validated closed-enum structured report the text was
 *   fixed-rendered from, so a client can corroborate the enums and the
 *   attribution and a server can re-render the wording byte for byte.
 *
 * Only production code ever writes this: `PiSummaryTracker.settleTurn`
 * attaches it exclusively when `evaluateTurnReport` produced the text from a
 * validated report. A client MAY check the fields it can see, but that check
 * is corroboration, not the safety boundary — the server re-proves every
 * served `available` summary through `projectPiSummary`.
 */
export interface PiSummarySource {
  kind: PiSummarySourceKind;
  version: number;
  task_id: string;
  run_id: string | null;
  turn_id: string;
  report: TurnReport;
}

/**
 * One display-safe summary of the latest settled Pi turn for a task's run.
 *
 * Lifecycle: absent (`null` on the task) until a Pi session exists for the
 * task; `pending` from session start until the first turn settles; then
 * exactly one of `available` / `unavailable` per settled turn, each new
 * settlement replacing the previous summary. `run_id` attributes the summary
 * to the run whose session produced it — a new run resets to `pending` and
 * never inherits a previous run's text.
 */
export interface PiSummary {
  task_id: string;
  run_id: string | null;
  /** Pi turn this summary describes; null before any turn opens. */
  turn_id: string | null;
  status: PiSummaryStatus;
  /**
   * The display text: the fixed-wording rendering of the turn's validated
   * structured Pi report (DAT-193). Non-null if and only if status is
   * `available`; never free model text.
   */
  text: string | null;
  /** Why the summary is unavailable; non-null iff status is `unavailable`. */
  unavailable_reason: PiSummaryUnavailableReason | null;
  /**
   * Provenance of `text` (DAT-194): non-null if and only if status is
   * `available`. `pending` and `unavailable` summaries always carry null —
   * there is no displayable text to source — and an `available` summary
   * whose source is missing, unknown, of an unknown version, or not bound to
   * this task/run/turn is served as `unavailable`/`untrusted_source` with
   * `text: null` instead (see `projectPiSummary`).
   */
  source: PiSummarySource | null;
  updated_at: string;
}

export interface PiSummarySafetyRule {
  /** Stable rule identifier; the audit trail behind one rejection. */
  code: string;
  /** What the rule keeps out of displayable summaries. */
  keepsOut: string;
  /** Which unavailable reason this rule yields when it matches. */
  reason: PiSummaryRuleReason;
  pattern: RegExp;
}

/**
 * Command tokens with no ordinary prose use in this product's domain: any
 * occurrence fails closed, with or without arguments. Defence in depth —
 * the structural rules and the prose classification above already gate the
 * same turns; these tokens only ever add rejections.
 */
export const PI_SUMMARY_UNAMBIGUOUS_COMMAND_TOKENS: readonly string[] = [
  "apt",
  "apt-get",
  "awk",
  "bash",
  "brew",
  "cat",
  "chmod",
  "chgrp",
  "chown",
  "clang",
  "conda",
  "cp",
  "curl",
  "deno",
  "df",
  "dnf",
  "docker",
  "dpkg",
  "du",
  "egrep",
  "emacs",
  "fgrep",
  "gcc",
  "grep",
  "gzip",
  "helm",
  "hg",
  "javac",
  "jq",
  "kubectl",
  "launchctl",
  "ln",
  "ls",
  "mkdir",
  "mv",
  "nano",
  "npm",
  "npx",
  "nslookup",
  "perl",
  "php",
  "pip3",
  "pnpm",
  "podman",
  "printf",
  "ps",
  "pwd",
  "python2",
  "python3",
  "rg",
  "rm",
  "rmdir",
  "rsync",
  "rustc",
  "scp",
  "sed",
  "sh",
  "ssh",
  "sudo",
  "su",
  "svn",
  "systemctl",
  "tar",
  "terraform",
  "traceroute",
  "uniq",
  "unzip",
  "vi",
  "vim",
  "wget",
  "whoami",
  "wc",
  "xargs",
  "yum",
  "zsh",
];

/**
 * Polysemous command heads: words that are both commands and ordinary
 * English. Mid-sentence they fail on structural evidence — a known
 * subcommand, a file-like or quoted or path argument, or a `.` target —
 * so "the echo tool" stays prose while "git status", "make install",
 * "node server.js", and "find package.json" do not. As a sentence/line
 * opener they classify as prose only when the segment carries a narrative marker
 * (QA round-2): `Node is fast.` and `git history is clean.` stay
 * displayable on their copula, while segment-start `node app`,
 * `echo hello`, `python script`, and `git history` carry no marker and
 * fail closed as undecidable.
 */
export const PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS: readonly string[] = [
  "bun",
  "cargo",
  "date",
  "diff",
  "echo",
  "find",
  "git",
  "go",
  "head",
  "java",
  "kill",
  "make",
  "man",
  "node",
  "patch",
  "ping",
  "pip",
  "python",
  "ruby",
  "sort",
  "source",
  "tail",
  "yarn",
];

/** `git <subcommand>` shapes; the list follows git's porcelain surface. */
const GIT_SUBCOMMANDS: readonly string[] = [
  "add",
  "am",
  "apply",
  "annotate",
  "bisect",
  "blame",
  "branch",
  "cat-file",
  "cherry",
  "cherry-pick",
  "checkout",
  "clean",
  "clone",
  "commit",
  "config",
  "describe",
  "diff",
  "fetch",
  "format-patch",
  "gc",
  "hash-object",
  "init",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge",
  "mv",
  "name-rev",
  "notes",
  "prune",
  "pull",
  "push",
  "read-tree",
  "reflog",
  "rebase",
  "remote",
  "reset",
  "restore",
  "revert",
  "rev-list",
  "rev-parse",
  "rm",
  "send-email",
  "shortlog",
  "show",
  "show-branch",
  "sparse-checkout",
  "stage",
  "stash",
  "status",
  "submodule",
  "switch",
  "symbolic-ref",
  "tag",
  "update-index",
  "whatchanged",
  "worktree",
];

/** `npm|pnpm|yarn|bun|deno|pip|cargo|make|go <subcommand>` shapes. */
const PACKAGE_SUBCOMMANDS: readonly string[] = [
  "add",
  "all",
  "audit",
  "bench",
  "build",
  "check",
  "ci",
  "clean",
  "clippy",
  "compile",
  "coverage",
  "create",
  "deploy",
  "dev",
  "dist",
  "dlx",
  "doc",
  "docs",
  "exec",
  "fix",
  "fmt",
  "generate",
  "get",
  "i",
  "init",
  "install",
  "link",
  "lint",
  "list",
  "log",
  "mod",
  "new",
  "out",
  "outdated",
  "pack",
  "publish",
  "remove",
  "release",
  "restore",
  "run",
  "serve",
  "start",
  "test",
  "tree",
  "update",
  "vet",
  "version",
  "watch",
  "why",
];

/**
 * Reviewed narrative sentence openers. Every sentence, paragraph, and list
 * item of a turn the classifier accepts as prose must begin with one of these (or a capitalised
 * token, or a polysemous command head); anything else — an imperative
 * opener such as `install the dependencies` — is undecidable and fails
 * closed. Deliberately excluded: bare imperative verbs (`run`, `install`,
 * `update`, `deploy`, `check`, `use`, …).
 */
export const PI_SUMMARY_PROSE_STARTERS: readonly string[] = [
  // Subjects, pronouns, determiners, possessives.
  "i",
  "we",
  "you",
  "they",
  "he",
  "she",
  "it",
  "me",
  "us",
  "him",
  "her",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "mine",
  "yours",
  "ours",
  "theirs",
  "myself",
  "yourself",
  "himself",
  "herself",
  "itself",
  "ourselves",
  "themselves",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "the",
  "a",
  "an",
  // Interrogatives and relatives.
  "who",
  "whom",
  "whose",
  "which",
  "what",
  "whoever",
  "whatever",
  "whichever",
  "when",
  "where",
  "why",
  "how",
  "whenever",
  "wherever",
  // Quantifiers, numerals, indefinites.
  "some",
  "any",
  "no",
  "none",
  "every",
  "each",
  "all",
  "both",
  "another",
  "such",
  "several",
  "many",
  "few",
  "much",
  "most",
  "more",
  "least",
  "less",
  "enough",
  "various",
  "multiple",
  "either",
  "neither",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "twenty",
  "hundred",
  "thousand",
  "first",
  "second",
  "third",
  "fourth",
  "last",
  "next",
  "rest",
  "half",
  "everything",
  "anything",
  "something",
  "nothing",
  "someone",
  "anyone",
  "everyone",
  "nobody",
  "somebody",
  "anybody",
  "everybody",
  // Conjunctions, subordinators, prepositions.
  "and",
  "but",
  "or",
  "nor",
  "yet",
  "so",
  "because",
  "if",
  "unless",
  "while",
  "since",
  "until",
  "till",
  "after",
  "before",
  "although",
  "though",
  "whereas",
  "whether",
  "than",
  "then",
  "via",
  "per",
  "about",
  "above",
  "across",
  "against",
  "along",
  "among",
  "around",
  "as",
  "at",
  "behind",
  "below",
  "beneath",
  "beside",
  "between",
  "beyond",
  "down",
  "during",
  "except",
  "for",
  "from",
  "in",
  "inside",
  "into",
  "near",
  "of",
  "off",
  "on",
  "onto",
  "out",
  "outside",
  "over",
  "past",
  "through",
  "throughout",
  "to",
  "toward",
  "towards",
  "under",
  "underneath",
  "up",
  "upon",
  "within",
  "without",
  "versus",
  "vs",
  "despite",
  // Auxiliaries, modals, negation.
  "do",
  "does",
  "did",
  "doing",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "ought",
  "not",
  "never",
  // Common adverbs and discourse markers.
  "also",
  "only",
  "just",
  "even",
  "still",
  "already",
  "too",
  "very",
  "quite",
  "rather",
  "almost",
  "nearly",
  "maybe",
  "perhaps",
  "probably",
  "certainly",
  "definitely",
  "really",
  "actually",
  "simply",
  "exactly",
  "properly",
  "correctly",
  "well",
  "now",
  "later",
  "soon",
  "today",
  "tomorrow",
  "yesterday",
  "again",
  "once",
  "twice",
  "instead",
  "therefore",
  "thus",
  "hence",
  "moreover",
  "furthermore",
  "additionally",
  "meanwhile",
  "otherwise",
  "anyway",
  "indeed",
  "notably",
  "specifically",
  "generally",
  "typically",
  "usually",
  "often",
  "sometimes",
  "rarely",
  "finally",
  "initially",
  "previously",
  "currently",
  "originally",
  "eventually",
  "immediately",
  "subsequently",
  "consequently",
  "alternatively",
  "apparently",
  "clearly",
  "obviously",
  "evidently",
  "unfortunately",
  "fortunately",
  "interestingly",
  "overall",
  "effectively",
  // Sentence fragments and result participles common in agent prose.
  "success",
  "successfully",
  "done",
  "fixed",
  "ready",
  "works",
  "working",
  "complete",
  "completed",
  "confirmed",
  "verified",
  "updated",
  "added",
  "removed",
  "changed",
  "passed",
  "failed",
  "resolved",
  "reproduced",
  "found",
  "finding",
  "ignored",
  "skipped",
  "approved",
  "rejected",
  "pending",
  "available",
  "unavailable",
  "blocked",
  "cancelled",
  "canceled",
  "possible",
  "unclear",
  "correct",
  "incorrect",
  "sure",
  "ok",
  "okay",
  "good",
  "bad",
  "great",
  "fine",
  "safe",
  "clear",
  "important",
  // Gerund openers (declarative subjects, not imperatives).
  "running",
  "updating",
  "fixing",
  "adding",
  "removing",
  "changing",
  "checking",
  "testing",
  "using",
  "reviewing",
  "merging",
  "rebasing",
  "deploying",
  "installing",
  "building",
  "creating",
  "deleting",
  "renaming",
  "moving",
  "copying",
  "reading",
  "writing",
  "inspecting",
  "confirming",
  "validating",
  "retrying",
  "stopping",
  "starting",
  "cancelling",
  "canceling",
  "approving",
  "requesting",
  "waiting",
  "looking",
  "trying",
  "following",
  "executing",
  "invoking",
  "calling",
  // Negative contractions (auxiliary + negation), not imperative openers:
  // base-form imperatives are rejected by PI_SUMMARY_COMMAND_VERBS below.
  "don't",
  "doesn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "can't",
  "won't",
  "couldn't",
  "wouldn't",
  "shouldn't",
  "hasn't",
  "haven't",
  "hadn't",
  // Initials of sentence-leading abbreviations (`e.g.`); `i` covers `i.e.`
  // above, and a dotted abbreviation is not a prose-starter signal.
  "e",
];

/**
 * Base-form command and speech-act verbs. Two fail-closed uses:
 * - as a sentence/line opener it is an imperative and never classifies as
 *   prose, even when the sentence carries a narrative marker (`Ensure the lockfile
 *   is current.` stays unavailable);
 * - a non-starter word immediately followed by one of these verbs is an
 *   invocation shape (`Poetry install`, `Bazel build`, `vite build`),
 *   wherever it appears — grammatical English only uses bare base verbs
 *   after auxiliaries, modals, or `to`, all of which are prose starters and
 *   therefore exempt heads. Polysemous heads are never listed here: they
 *   keep their structural-evidence rules (`git history` stays displayable).
 * Deliberately excluded: ambiguous nouns that also name commands (`check`,
 * `review`, `list`) so noun compounds like "the export checks" stay prose.
 */
export const PI_SUMMARY_COMMAND_VERBS: readonly string[] = [
  "add",
  "approve",
  "avoid",
  "build",
  "bundle",
  "cancel",
  "checkout",
  "clean",
  "clone",
  "commit",
  "compile",
  "consider",
  "create",
  "debug",
  "delete",
  "deploy",
  "ensure",
  "exec",
  "execute",
  "export",
  "format",
  "generate",
  "init",
  "install",
  "keep",
  "let",
  "lint",
  "migrate",
  "merge",
  "note",
  "package",
  "patch",
  "please",
  "prune",
  "publish",
  "pull",
  "push",
  "rebase",
  "refactor",
  "reject",
  "release",
  "remember",
  "remove",
  "rename",
  "reset",
  "restart",
  "restore",
  "retry",
  "run",
  "start",
  "stop",
  "sync",
  "tag",
  "test",
  "try",
  "uninstall",
  "upgrade",
  "update",
  "use",
  "verify",
];

const alternation = (words: readonly string[]): string => words.join("|");

const COMMAND_TOKENS = alternation([
  ...PI_SUMMARY_UNAMBIGUOUS_COMMAND_TOKENS,
  ...PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS,
]);

/** `NAME=value` with no spaces around `=` — shell/flag assignment material. */
const ASSIGNMENT = String.raw`\b[A-Za-z_][A-Za-z0-9_]{1,}=[^\s]`;

/** `//target` argument material (bazel-style targets, comment-style paths). */
const COMMAND_TARGET = String.raw`(?:^|[\s("'` + "`" + String.raw`])//[\w.:@+-]+`;

/** Flag-shaped tokens (`-la`, `--init`) wherever they appear. */
const FLAG = String.raw`(?:^|[\s("'` + "`" + String.raw`])-{1,2}[A-Za-z][\w-]*`;

/** `./` `../` `~/` relative path material wherever it appears. */
const RELATIVE_PATH =
  String.raw`(?:^|[\s("'` +
  "`" +
  String.raw`])(?:\.\.?/)+[\w.@+-]+|(?:^|[\s("'` +
  "`" +
  String.raw`])~/[\w.@-]+`;

/** A file-like argument: word characters, then a dot, then an extension. */
const FILEISH_ARG = String.raw`[A-Za-z0-9_][\w./~-]*\.[A-Za-z0-9]{1,12}\b`;

/** A path argument containing a separator: `env/bin/activate`, `src/api`. */
const PATH_ARG = String.raw`[\w.-]+/[\w./-]+`;

/** A quoted argument directly after a command head: `sed 's/a/b/'`. */
const QUOTED_ARG = String.raw`(?:'[^'\n]{1,120}'|"[^"\n]{1,120}")`;

/**
 * Redirection: spaced (`a > b`), tight (`hi>out.txt`, `a<b`), but not
 * comparison punctuation inside prose identifiers such as
 * `Object.<anonymous>` in a stack frame (that text fails as `raw_log`).
 */
const REDIRECTION = String.raw`(?:[\s)]|^)(?:>{1,2}|<{1,2})(?:[\s)]|$)|[\w)]>{1,2}\s*[\w./~]|[\w)]<{1,2}\s*[\w./~]`;

/**
 * Subject + execution verb: a report that something was run. The text does
 * not say what was executed, so the turn cannot be classified as prose — reason
 * `undecidable`, not a tool-specific guess.
 */
const EXECUTION_REPORT = String.raw`\b(?:i|we|you|they|he|she|it)\s+(?:just\s+|also\s+|then\s+|quickly\s+|manually\s+|successfully\s+)?(?:ran|run|running|executed|executing|invoked|invoking|called|calling|issued|issuing|typed|typing|launched|launching|started|starting|installed|installing|applied|applying|attempted|attempting|tried|trying|performed|performing)\b\s+\S`;

/**
 * Segment positions at which a prose-classified turn must open with a
 * recognised narrative starter: the start of the turn, an inline sentence
 * end, and **every line start** — agent output commonly writes one action
 * per line, so a single newline opens a new segment (list/quote markers
 * after it are skipped). Sentence ends preceded by an abbreviation dot
 * (`e.g.`, `i.e.`) do not split.
 */
const SEGMENT_START = [
  String.raw`^[\s]*(?:[-*•][ \t]+|>[ \t]+)?`,
  String.raw`(?<!\.[A-Za-z])[.!?…]["')\]]*[ \t]+`,
  String.raw`\n[ \t]*(?:[-*•][ \t]+|>[ \t]+)?`,
].join("|");

/** Emphasis, heading, and quote noise skipped before a segment opener. */
const OPENER_SKIP = String.raw`[ \t]*(?:["'“‘(*_#~[\]][ \t]*)*`;

/**
 * Narrative markers: a copula/auxiliary/modal token, or a participial `-ed`
 * verb form. Only these rescue an otherwise unrecognised opener — a
 * command line (`Bazel build //app:server`, `Deploy the new version.`)
 * carries none, while narrative like `Alpha task verified the export
 * path.` does. Bare `-ing` words are deliberately not markers: English is
 * full of `-ing` nouns (`nothing`, `building`), and progressive `-ing`
 * verbs always follow a copula/auxiliary, which is already a marker.
 */
const NARRATIVE_MARKER = String.raw`\b(?:is|are|was|were|be|been|being|do|does|did|has|have|had|will|would|shall|should|can|could|may|might|must)\b|[A-Za-z]{2,}ed\b`;

/** No marker may appear between an unrecognised opener and the next segment. */
const NO_MARKER_IN_SEGMENT = String.raw`(?!(?:(?!${SEGMENT_START})(?!${NARRATIVE_MARKER})[\s\S])*(?:${NARRATIVE_MARKER}))`;

/**
 * Matches an opener the positive prose classification rejects. Capitalisation
 * confers no exemption (case-insensitive): an opener that is a base
 * command/speech verb is an imperative and fails closed regardless of any
 * marker; any other opener outside the reviewed starter list and the
 * `-ed`/`-ing` participles — polysemous command heads included — fails
 * closed unless the same segment carries a narrative marker, so
 * `Node is fast.` passes the classification on `is` while `node app` and
 * `git history` do not. Passing the classification never makes text
 * displayable; that needs a trusted source (DAT-193).
 */
const PROSE_STARTER_VIOLATION = new RegExp(
  String.raw`(?:${SEGMENT_START})${OPENER_SKIP}` +
    String.raw`(?!(?:${alternation(PI_SUMMARY_PROSE_STARTERS)})\b)` +
    String.raw`(?!(?:[A-Za-z]{4,}(?:ed|ing)\b))` +
    String.raw`(?:` +
    String.raw`(?=(?:${alternation(PI_SUMMARY_COMMAND_VERBS)})\b)[A-Za-z][\w'-]*` +
    String.raw`|` +
    String.raw`[A-Za-z][\w'-]*${NO_MARKER_IN_SEGMENT}` +
    String.raw`)`,
  "i",
);

/**
 * The ordered fail-closed classification table. Every rule is evaluated
 * against the fully assembled turn text, so material split across stream
 * fragments (a token broken between two deltas, a path broken across three)
 * is judged only in its assembled form and cannot slip through a
 * fragment-level check. Each rule declares the unavailable reason it yields.
 */
export const PI_SUMMARY_SAFETY_RULES: readonly PiSummarySafetyRule[] = [
  {
    code: "secret_material",
    keepsOut:
      "credential-shaped material: provider API keys and tokens (OpenAI/Anthropic-style sk-, " +
      "GitHub, AWS AKIA/ASIA, Slack, GitLab, Stripe sk_live/sk_test, Google AIza, npm, " +
      "SendGrid SG., Datadog dop_v1_, legacy SK hex), PEM private keys, authorization " +
      "headers, credential assignments",
    reason: "unsafe_content",
    pattern:
      /\bsk-[A-Za-z0-9_-]{16,}|\bsk_(?:live|test)_[0-9A-Za-z]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bglpat-[A-Za-z0-9_-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|\bnpm_[0-9A-Za-z]{36}\b|\bSG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}|\bdop_v1_[0-9A-Za-z]{16,}|\bSK[0-9a-f]{32}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?key|password|passwd|private[_-]?key)\s*[:=]\s*\S{6,}/i,
  },
  {
    code: "shell_syntax",
    keepsOut:
      "raw command material in shell syntax: fenced code blocks, code spans containing shell " +
      "metacharacters or a command executable, `$ ` prompt lines, pipes, `&` sequences, `;` " +
      "before a command, redirections, and $VAR / $(...) references",
    reason: "unsafe_content",
    // The stack-branch-safe patterns from DAT-191 are unchanged; the prompt
    // branch is multiline so `$ ` lines are caught mid-turn, not just first.
    pattern: new RegExp(
      [
        // Plain strings here: a raw template cannot hold a backtick fence.
        "```[\\s\\S]*?```",
        "`[^`\\n]*[\\s|&;>$][^`\\n]*`",
        "`(?:" + COMMAND_TOKENS + ")\\b[^`]*`",
        "^\\s*\\$\\s+\\S",
        "\\$(?:\\{[A-Za-z_][\\w]*\\}|[A-Za-z_][\\w]*)|\\$\\(",
        "\\|",
        "&",
        ";\\s+(?=(?:" + COMMAND_TOKENS + ")\\b|\\./|~/|\\$)",
        REDIRECTION,
      ]
        .map((branch) => branch.trim())
        .join("|"),
      "mi",
    ),
  },
  {
    code: "absolute_path",
    keepsOut:
      "absolute local filesystem paths (user home, workspace, and system roots) on any platform",
    reason: "unsafe_content",
    pattern:
      /\/(?:Users|home|root|tmp|var|private|etc|opt|mnt|media|srv|proc|usr|bin|sbin|Library|System|Applications|Volumes|workspace|workdir)\/[A-Za-z0-9._-]+|[A-Za-z]:\\[^\s"']+/,
  },
  {
    code: "tool_invocation",
    keepsOut:
      "command invocations: any occurrence of a command token with no ordinary prose use " +
      "(ls, cat, grep, sed, awk, chmod, curl, docker, …), a polysemous head (git, make, " +
      "node, go, find, python, …) followed by a known subcommand, a file-like argument, a " +
      "quoted argument, a path argument, or a `.` target, and a non-starter word immediately " +
      "followed by a base command verb (Poetry install, Bazel build, vite build) wherever it " +
      "appears",
    reason: "unsafe_content",
    pattern: new RegExp(
      [
        String.raw`\b(?:${alternation(PI_SUMMARY_UNAMBIGUOUS_COMMAND_TOKENS)})\b`,
        String.raw`\b(?:${alternation(PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS)})\s+${FILEISH_ARG}`,
        String.raw`\b(?:${alternation(PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS)})\s+${PATH_ARG}`,
        String.raw`\b(?:${alternation(PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS)})\s+${QUOTED_ARG}`,
        String.raw`\b(?:${alternation(PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS)})\s+\.(?=\s|$|[|;&])`,
        String.raw`\bgit\s+(?:${alternation(GIT_SUBCOMMANDS)})\b`,
        String.raw`\b(?:npm|pnpm|yarn|bun|deno|pip3?|cargo|make|go)\s+(?:${alternation(PACKAGE_SUBCOMMANDS)})\b`,
        // Non-starter head + base command verb: bare base verbs only occur
        // after auxiliaries/modals/`to` (all prose starters, exempt heads),
        // so this shape is an invocation, not grammatical narrative.
        String.raw`(?!(?:${alternation(PI_SUMMARY_PROSE_STARTERS)})\b)\b[A-Za-z][\w'-]*\s+(?:${alternation(PI_SUMMARY_COMMAND_VERBS)})\b`,
      ].join("|"),
      "i",
    ),
  },
  {
    code: "command_material",
    keepsOut:
      "argument material wherever it appears: flag-shaped tokens (-la, --init), ./ ../ ~/ " +
      "relative paths, //target arguments, and unspaced NAME=value assignments",
    reason: "unsafe_content",
    pattern: new RegExp([FLAG, RELATIVE_PATH, ASSIGNMENT, COMMAND_TARGET].join("|")),
  },
  {
    code: "raw_log",
    keepsOut:
      "unredacted log and diagnostic output: stack traces, log-level lines, fatal:/error:-style " +
      "diagnostics, ANSI escapes, log timestamps",
    reason: "unsafe_content",
    // The stack branch uses [^()\n]* before the opening paren so a long
    // paren-heavy line stays linear (no backtracking blow-up on settlement).
    pattern:
      // eslint-disable-next-line no-control-regex -- the ESC byte itself is the signal: raw ANSI output must fail closed.
      /\x1b\[[0-9;]*[A-Za-z]|^\s*at\s+[^()\n]*\([^)\n]*:\d+:\d+\)|Traceback \(most recent call last\)|Exception in thread|^\s*Caused by:|^\s*(?:\[[^\]\n]+\]\s*)?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b[:\s]|\b(?:fatal|error|warning|critical)\s*:|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\b/m,
  },
  {
    code: "high_entropy",
    keepsOut:
      "opaque long strings (digests, hex blobs, base64-shaped material at or above 32 characters) " +
      "whose safety cannot be determined from the text",
    reason: "unsafe_content",
    pattern: /\b[0-9a-f]{32,}\b|(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/i,
  },
  {
    code: "execution_report",
    keepsOut:
      "reports that a subject ran/executed/invoked/… something unspecified: the text does not " +
      "say what was executed, so the turn cannot be classified as prose (fail closed as undecidable)",
    reason: "undecidable",
    pattern: new RegExp(EXECUTION_REPORT, "i"),
  },
  {
    code: "prose_starter",
    keepsOut:
      "unrecognised sentence and line openers: capitalisation " +
      "confers no exemption, a base command/speech verb opener is an imperative that never " +
      "classifies as prose, and any other unrecognised opener classifies only with an in-segment narrative " +
      "marker — an invocation of a tool no vocabulary lists still cannot classify at a " +
      "segment start",
    reason: "undecidable",
    pattern: PROSE_STARTER_VIOLATION,
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
  /**
   * A displayable summary from the turn's auditable trusted source
   * (DAT-193): only `evaluateTurnReport` produces it, from the validated
   * structured Pi report, and it carries that report so the summary can
   * publish it as its verifiable `source` (DAT-194). `evaluateTurnText`
   * never returns it for free model turns.
   */
  | { outcome: "available"; text: string; report: TurnReport }
  | { outcome: "unavailable"; reason: PiSummaryUnavailableReason };

/**
 * Judge one fully assembled model turn and produce the projection outcome.
 *
 * Free model text is never displayable, so the outcome is always
 * `unavailable`: a matched rule names the unsafe material it found
 * (`unsafe_content`) or the turn it could not certify (`undecidable`), an
 * empty turn reports `no_content`, a classifier failure reports
 * `gate_error`, and a turn no rule flags still fails closed as
 * `untrusted_source` — absence of a rule hit proves nothing about arbitrary
 * free text, and no rule table can be the trust boundary (DAT-193).
 * Unavailable outcomes carry no text of any kind, whichever reason the
 * matched rule declares.
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
    return { outcome: "unavailable", reason: violation.reason };
  }
  // A turn that produced nothing at all is explicitly unavailable,
  // distinct from a rule hit and distinct from the trust decision below.
  if (turnText.trim().length === 0) {
    return { outcome: "unavailable", reason: "no_content" };
  }
  // The classifier passed, which is not certification: free model output
  // has no auditable trusted source, so it is withheld in full (DAT-193).
  return { outcome: "unavailable", reason: "untrusted_source" };
}

/**
 * Produce the projection outcome from one validated structured Pi report.
 *
 * The report is the turn's trusted display source (DAT-193): Node renders
 * the fixed wording itself, so no model-supplied words can reach `text`.
 * The report is re-validated here — a report outside the closed vocabulary
 * fails closed as `untrusted_source`, whatever produced it. Defence in
 * depth: the rendered sentence still goes through the classifier before
 * release — in this direction the classifier can only withhold, never
 * create an allowance. A renderer or classifier failure fails closed as
 * `gate_error`.
 */
export function evaluateTurnReport(
  report: TurnReport,
  rules: readonly PiSummarySafetyRule[] = PI_SUMMARY_SAFETY_RULES,
): PiSummaryEvaluation {
  try {
    if (validateTurnReport(report) === null) {
      return { outcome: "unavailable", reason: "untrusted_source" };
    }
    const text = renderTurnReport(report);
    if (text.trim().length === 0) {
      return { outcome: "unavailable", reason: "no_content" };
    }
    const violation = firstSafetyViolation(text, rules);
    if (violation !== null) {
      return { outcome: "unavailable", reason: violation.reason };
    }
    return { outcome: "available", text, report };
  } catch {
    return { outcome: "unavailable", reason: "gate_error" };
  }
}

/** The only reason an unprovable summary is withheld for (DAT-194). */
const UNPROVEN_SOURCE_REASON: PiSummaryUnavailableReason = "untrusted_source";

/** Whether a stored value could be a source record at all. */
function sourceCandidate(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Re-prove one stored `available` summary from its own source record
 * (DAT-194). Returns true only when every element of the trust chain holds:
 *
 * 1. the source names a known channel (`kind`) at a known proof `version` —
 *    never a guess from text, timestamps, or this service's own version;
 * 2. the source is attributed to exactly the task, run, and turn the summary
 *    claims (all three must be concrete identifiers);
 * 3. the echoed report is valid against the closed vocabulary server-side;
 * 4. re-rendering that report through the fixed wording reproduces the stored
 *    text byte for byte and still passes the classifier.
 *
 * Condition 4 makes the stored text itself evidence: the only text that can
 * ever be served as trusted is wording this server composes from a real,
 * validated structured report.
 */
function hasTrustedProvenance(summary: PiSummary): boolean {
  const source = sourceCandidate(summary.source);
  if (source === null) {
    return false;
  }
  if (source["kind"] !== PI_SUMMARY_SOURCE_KIND) {
    return false;
  }
  if (source["version"] !== PI_SUMMARY_SOURCE_VERSION) {
    return false;
  }
  const { task_id: taskId, run_id: runId, turn_id: turnId } = summary;
  if (typeof taskId !== "string" || typeof runId !== "string" || typeof turnId !== "string") {
    return false;
  }
  if (source["task_id"] !== taskId || source["run_id"] !== runId || source["turn_id"] !== turnId) {
    return false;
  }
  if (typeof summary.text !== "string") {
    return false;
  }
  const report = validateTurnReport(source["report"]);
  if (report === null) {
    return false;
  }
  const evaluation = evaluateTurnReport(report);
  return evaluation.outcome === "available" && evaluation.text === summary.text;
}

/** Canonical key order and shape for every served summary, trusted or not. */
function projectedSummary(
  stored: PiSummary,
  status: PiSummaryStatus,
  text: string | null,
  unavailableReason: PiSummaryUnavailableReason | null,
  source: PiSummarySource | null,
): PiSummary {
  return {
    task_id: stored.task_id,
    run_id: stored.run_id,
    turn_id: stored.turn_id,
    status,
    text,
    unavailable_reason: unavailableReason,
    source,
    updated_at: stored.updated_at,
  };
}

/**
 * The read-side provenance gate for `pi_summary` (DAT-194).
 *
 * Every served summary passes through here — `GET /tasks`, the Task payloads
 * of list/approve/create responses, `GET /tasks/{id}/timeline`, and the SSE
 * replay and live stream — so the REST projection and the replayed events
 * always agree, and no code path can serve a summary the gate has not
 * approved. The stored record and the recorded event stay byte-for-byte as
 * written: history is preserved, only its projection fails closed.
 *
 * Rules:
 * - `pending` → text, reason, and source are all null.
 * - `unavailable` → text and source are null; the recorded reason (the enum
 *   is additive) is passed through, defaulting to `untrusted_source` when the
 *   record cannot name one.
 * - `available` → served unchanged only if `hasTrustedProvenance` proves the
 *   text from the stored source; otherwise served as
 *   `unavailable`/`untrusted_source` with `text: null`. This is where every
 *   legacy DAT-191/192 free-text `available` record, every missing, forged,
 *   or unknown-version source, and every damaged summary lands.
 * - an unknown status fails closed exactly like an unproven `available`.
 *
 * Returns null when the stored value is not a summary at all — not an
 * object, or missing the task/run/turn/time envelope that identifies what a
 * summary would even describe: a damaged record or event payload must not
 * become displayable text either, and there is nothing left of it to serve.
 */
export function projectPiSummary(value: unknown): PiSummary | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const stored = value as PiSummary;
  if (
    typeof stored.task_id !== "string" ||
    (stored.run_id !== null && typeof stored.run_id !== "string") ||
    (stored.turn_id !== null && typeof stored.turn_id !== "string") ||
    typeof stored.updated_at !== "string"
  ) {
    return null;
  }
  switch (stored.status) {
    case "pending":
      return projectedSummary(stored, "pending", null, null, null);
    case "unavailable":
      return projectedSummary(
        stored,
        "unavailable",
        null,
        typeof stored.unavailable_reason === "string"
          ? (stored.unavailable_reason as PiSummaryUnavailableReason)
          : UNPROVEN_SOURCE_REASON,
        null,
      );
    case "available":
      if (hasTrustedProvenance(stored)) {
        return projectedSummary(
          stored,
          "available",
          stored.text as string,
          null,
          structuredClone(stored.source as PiSummarySource),
        );
      }
      return projectedSummary(stored, "unavailable", null, UNPROVEN_SOURCE_REASON, null);
    default:
      // Unknown status (a record this contract cannot interpret): a plain
      // unavailable state, never text.
      return projectedSummary(stored, "unavailable", null, UNPROVEN_SOURCE_REASON, null);
  }
}

/**
 * Accumulates one task's Pi turns into the projected summary.
 *
 * One tracker belongs to one task's session lifecycle: `beginRun` opens the
 * run's summary (resetting any previous run's text), `beginTurn` /
 * `appendText` accumulate the streaming deltas of one turn, `recordReport`
 * attaches the turn's validated structured report (its display source), and
 * `settleTurn` evaluates and closes it. The tracker never retains the raw
 * text of a settled turn after evaluation, so an unavailable turn leaves no
 * copy of its content anywhere in Node.
 */
export class PiSummaryTracker {
  private readonly taskId: string;
  private readonly now: () => Date;
  private summary: PiSummary;
  private openTurnId: string | null = null;
  private buffer: string[] = [];
  /** Validated structured report of the open turn; its display source. */
  private openReport: TurnReport | null = null;

  constructor(taskId: string, options: { now?: () => Date } = {}) {
    this.taskId = taskId;
    this.now = options.now ?? (() => new Date());
    this.summary = this.pendingSummary(null);
  }

  /** Open a run: reset to `pending`; no text of any earlier run survives. */
  beginRun(runId: string | null): PiSummary {
    this.openTurnId = null;
    this.buffer = [];
    this.openReport = null;
    this.summary = this.pendingSummary(runId);
    return this.snapshot();
  }

  /** Open one turn; deltas and reports appended before this are dropped. */
  beginTurn(turnId: string): void {
    this.openTurnId = turnId;
    this.buffer = [];
    this.openReport = null;
  }

  /** Accumulate one streamed delta of the open turn. */
  appendText(delta: string): void {
    if (this.openTurnId !== null) {
      this.buffer.push(delta);
    }
  }

  /**
   * Record one validated structured report as the open turn's display
   * source (DAT-193). A report arriving with no open turn is dropped,
   * exactly like a delta appended before a turn opens; a later valid
   * report in the same turn replaces an earlier one.
   */
  recordReport(report: TurnReport): void {
    if (this.openTurnId !== null) {
      this.openReport = report;
    }
  }

  /**
   * Evaluate the open turn and replace the projected summary. Returns null
   * when no turn is open — a duplicated settlement path (a provider error
   * emits `agent_error` and then `agent_settled`) must publish exactly one
   * summary for the turn, so callers publish only real settlements. A turn
   * with a validated structured report publishes that report's fixed
   * wording together with the `source` record proving it (DAT-194); a turn
   * without one evaluates its free text, which under the
   * DAT-193 trust boundary always resolves to `unavailable` and never
   * receives a source.
   */
  settleTurn(): PiSummary | null {
    const turnId = this.openTurnId;
    if (turnId === null) {
      return null;
    }
    const turnText = this.buffer.join("");
    const report = this.openReport;
    const runId = this.summary.run_id;
    this.openTurnId = null;
    this.buffer = [];
    this.openReport = null;
    const evaluation = report !== null ? evaluateTurnReport(report) : evaluateTurnText(turnText);
    // Only the report path can carry provenance: the source record is
    // attached exactly when Node composed the displayed text from the
    // validated structured report, and it is bound to this task, run, and
    // turn (DAT-194). Free-text settlements never receive one.
    const source: PiSummarySource | null =
      evaluation.outcome === "available"
        ? {
            kind: PI_SUMMARY_SOURCE_KIND,
            version: PI_SUMMARY_SOURCE_VERSION,
            task_id: this.taskId,
            run_id: runId,
            turn_id: turnId,
            report: {
              areas: [...evaluation.report.areas],
              activities: [...evaluation.report.activities],
              outcome: evaluation.report.outcome,
            },
          }
        : null;
    this.summary = {
      task_id: this.taskId,
      run_id: runId,
      turn_id: turnId,
      status: evaluation.outcome,
      text: evaluation.outcome === "available" ? evaluation.text : null,
      unavailable_reason: evaluation.outcome === "unavailable" ? evaluation.reason : null,
      source,
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
      source: null,
      updated_at: this.now().toISOString(),
    };
  }
}
