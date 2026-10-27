/**
 * Safe Pi text summary (forgepilot-api/v1 display contract).
 *
 * The raw `pi.text_delta` stream is free model text: it can interleave
 * secrets, commands, absolute workspace paths, or unredacted log output, and
 * the UI must never display it on the strength of client-side filtering
 * alone. This module is the Node-side, auditable summary source: it
 * accumulates the assistant text of one Pi turn, and at settlement runs the
 * whole assembled turn text through an ordered, reviewable certification
 * table before anything is exposed as a summary.
 *
 * Security basis (DAT-192, QA round-1 hardening): certification is
 * positive, not a tool blacklist. Enumerating command tools can never be
 * the safety claim — the set of commands is open — so the decision
 * boundary is layered, and every layer only ever adds a rejection:
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
 *    imperative and never certifies, whatever marker the sentence carries;
 *    any other unrecognised opener certifies only when the same segment
 *    carries a narrative marker (copula/auxiliary/modal or a participial /
 *    gerund verb form). Command lines carry no such marker, so an
 *    invocation of a tool nobody enumerated still cannot be certified at
 *    a segment start.
 * 3. Execution reports ("I ran <something>") are undecidable: the text does
 *    not say what was executed, so the turn is not displayable.
 * 4. Command vocabularies are defence in depth on top: tokens with no
 *    ordinary prose use (`ls`, `cat`, `grep`, `sed`, …) fail on sight;
 *    polysemous heads (`git`, `make`, `node`, `find`, …) fail on structural
 *    evidence only, keeping ordinary prose such as "git history" and
 *    "make sense" displayable while "git status" and "cat package.json"
 *    are not.
 * Vocabularies only ever add rejections; they are not the safety claim.
 * Honest residual (stated in the contract): an unlisted tool invoked with
 * plain-English words in the *middle* of an otherwise certified narrative
 * sentence, carrying none of the structural markers above, is not
 * distinguishable from prose by a deterministic gate.
 *
 * Fail-closed posture (DAT-191/DAT-192 acceptance):
 * - A summary is `available` only when the entire settled turn text is
 *   certified by every rule; the displayed text is a bounded excerpt of
 *   that same validated text.
 * - Any rule hit — or a failure inside the gate itself — yields an explicit
 *   `unavailable` summary whose `text` is always null: identified unsafe
 *   material reports `unsafe_content`, anything the gate cannot certify
 *   reports `undecidable`. The turn's raw text is never copied into an
 *   unavailable summary, a timeline event, or the task projection, so no
 *   partial or transformed leak is possible.
 * - An unsettled turn is `pending`, never a summary.
 *
 * The rule table is deliberately regex-based and deterministic: every accept
 * or reject decision can be traced to a named rule with a declared reason,
 * and no model, network call, or widening permission is involved in judging
 * the text.
 */

export const PI_SUMMARY_STATUSES = ["pending", "available", "unavailable"] as const;

export type PiSummaryStatus = (typeof PI_SUMMARY_STATUSES)[number];

export const PI_SUMMARY_UNAVAILABLE_REASONS = [
  /** The settled turn produced no displayable text at all. */
  "no_content",
  /** At least one safety rule identified unsafe material; fail closed. */
  "unsafe_content",
  /**
   * The gate could not positively certify the turn as displayable narrative
   * prose (an execution report or an unrecognised sentence opener); fail
   * closed. The reason enum is additive — clients render an unknown reason
   * as a plain unavailable state.
   */
  "undecidable",
  /** The safety gate itself could not complete a verdict; fail closed. */
  "gate_error",
] as const;

export type PiSummaryUnavailableReason = (typeof PI_SUMMARY_UNAVAILABLE_REASONS)[number];

/** The reason a matched rule yields; `no_content`/`gate_error` are not rule hits. */
export type PiSummaryRuleReason = Extract<
  PiSummaryUnavailableReason,
  "unsafe_content" | "undecidable"
>;

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
 * the structural rules and the prose certification above already gate the
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
 * English. They fail only on structural evidence — a known subcommand, a
 * file-like or quoted or path argument, or a `.` target — so prose like
 * "git history", "make sense", "Node is fast", and "find the bug" stays
 * displayable while "git status", "make install", "node server.js", and
 * "find package.json" do not. They are also exempt from the sentence-opener
 * certification exactly because they are legitimate prose words there.
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
 * item of a certifiable turn must begin with one of these (or a capitalised
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
  // above, and a dotted abbreviation is not a certifiable-sentence signal.
  "e",
];

