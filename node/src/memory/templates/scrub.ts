/**
 * Template scrubbing (DAT-237).
 *
 * Publication is the only point where memory leaves one workspace for another,
 * so scrubbing fails closed: every detector either removes a match or aborts
 * the publication. A template that still contains a credential, source
 * workspace identifier, issue/PR link, log excerpt, or personal-data marker
 * after this pass is never persisted.
 *
 * The report is counts-only by design. Persisting the removed text — even for
 * "audit" — would recreate the very leak scrubbing exists to prevent.
 */

import { ValidationError } from "../../control-plane/errors.js";
import type { MemoryApplicability, MemoryEvidenceType, MemorySensitivity } from "../types.js";
import type {
  EnterpriseTemplateKind,
  ScrubRedactionKind,
  ScrubbedTemplateContent,
  SourceIdentityTerms,
  TemplateScrubReport,
} from "./types.js";

/** Hard caps keep a template short, reviewable, and cheap to render. */
export const MAX_TEMPLATE_STATEMENT_CHARS = 2000;
export const MAX_TEMPLATE_PRECONDITION_CHARS = 500;
export const MAX_TEMPLATE_PRECONDITIONS = 8;
/** Scrubbing can only shrink text, so the source may be up to four times the published cap. */
const MAX_SOURCE_CHARS = MAX_TEMPLATE_STATEMENT_CHARS * 4;
const MAX_SOURCE_PRECONDITION_CHARS = MAX_TEMPLATE_PRECONDITION_CHARS * 4;

/**
 * Highest-trust evidence class first. A template keeps the strongest class it
 * can justify; the payload itself stays behind.
 */
const EVIDENCE_TRUST_ORDER: readonly MemoryEvidenceType[] = [
  "reviewer_decision",
  "test",
  "commit",
  "pr",
  "issue",
  "run",
  "incident",
];

export function orderEvidenceClasses(classes: readonly MemoryEvidenceType[]): MemoryEvidenceType[] {
  return EVIDENCE_TRUST_ORDER.filter((entry) => classes.includes(entry));
}

interface InlineRule {
  kind: ScrubRedactionKind;
  pattern: RegExp;
  replacement: string;
}

const CREDENTIAL_RULES: readonly InlineRule[] = [
  // Private key blocks first: their body would otherwise trip the digest rule.
  {
    kind: "credential",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[credential]",
  },
  {
    kind: "credential",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[credential]",
  },
  {
    kind: "credential",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[credential]",
  },
  {
    kind: "credential",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[credential]",
  },
  { kind: "credential", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[credential]" },
  { kind: "credential", pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, replacement: "[credential]" },
  {
    kind: "credential",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[credential]",
  },
  {
    kind: "credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "Bearer [credential]",
  },
  {
    // `password = hunter2`, `api_key: abc…`: keep the label, drop the value.
    kind: "credential",
    pattern: /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/gi,
    replacement: "$1=[credential]",
  },
];

const PII_RULES: readonly InlineRule[] = [
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[email]",
  },
  {
    // Label plus value: "customer: Jane Doe", "employee email = …".
    kind: "personal_data_label",
    pattern:
      /\b(customer|client|employee|staff|patient|contact)\s*(?:name|email|phone|address)?\s*[:=]\s*[^\n,;。]+/gi,
    replacement: "[personal-data]",
  },
  {
    // International-ish phone shape; deliberately avoids ISO timestamps.
    kind: "phone",
    pattern: /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    replacement: "[phone]",
  },
];

