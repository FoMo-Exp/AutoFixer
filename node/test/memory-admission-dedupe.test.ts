/**
 * Duplicate detection and the cross-scope dedupe boundary (DAT-234).
 *
 * Merging is the destructive half of dedupe: two distinct memories collapsed
 * into one is information loss that nobody gets back. These tests pin the
 * boundary from both sides — what must merge, and what must be left alone.
 */

import { beforeEach, describe, expect, test } from "vitest";

import { findDuplicate, isDuplicate, memoryContentHash } from "../src/memory/index.js";
import {
  scopesComparableForDedupe,
  scopesMayOverlap,
} from "../src/memory/admission/consistency.js";
import type { MemoryItemRecord } from "../src/memory/index.js";
import { bootstrap, candidate, seedItem } from "./support/memory-admission.js";
import type { Fixture } from "./support/memory-admission.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = bootstrap();
});

function existingFor(...statements: string[]) {
  return statements.map((statement) => seedItem(fixture, fixture.scopeA, { statement }));
}

function hash(overrides = {}) {
  const input = candidate(overrides);
  return memoryContentHash({
    kind: input.kind,
    scope: input.scope,
    statement: input.statement,
    preconditions: input.preconditions,
    sensitivity: input.sensitivity,
  });
}

describe("Canonical hash dedupe", () => {
  test("an identical candidate is an exact duplicate of the existing item", () => {
    const [record] = existingFor(candidate().statement) as [MemoryItemRecord];
    const finding = findDuplicate(candidate(), hash(), fixture.memory.items.list(fixture.scopeA));
    expect(finding).toEqual({
      item_id: record.item.id,
      kind: "exact",
      matched_hash: record.current.content_hash,
    });
  });

  test("a different statement is not a duplicate", () => {
    existingFor(candidate().statement);
    const other = candidate({ statement: "The workspace runs its checks with pnpm build." });
    expect(
      findDuplicate(
        other,
        hash({ statement: other.statement }),
        fixture.memory.items.list(fixture.scopeA),
      ),
    ).toBeNull();
  });

  test("the same words under two disjoint scopes are two memories, not one", () => {
    // The cross-scope dedupe boundary: identical content, different domain.
    const ts = seedItem(fixture, fixture.scopeA, {
      statement: "The build runs tsc before every push.",
      scope: { language: "typescript" },
    });
    const go = candidate({
      statement: "The build runs tsc before every push.",
      scope: { language: "go" },
    });
    const records = fixture.memory.items.list(fixture.scopeA);
    expect(
      findDuplicate(go, hash({ statement: go.statement, scope: go.scope }), records),
    ).toBeNull();
    expect(isDuplicate(go, hash({ statement: go.statement, scope: go.scope }), records)).toBe(
      false,
    );
    // Both survive as their own item.
    expect(records.map((r) => r.item.id)).toContain(ts.item.id);
  });

  test("a narrower scope is a different memory even though it is contained", () => {
    // Dedupe never crosses a scope boundary. Merging the narrow claim into the
    // broad one would drop which domain it was about.
    seedItem(fixture, fixture.scopeA, {
      statement: "The build runs tsc before every push.",
      scope: {},
    });
    const narrow = candidate({
      statement: "The build runs tsc before every push.",
      scope: { language: "typescript" },
    });
    const records = fixture.memory.items.list(fixture.scopeA);
    expect(
      findDuplicate(narrow, hash({ statement: narrow.statement, scope: narrow.scope }), records),
    ).toBeNull();
  });

  test("identical scope plus identical content is an exact duplicate", () => {
    const record = seedItem(fixture, fixture.scopeA, {
      statement: "The build runs tsc before every push.",
      scope: { language: "typescript" },
    });
    const same = candidate({
      statement: "The build runs tsc before every push.",
      scope: { language: "typescript" },
    });
    const finding = findDuplicate(
      same,
      hash({ statement: same.statement, scope: same.scope }),
      fixture.memory.items.list(fixture.scopeA),
    );
    expect(finding).toEqual({
      item_id: record.item.id,
      kind: "exact",
      matched_hash: record.current.content_hash,
    });
  });

  test("nested path prefixes still count as different scopes for dedupe", () => {
    // /node contains /node/src, so the two can fight over the same ground and
    // be compared for contradiction — but they are not the same memory, so
    // dedupe leaves them apart.
    expect(scopesMayOverlap({ path_prefix: "/node" }, { path_prefix: "/node/src" })).toBe(true);
    expect(scopesComparableForDedupe({ path_prefix: "/node" }, { path_prefix: "/node/src" })).toBe(
      false,
    );
    expect(scopesMayOverlap({ path_prefix: "/web" }, { path_prefix: "/node" })).toBe(false);
    expect(scopesComparableForDedupe({ path_prefix: "/node" }, { path_prefix: "/node" })).toBe(
      true,
    );
  });

  test("cross-workspace comparison is unreachable, not merely discouraged", () => {
    // The same statement exists in a foreign workspace. The gate is handed
    // only the caller's own workspace items, so it can neither see nor merge
    // into them.
    seedItem(fixture, fixture.scopeForeign, {
      statement: "The workspace runs its checks with npm run lint before every push.",
    });
    const records = fixture.memory.items.list(fixture.scopeA);
    expect(records).toHaveLength(0);
    expect(findDuplicate(candidate(), hash(), records)).toBeNull();
  });
});

