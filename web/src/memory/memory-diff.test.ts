import { describe, expect, it } from "vitest";
import { diffLines, diffWords } from "./memory-diff";

function text(rows: Array<{ kind: string; text: string }>): string {
  return rows.map((row) => row.text).join("");
}

describe("memory diff", () => {
  it("marks unchanged text as one same row on both sides", () => {
    const diff = diffWords("Raise the share ceiling", "Raise the share ceiling");
    expect(diff.base).toEqual([{ kind: "same", text: "Raise the share ceiling" }]);
    expect(diff.target).toEqual([{ kind: "same", text: "Raise the share ceiling" }]);
  });

  it("marks changed words on the side that owns them and preserves both texts", () => {
    const diff = diffWords("Raise the total budget", "Raise the share budget");
    expect(diff.base.some((row) => row.kind === "removed" && row.text.includes("total"))).toBe(
      true,
    );
    expect(diff.target.some((row) => row.kind === "added" && row.text.includes("share"))).toBe(
      true,
    );
    expect(diff.base.some((row) => row.kind === "removed" && row.text.includes("share"))).toBe(
      false,
    );
    expect(text(diff.base)).toBe("Raise the total budget");
    expect(text(diff.target)).toBe("Raise the share budget");
  });

  it("compares preconditions as whole entries", () => {
    const diff = diffLines(
      ["bundle at budget", "policy item active"],
      ["bundle at budget", "lesson item active"],
    );
    expect(diff.base).toEqual([
      { kind: "same", text: "bundle at budget" },
      { kind: "removed", text: "policy item active" },
    ]);
    expect(diff.target).toEqual([
      { kind: "same", text: "bundle at budget" },
      { kind: "added", text: "lesson item active" },
    ]);
  });

  it("treats an empty history as no rows rather than invented content", () => {
    expect(diffLines([], [])).toEqual({ base: [], target: [] });
  });
});
