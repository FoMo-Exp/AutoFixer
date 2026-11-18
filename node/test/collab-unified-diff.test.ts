import { describe, expect, test } from "vitest";

import {
  PatchFormatError,
  applyFileChange,
  changeMode,
  decodeGitPath,
  parseUnifiedDiff,
} from "../src/collab/unified-diff.js";

/**
 * The retained candidate patch is the authority for what a delivery pushes
 * (DAT-260). The adapter reconstructs the approved tree from it against the
 * pinned base blobs, so the parser and applier are tested on the exact forms
 * `git diff --no-renames --unified=3` emits, including the ones that are easy to
 * get subtly wrong (zero-length ranges, mode-only changes, missing final
 * newlines, quoted paths) and the ones that must be refused (binary and
 * submodule patches are not reproducible from a diff).
 */

function codes(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PatchFormatError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a PatchFormatError");
}

const BASE = ["line one", "line two", "line three", "line four", ""].join("\n");

describe("parse and apply", () => {
  test("applies a modify hunk with context", () => {
    const diff = [
      "diff --git a/src/file.txt b/src/file.txt",
      "index 1111111..2222222 100644",
      "--- a/src/file.txt",
      "+++ b/src/file.txt",
      "@@ -2,3 +2,3 @@ function header",
      " line two",
      "-line three",
      "+line three changed",
      " line four",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("modify");
    expect(changes[0]?.path).toBe("src/file.txt");
    expect(applyFileChange(BASE, changes[0]!)).toBe(
      ["line one", "line two", "line three changed", "line four", ""].join("\n"),
    );
  });

  test("applies an added file from an empty base", () => {
    const diff = [
      "diff --git a/new/file.txt b/new/file.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/new/file.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(changes[0]?.kind).toBe("add");
    expect(applyFileChange(null, changes[0]!)).toBe("first\nsecond\n");
    expect(codes(() => applyFileChange(BASE, changes[0]!))).toBe("context_mismatch");
  });

  test("applies a deleted file", () => {
    const diff = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(changes[0]?.kind).toBe("delete");
    expect(applyFileChange("one\ntwo\n", changes[0]!)).toBeNull();
    expect(codes(() => applyFileChange(null, changes[0]!))).toBe("context_mismatch");
  });

  test("refuses a deletion whose removed content does not match the base", () => {
    const diff = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-WRONG",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(codes(() => applyFileChange("one\ntwo\n", changes[0]!))).toBe("context_mismatch");
  });

  test("refuses a deletion that does not remove the whole base file", () => {
    const diff = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-one",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(codes(() => applyFileChange("one\ntwo\n", changes[0]!))).toBe("context_mismatch");
  });

  test("applies the deletion of an empty file that carries no hunks", () => {
    const diff = [
      "diff --git a/empty.txt b/empty.txt",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(applyFileChange("", changes[0]!)).toBeNull();
    expect(codes(() => applyFileChange("not empty\n", changes[0]!))).toBe("context_mismatch");
  });

  test("records a mode-only change without touching content", () => {
    const diff = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join(
      "\n",
    );
    const changes = parseUnifiedDiff(diff);
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.kind).toBe("modify");
    expect(change.hunks).toHaveLength(0);
    expect(applyFileChange(BASE, change)).toBe(BASE);
    expect(changeMode(change, "100644")).toBe("100755");
  });

  test("honours a missing final newline marker", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,2 @@",
      " first",
      "-second",
      "\\ No newline at end of file",
      "+second changed",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(applyFileChange("first\nsecond", changes[0]!)).toBe("first\nsecond changed");
  });

  test("inserts at the beginning with a zero-length old range", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -0,0 +1,1 @@",
      "+before",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(applyFileChange("line one\n", changes[0]!)).toBe("before\nline one\n");
  });

  test("inserts after a named line in the middle", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -2,0 +3,1 @@",
      "+inserted",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(applyFileChange("one\ntwo\nthree\n", changes[0]!)).toBe("one\ntwo\ninserted\nthree\n");
  });

  test("applies multiple hunks in one file", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,2 +1,2 @@",
      "-one",
      "+ONE",
      " two",
      "@@ -4,1 +4,1 @@",
      "-four",
      "+FOUR",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(applyFileChange("one\ntwo\nthree\nfour\n", changes[0]!)).toBe("ONE\ntwo\nthree\nFOUR\n");
  });

  test("decodes tab-terminated and C-quoted paths", () => {
    expect(decodeGitPath("a/path with spaces.txt\t")).toBe("a/path with spaces.txt");
    expect(decodeGitPath('"a/\\303\\274.txt"')).toBe("a/ü.txt");
    expect(decodeGitPath('"a/\\"quoted\\".txt"')).toBe('a/"quoted".txt');
  });

  test("parses a diff with a space in the path and a quoted path", () => {
    const diff = [
      "diff --git a/path with spaces.txt b/path with spaces.txt",
      "--- a/path with spaces.txt\t",
      "+++ b/path with spaces.txt\t",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      'diff --git "a/\\303\\274.txt" "b/\\303\\274.txt"',
      '--- "a/\\303\\274.txt"',
      '+++ "b/\\303\\274.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(changes.map((change) => change.path)).toEqual(["path with spaces.txt", "ü.txt"]);
  });
});

describe("refusals", () => {
  test("refuses a binary patch", () => {
    const diff = [
      "diff --git a/image.png b/image.png",
      "index 5555555..6666666 100644",
      "GIT binary patch",
      "literal 4",
      "LcmZQzU|?Vb",
      "",
    ].join("\n");
    expect(codes(() => parseUnifiedDiff(diff))).toBe("binary_patch");
  });

  test("refuses a submodule patch", () => {
    const diff = [
      "diff --git a/vendor/lib b/vendor/lib",
      "index 7777777..8888888 160000",
      "--- a/vendor/lib",
      "+++ b/vendor/lib",
      "@@ -1 +1 @@",
      "-Subproject commit 7777777",
      "+Subproject commit 8888888",
      "",
    ].join("\n");
    expect(codes(() => parseUnifiedDiff(diff))).toBe("submodule_patch");
  });

  test("refuses context that does not match the base", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -2 +2 @@",
      "-another line",
      "+replacement",
      "",
    ].join("\n");
    const changes = parseUnifiedDiff(diff);
    expect(codes(() => applyFileChange("one\ntwo\n", changes[0]!))).toBe("context_mismatch");
  });

  test("refuses a hunk whose header counts do not match its content", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1,3 +1,1 @@",
      "-one",
      "+ONE",
      "",
    ].join("\n");
    expect(codes(() => parseUnifiedDiff(diff))).toBe("malformed_patch");
  });

  test("refuses an unterminated quoted path", () => {
    expect(codes(() => decodeGitPath('"a/unterminated'))).toBe("malformed_patch");
  });

  test("a rename header is not silently treated as an edit of a new path", () => {
    const diff = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
      "",
    ].join("\n");
    expect(codes(() => parseUnifiedDiff(diff))).toBe("malformed_patch");
  });
});