/**
 * Base-form command and speech-act verbs. Two fail-closed uses:
 * - as a sentence/line opener it is an imperative and never certifies,
 *   even when the sentence carries a narrative marker (`Ensure the lockfile
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
 * not say what was executed, so the turn cannot be certified — reason
 * `undecidable`, not a tool-specific guess.
 */
const EXECUTION_REPORT = String.raw`\b(?:i|we|you|they|he|she|it)\s+(?:just\s+|also\s+|then\s+|quickly\s+|manually\s+|successfully\s+)?(?:ran|run|running|executed|executing|invoked|invoking|called|calling|issued|issuing|typed|typing|launched|launching|started|starting|installed|installing|applied|applying|attempted|attempting|tried|trying|performed|performing)\b\s+\S`;

/**
 * Segment positions at which a certifiable turn must open with a
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

/** No marker may appear between an uncertified opener and the next segment. */
const NO_MARKER_IN_SEGMENT = String.raw`(?!(?:(?!${SEGMENT_START})(?!${NARRATIVE_MARKER})[\s\S])*(?:${NARRATIVE_MARKER}))`;

/**
 * Matches a *violation* of the positive prose certification. Capitalisation
 * confers no exemption (case-insensitive): an opener that is a base
 * command/speech verb is an imperative and fails closed regardless of any
 * marker; any other opener outside the reviewed starter list, the
 * polysemous heads, and the participles/gerunds fails closed unless the
 * same segment carries a narrative marker.
 */
const PROSE_STARTER_VIOLATION = new RegExp(
  String.raw`(?:${SEGMENT_START})${OPENER_SKIP}` +
    String.raw`(?!(?:${alternation(PI_SUMMARY_PROSE_STARTERS)})\b)` +
    String.raw`(?!(?:${alternation(PI_SUMMARY_POLYSEMOUS_COMMAND_TOKENS)})\b)` +
    String.raw`(?!(?:[A-Za-z]{4,}(?:ed|ing)\b))` +
    String.raw`(?:` +
    String.raw`(?=(?:${alternation(PI_SUMMARY_COMMAND_VERBS)})\b)[A-Za-z][\w'-]*` +
    String.raw`|` +
    String.raw`[A-Za-z][\w'-]*${NO_MARKER_IN_SEGMENT}` +
    String.raw`)`,
  "i",
);

/**
 * The ordered fail-closed certification table. Every rule is evaluated
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
      "say what was executed, so the turn cannot be certified (fail closed as undecidable)",
    reason: "undecidable",
    pattern: new RegExp(EXECUTION_REPORT, "i"),
  },
  {
    code: "prose_starter",
    keepsOut:
      "sentence and line openers the gate does not recognise as narrative prose: capitalisation " +
      "confers no exemption, a base command/speech verb opener is an imperative that never " +
      "certifies, and any other unrecognised opener certifies only with an in-segment narrative " +
      "marker — an invocation of a tool no vocabulary lists still cannot be certified at a " +
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
  | { outcome: "available"; text: string }
  | { outcome: "unavailable"; reason: PiSummaryUnavailableReason };

/**
 * Judge one fully assembled turn and produce the display-safe outcome.
 *
 * The gate certifies the complete turn text first; only a turn that passes
 * in full yields an excerpt, and that excerpt is re-validated before
 * release. Unavailable outcomes carry no text of any kind, whichever reason
 * the matched rule declares.
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
  let excerpt: string;
  try {
    excerpt = excerptTurnText(turnText);
    // A turn that produced nothing displayable is explicitly unavailable,
    // distinct from a rule hit.
    if (excerpt.length === 0) {
      return { outcome: "unavailable", reason: "no_content" };
    }
    // The excerpt derives from certified text, but never trust derivation:
    // judge the exact bytes that will be exposed, one last time.
    const excerptViolation = firstSafetyViolation(excerpt, rules);
    if (excerptViolation !== null) {
      return { outcome: "unavailable", reason: excerptViolation.reason };
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
 * settled turn after evaluation, so an unavailable turn leaves no copy of
 * its content anywhere in Node.
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
