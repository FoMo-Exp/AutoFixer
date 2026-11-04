/**
 * Deterministic text primitives for bounded retrieval (DAT-236).
 *
 * Everything here is pure and dependency-free so bundle assembly is
 * reproducible: the same corpus, policy version, and query produce the same
 * scores, the same injected set, and the same memory version digest on every
 * process.
 */

import { createHash } from "node:crypto";

import type { MemoryApplicability } from "../types.js";

/** Token estimate used for budgeting. Deliberately conservative and stable. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "we",
  "were",
  "will",
  "with",
  "you",
]);

/** Lowercase alphanumeric tokens; identifiers, paths, and flags survive. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_./:-]+/)) {
    const token = raw.replace(/^[./:_-]+|[./:_-]+$/g, "");
    if (token.length < 2 || token.length > 64 || STOPWORDS.has(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

export interface Bm25Options {
  k1: number;
  b: number;
}

export const DEFAULT_BM25: Bm25Options = Object.freeze({ k1: 1.2, b: 0.75 });

/**
 * BM25 over the eligible corpus. The result is squashed into [0, 1) with
 * `score / (score + 1)`, which keeps the hybrid blend bounded and monotonic
 * without letting a single long document dominate.
 */
export function bm25Scores(
  documents: string[][],
  query: string[],
  options: Bm25Options = DEFAULT_BM25,
): number[] {
  const docCount = documents.length;
  if (docCount === 0) {
    return [];
  }
  const docLengths = documents.map((tokens) => tokens.length);
  const averageLength =
    docLengths.reduce((sum, length) => sum + length, 0) / Math.max(1, docCount) || 1;

  const documentFrequency = new Map<string, number>();
  for (const tokens of documents) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const uniqueQuery = [...new Set(query)];
  return documents.map((tokens) => {
    if (uniqueQuery.length === 0) {
      return 0;
    }
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    let score = 0;
    for (const term of uniqueQuery) {
      const frequency = frequencies.get(term);
      if (frequency === undefined) {
        continue;
      }
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const denominator =
        frequency + options.k1 * (1 - options.b + (options.b * tokens.length) / averageLength);
      score += (idf * frequency * (options.k1 + 1)) / denominator;
    }
    return score <= 0 ? 0 : score / (score + 1);
  });
}

/**
 * Cosine similarity in [0, 1]. Negative similarity carries no retrieval
 * meaning here, and malformed or mismatched vectors score zero rather than
 * failing the whole bundle.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return 0;
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))));
}

/** Half-life recency in [0, 1]; future timestamps score 1, not above. */
export function recencyScore(observedAt: string, now: Date, halfLifeDays: number): number {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) {
    return 0;
  }
  const ageDays = Math.max(0, (now.getTime() - observed) / (24 * 60 * 60 * 1000));
  const halfLife = Math.max(0.5, halfLifeDays);
  return Math.max(0, Math.min(1, Math.pow(0.5, ageDays / halfLife)));
}

/**
 * Memory text is untrusted data, never markup. Control tokens are removed and
 * angle brackets escaped so item content can neither close the surrounding
 * data fence nor smuggle a tool/system instruction into the prompt.
 */
export function sanitizeMemoryText(text: string): string {
  return (
    text
      // Control characters (NUL included) are stripped: they are never part of
      // legitimate memory text and are a common prompt-splitting trick.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(/<\|[^|]*\|>/g, " ")
      .replace(/<<\s*\/?\s*sys\s*>>/gi, " ")
      .replace(/\[\/?inst\]/gi, " ")
      .replace(/<\/?\s*(memory|system|assistant|tool|instructions?)\b[^>]*>/gi, " ")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

/** Scope fields as prompt-visible applicability text. */
export function describeApplicability(scope: MemoryApplicability): string {
  const parts: string[] = [];
  if (scope.team_id !== undefined && scope.team_id.length > 0) {
    parts.push(`team=${scope.team_id}`);
  }
  if (scope.path_prefix !== undefined && scope.path_prefix.length > 0) {
    parts.push(`path=${scope.path_prefix}`);
  }
  if (scope.language !== undefined && scope.language.length > 0) {
    parts.push(`language=${scope.language}`);
  }
  if (scope.task_family !== undefined && scope.task_family.length > 0) {
    parts.push(`task=${scope.task_family}`);
  }
  return parts.length > 0 ? parts.join(", ") : "broad";
}

/**
 * Deterministic corpus digest. It covers every stored item's current version
 * and content hash plus the policy version, so a bundle's `memory_version`
 * changes whenever the memory a run would read changes.
 */
export function computeMemoryVersion(
  entries: ReadonlyArray<{ item_id: string; version: number; content_hash: string }>,
  policyVersion: number,
): string {
  const hash = createHash("sha256");
  hash.update(`policy:${policyVersion}\n`, "utf8");
  const ordered = [...entries].sort((left, right) => left.item_id.localeCompare(right.item_id));
  for (const entry of ordered) {
    hash.update(`${entry.item_id}\u0000${entry.version}\u0000${entry.content_hash}\n`, "utf8");
  }
  return `m1.${hash.digest("hex").slice(0, 32)}`;
}