const LOCATION_RULES: readonly InlineRule[] = [
  {
    kind: "local_path",
    pattern: /(?:[A-Za-z]:\\Users\\|\/(?:Users|home)\/)[^\s"'`)]+/g,
    replacement: "[path]",
  },
  {
    kind: "ip_address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "[ip]",
  },
];

const REFERENCE_RULES: readonly InlineRule[] = [
  { kind: "url", pattern: /\bhttps?:\/\/[^\s"'`)\]]+/gi, replacement: "[link]" },
  {
    // owner/repo#123
    kind: "issue_reference",
    pattern: /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/g,
    replacement: "[issue]",
  },
  {
    // Issue keys such as DAT-237; ADR document numbers are public references.
    kind: "issue_reference",
    pattern: /(?<!ADR-)\b[A-Z]{2,10}-\d{2,6}\b/g,
    replacement: "[issue]",
  },
];

const CONTROL_TOKEN_RULE: InlineRule = {
  kind: "control_token",
  pattern: /<\|[^|\n]*\|>/g,
  replacement: "[control-token]",
};

/** High-entropy tokens: commit SHAs, content hashes, opaque secrets. */
const DIGEST_RULE: InlineRule = {
  kind: "long_digest",
  pattern: /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/=_-]{48,})\b/g,
  replacement: "[digest]",
};

const LOG_LINE_PATTERNS: readonly RegExp[] = [
  // Timestamped record, optionally with a level.
  /^\s*\[[^\]]*\]?\s*\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\s+(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/,
  /^\s*\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?\s+(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/,
  // Level then a padded message column.
  /^\s*(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\s{2,}\S/,
  // Stack frames and tracebacks.
  /^\s*at\s+\S+\s+\(?.*:\d+(?::\d+)?\)?\s*$/,
  /^\s*Traceback \(most recent call last\)\s*$/,
  /^\s*File ".*", line \d+/,
];

/** Residual detectors: if any still matches, publication aborts. */
const RESIDUAL_RULES: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  // Token-shaped credentials only: the `key=value` rule intentionally leaves
  // `password=[credential]` behind, so it must not be asserted on again.
  { code: "credential", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { code: "credential", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { code: "credential", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { code: "credential", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "credential", pattern: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { code: "credential", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { code: "credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { code: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  {
    code: "issue_link",
    pattern: /\bhttps?:\/\/[^\s"'`)\]]+\/(?:issues|pull|merge_requests|discussions|commits)\//i,
  },
  { code: "control_token", pattern: /<\|[^|\n]*\|>/ },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatch(text: string, pattern: RegExp): number {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  return (text.match(global) ?? []).length;
}

interface IdentityTerm {
  term: string;
  placeholder: string;
  kind: ScrubRedactionKind;
}

/**
 * Build the identity matcher. Terms are matched case-insensitively as literal
 * substrings; very short terms are skipped so a two-letter team name cannot
 * shred every sentence. Longer terms run first so `acme-secret-repo` is removed
 * before the shorter `acme` inside it.
 */
export function buildIdentityTerms(identity: SourceIdentityTerms): IdentityTerm[] {
  const byTerm = new Map<string, IdentityTerm>();
  const add = (term: string, placeholder: string, kind: ScrubRedactionKind) => {
    const trimmed = term.trim();
    if (trimmed.length < 3) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (!byTerm.has(key)) {
      byTerm.set(key, { term: trimmed, placeholder, kind });
    }
  };
  // Specificity order: workspace content first, then teams, then the tenant.
  for (const workspace of identity.workspaces) {
    add(workspace.id, "[workspace]", "workspace_identifier");
    add(workspace.name, "[workspace]", "workspace_identifier");
    add(workspace.repository_id, "[workspace]", "workspace_identifier");
  }
  for (const repository of identity.repository_names) {
    add(repository, "[workspace]", "workspace_identifier");
  }
  for (const team of identity.teams) {
    add(team.id, "[team]", "team_identifier");
    add(team.name, "[team]", "team_identifier");
  }
  add(identity.enterprise.id, "[enterprise]", "enterprise_identifier");
  add(identity.enterprise.name, "[enterprise]", "enterprise_identifier");
  add(identity.enterprise.slug, "[enterprise]", "enterprise_identifier");
  return [...byTerm.values()].sort((a, b) => b.term.length - a.term.length);
}

interface MutableReport {
  redactions: Partial<Record<ScrubRedactionKind, number>>;
  removedScopeFields: string[];
  evidenceClasses: MemoryEvidenceType[];
  sourceEvidenceCount: number;
  removedLogLines: number;
}

function countRedaction(report: MutableReport, kind: ScrubRedactionKind, amount: number): void {
  if (amount <= 0) {
    return;
  }
  report.redactions[kind] = (report.redactions[kind] ?? 0) + amount;
}

function applyRule(text: string, rule: InlineRule, report: MutableReport): string {
  const matches = countMatch(text, rule.pattern);
  if (matches === 0) {
    return text;
  }
  countRedaction(report, rule.kind, matches);
  return text.replace(rule.pattern, rule.replacement);
}

function stripLogLines(text: string, report: MutableReport): string {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => !LOG_LINE_PATTERNS.some((pattern) => pattern.test(line)));
  const removed = lines.length - kept.length;
  if (removed > 0) {
    report.removedLogLines += removed;
  }
  return kept.join("\n");
}

function applyIdentityTerms(
  text: string,
  terms: readonly IdentityTerm[],
  report: MutableReport,
): string {
  let result = text;
  for (const { term, placeholder, kind } of terms) {
    const pattern = new RegExp(escapeRegExp(term), "gi");
    const matches = countMatch(result, pattern);
    if (matches > 0) {
      countRedaction(report, kind, matches);
      result = result.replace(pattern, placeholder);
    }
  }
  return result;
}

function scrubText(text: string, terms: readonly IdentityTerm[], report: MutableReport): string {
  let result = stripLogLines(text, report);
  for (const rule of CREDENTIAL_RULES) {
    result = applyRule(result, rule, report);
  }
  result = applyRule(result, CONTROL_TOKEN_RULE, report);
  for (const rule of REFERENCE_RULES) {
    result = applyRule(result, rule, report);
  }
  for (const rule of PII_RULES) {
    result = applyRule(result, rule, report);
  }
  for (const rule of LOCATION_RULES) {
    result = applyRule(result, rule, report);
  }
  result = applyRule(result, DIGEST_RULE, report);
  result = applyIdentityTerms(result, terms, report);
  return result
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Scrub a scope value. A value that had to be redacted is dropped rather than
 * published with a placeholder: `[workspace]/node` is not a usable path
 * prefix, and keeping it would preserve the shape of the source layout.
 */
function scrubScopeValue(
  field: string,
  value: string,
  terms: readonly IdentityTerm[],
  report: MutableReport,
): string | null {
  const before = totalRedactions(report.redactions);
  const scrubbed = scrubText(value, terms, report);
  const redacted = totalRedactions(report.redactions) > before;
  // A scope value that needed redaction is dropped: `[workspace]/node` is not a
  // usable path prefix, and publishing it would preserve the source layout's
  // shape.
  if (redacted || scrubbed.length === 0) {
    report.removedScopeFields.push(field);
    return null;
  }
  return scrubbed;
}

function totalRedactions(redactions: Partial<Record<ScrubRedactionKind, number>>): number {
  return Object.values(redactions).reduce((sum, count) => sum + (count ?? 0), 0);
}

/** Non-global copy so repeated `.test` calls cannot carry `lastIndex`. */
function matchesAnywhere(text: string, pattern: RegExp): boolean {
  return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text);
}

/** Detect anything the scrubber failed to remove. */
function assertClean(
  content: { statement: string; preconditions: readonly string[] },
  terms: readonly IdentityTerm[],
): void {
  const haystacks = [content.statement, ...content.preconditions];
  for (const entry of terms) {
    const pattern = new RegExp(escapeRegExp(entry.term), "i");
    if (haystacks.some((text) => pattern.test(text))) {
      throw new ValidationError(
        `template publication blocked: source identifier survived scrubbing (${entry.kind})`,
      );
    }
  }
  for (const rule of RESIDUAL_RULES) {
    if (haystacks.some((text) => matchesAnywhere(text, rule.pattern))) {
      throw new ValidationError(`template publication blocked: ${rule.code} survived scrubbing`);
    }
  }
}

/** Validate that the source content fits the template contract, before scrubbing. */
export function assertTemplateContentLimits(
  statement: string,
  preconditions: readonly string[],
): void {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new ValidationError("template statement must be a non-empty string");
  }
  if (statement.length > MAX_SOURCE_CHARS) {
    throw new ValidationError(
      `template statement exceeds the ${MAX_SOURCE_CHARS}-character source cap`,
    );
  }
  if (preconditions.length > MAX_TEMPLATE_PRECONDITIONS) {
    throw new ValidationError(
      `template preconditions exceed the ${MAX_TEMPLATE_PRECONDITIONS}-entry cap`,
    );
  }
  for (const precondition of preconditions) {
    if (typeof precondition !== "string" || precondition.trim().length === 0) {
      throw new ValidationError("template preconditions must be non-empty strings");
    }
    if (precondition.length > MAX_SOURCE_PRECONDITION_CHARS) {
      throw new ValidationError(
        `template precondition exceeds the ${MAX_SOURCE_PRECONDITION_CHARS}-character source cap`,
      );
    }
  }
}

export interface ScrubInput {
  kind: EnterpriseTemplateKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: readonly string[];
  sensitivity: MemorySensitivity;
  evidenceClasses: readonly MemoryEvidenceType[];
  evidenceCount: number;
  identity: SourceIdentityTerms;
}

/**
 * Scrub one source version into template content. Throws `ValidationError`
 * when the result would still leak; nothing is persisted on failure.
 */
export function scrubTemplateContent(input: ScrubInput): ScrubbedTemplateContent {
  assertTemplateContentLimits(input.statement, input.preconditions);
  const terms = buildIdentityTerms(input.identity);
  const report: MutableReport = {
    redactions: {},
    removedScopeFields: [],
    evidenceClasses: orderEvidenceClasses(input.evidenceClasses),
    sourceEvidenceCount: input.evidenceCount,
    removedLogLines: 0,
  };

  const statement = scrubText(input.statement, terms, report);
  if (statement.length === 0) {
    throw new ValidationError("template statement is empty after scrubbing");
  }
  if (statement.length > MAX_TEMPLATE_STATEMENT_CHARS) {
    throw new ValidationError(
      `template statement exceeds ${MAX_TEMPLATE_STATEMENT_CHARS} characters after scrubbing`,
    );
  }

  const preconditions: string[] = [];
  for (const raw of input.preconditions) {
    const scrubbed = scrubText(raw, terms, report);
    if (scrubbed.length === 0) {
      // A precondition that was only an identifier adds nothing; dropping it is
      // safe (preconditions widen applicability, never narrow beyond content).
      report.removedScopeFields.push("precondition");
      continue;
    }
    if (scrubbed.length > MAX_TEMPLATE_PRECONDITION_CHARS) {
      throw new ValidationError(
        `template precondition exceeds ${MAX_TEMPLATE_PRECONDITION_CHARS} characters after scrubbing`,
      );
    }
    preconditions.push(scrubbed);
  }
  if (preconditions.length > MAX_TEMPLATE_PRECONDITIONS) {
    throw new ValidationError(
      `template preconditions exceed the ${MAX_TEMPLATE_PRECONDITIONS}-entry cap after scrubbing`,
    );
  }

  const scope: Record<string, string> = {};
  for (const field of ["path_prefix", "language", "task_family"] as const) {
    const value = input.scope[field];
    if (value === undefined) {
      continue;
    }
    const scrubbed = scrubScopeValue(field, value, terms, report);
    if (scrubbed !== null) {
      scope[field] = scrubbed;
    }
  }
  if (input.scope["team_id"] !== undefined) {
    report.removedScopeFields.push("team_id");
  }

  assertClean({ statement, preconditions }, terms);

  const scrubReport: TemplateScrubReport = {
    redactions: report.redactions,
    removed_scope_fields: report.removedScopeFields,
    evidence_classes: report.evidenceClasses,
    source_evidence_count: report.sourceEvidenceCount,
    removed_log_lines: report.removedLogLines,
    residual_scan: "clean",
  };

  return {
    kind: input.kind,
    scope,
    statement,
    preconditions,
    sensitivity: input.sensitivity,
    report: scrubReport,
  };
}
