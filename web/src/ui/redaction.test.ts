import { describe, expect, it } from "vitest";
import { redactText, sanitizeValue } from "./redaction";

describe("redaction", () => {
  it("removes credentials and local paths from user-facing text", () => {
    expect(
      redactText("Bearer ghp_12345 token=abc /Users/alice/project/file.ts C:\\work\\secret.txt"),
    ).toBe("Bearer [redacted] token: [redacted] [path redacted] [path redacted]");
  });

  it("sanitizes nested artifact values", () => {
    expect(sanitizeValue({ output: "/home/alice/task", nested: ["sk-live_abc"] })).toEqual({
      output: "[path redacted]",
      nested: ["[redacted]"],
    });
  });
});