describe("Semantic near-duplicate detection", () => {
  test("a rewording of the same claim merges into the existing item", () => {
    const [record] = existingFor(
      "The workspace runs its checks with npm run lint before every push.",
    ) as [MemoryItemRecord];
    const reworded = candidate({
      statement: "The workspace runs its checks with npm run lint before every push", // trailing period gone
    });
    const finding = findDuplicate(
      reworded,
      hash({ statement: reworded.statement }),
      fixture.memory.items.list(fixture.scopeA),
    );
    expect(finding).toEqual({
      item_id: record.item.id,
      kind: "near",
      matched_hash: record.current.content_hash,
    });
  });

  test("a genuinely different fact is left alone even with shared words", () => {
    existingFor("The workspace runs its checks with npm run lint before every push.");
    const other = candidate({
      statement:
        "The workspace runs its checks with npm run lint and prettier before every push to a release branch.",
    });
    expect(
      findDuplicate(
        other,
        hash({ statement: other.statement }),
        fixture.memory.items.list(fixture.scopeA),
      ),
    ).toBeNull();
  });

  test("the same statement under different preconditions is not a duplicate", () => {
    existingFor("Run the migration before deploying.");
    const other = candidate({
      statement: "Run the migration before deploying.",
      preconditions: ["when the schema changed"],
    });
    expect(
      findDuplicate(
        other,
        hash({ statement: other.statement, preconditions: other.preconditions }),
        fixture.memory.items.list(fixture.scopeA),
      ),
    ).toBeNull();
  });

  test("a polarity flip is a contradiction candidate, never a duplicate", () => {
    existingFor("The workspace runs its checks with npm run lint before every push.");
    const flipped = candidate({
      statement: "The workspace never runs its checks with npm run lint before every push.",
    });
    expect(
      findDuplicate(
        flipped,
        hash({ statement: flipped.statement }),
        fixture.memory.items.list(fixture.scopeA),
      ),
    ).toBeNull();
  });

  test("a near-duplicate does not merge across kinds", () => {
    existingFor("The workspace runs its checks with npm run lint before every push.");
    const asLesson = candidate({
      kind: "lesson",
      statement: "The workspace runs its checks with npm run lint before every push",
    });
    expect(
      findDuplicate(
        asLesson,
        hash({ statement: asLesson.statement, kind: asLesson.kind }),
        fixture.memory.items.list(fixture.scopeA),
      ),
    ).toBeNull();
  });
});

describe("Scope overlap semantics differ per question", () => {
  test("dedupe requires containment, contradiction only requires possible overlap", () => {
    const a = { language: "typescript" };
    const b = { task_family: "build" };
    // Different dimensions may well meet — that is enough for a conflict.
    expect(scopesMayOverlap(a, b)).toBe(true);
    // But neither contains the other, so they are not the same memory.
    expect(scopesComparableForDedupe(a, b)).toBe(false);
  });

  test("scopes pinned to different values of the same dimension never meet", () => {
    expect(scopesMayOverlap({ language: "typescript" }, { language: "go" })).toBe(false);
    expect(scopesComparableForDedupe({ language: "typescript" }, { language: "go" })).toBe(false);
  });
});
