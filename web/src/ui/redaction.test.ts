import { describe, expect, it } from "vitest";
import { redactText, sanitizeValue } from "./redaction";

describe("redaction", () => {
  it("removes credentials and local paths from user-facing text", () => {
    expect(
      redactText("Bearer ghp_12345 token=abc /Users/alice/project/file.ts C:\\work\\secret.txt"),
    ).toBe("Bearer [redacted] token: [redacted] [path redacted] [path redacted]");
  });

  it("sanitizes nested artifact values", () => {
    expect(
      sanitizeValue({
        output: "/home/alice/task",
        nested: ["sk-live_abc"],
        command: "git diff --stat",
        stdout: "raw log output",
        logs: "an unredacted log line",
      }),
    ).toEqual({
      output: "[redacted]",
      nested: ["[redacted]"],
      command: "[redacted]",
      stdout: "[redacted]",
      logs: "[redacted]",
    });
  });

  it("redacts generic Unix paths and shell commands", () => {
    expect(redactText("run git status in /etc/example and /srv/forgepilot")).toBe(
      "run [command redacted]",
    );
  });
});
