/**
 * Canonical content hashing for memory versions (DAT-232).
 *
 * The hash covers exactly the version's content fields — kind, applicability
 * scope, statement, preconditions, sensitivity — in a stable canonical form so
 * that an identical write produces the same hash (idempotency) and duplicate
 * content is detectable. Provenance, trust, and temporal metadata are not
 * content: the same statement authored twice is the same memory.
 */

import { createHash } from "node:crypto";

import type { MemoryApplicability, MemoryKind, MemorySensitivity } from "./types.js";

export interface MemoryContentInput {
  kind: MemoryKind;
  scope: MemoryApplicability;
  statement: string;
  preconditions: string[];
  sensitivity: MemorySensitivity;
}

/**
 * Canonical JSON with a fixed key order and sorted preconditions. Written out
 * field by field instead of JSON.stringify-ing caller objects so two equal
 * contents always serialize to the same bytes regardless of key order.
 */
function canonicalJson(input: MemoryContentInput): string {
  const scope = input.scope;
  const scopePairs: [string, string][] = [
    ["language", scope.language ?? ""],
    ["path_prefix", scope.path_prefix ?? ""],
    ["task_family", scope.task_family ?? ""],
    ["team_id", scope.team_id ?? ""],
  ];
  const scopeJson = `{${scopePairs
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(",")}}`;
  const preconditionsJson = `[${[...input.preconditions]
    .sort()
    .map((entry) => JSON.stringify(entry))
    .join(",")}]`;
  return `{${JSON.stringify("kind")}:${JSON.stringify(input.kind)},${JSON.stringify(
    "preconditions",
  )}:${preconditionsJson},${JSON.stringify("scope")}:${scopeJson},${JSON.stringify(
    "sensitivity",
  )}:${JSON.stringify(input.sensitivity)},${JSON.stringify("statement")}:${JSON.stringify(
    input.statement,
  )}}`;
}

/** SHA-256 of the canonical content form, hex-encoded. */
export function memoryContentHash(input: MemoryContentInput): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}
