import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  commitObjectBytes,
  commitObjectSha,
  gitBlobSha,
  gitTreeSha,
  isGitObjectId,
  parseCommitDate,
  toGitDate,
  toIsoDate,
} from "../src/collab/git-objects.js";
import type { CandidateCommit } from "../src/collab/types.js";

/**
 * Git object identity is anchored against the real `git` binary (DAT-260).
 *
 * The delivery adapter rebuilds the approved commit itself, so its hashing must
 * be byte-exact. A test that only compared the adapter against its own helpers
 * would prove internal consistency, not git compatibility; every case below
 * compares against `git hash-object`, `git write-tree`, or `git commit-tree`.
 */

let root = "";

afterEach(() => {
  if (root !== "") {
    fs.rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

function tempRepo(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autofixer-git-objects-"));
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "AutoFixer",
      GIT_AUTHOR_EMAIL: "autofixer@localhost",
      GIT_COMMITTER_NAME: "AutoFixer",
      GIT_COMMITTER_EMAIL: "autofixer@localhost",
      GIT_AUTHOR_DATE: "1970-01-01T00:00:00 +0000",
      GIT_COMMITTER_DATE: "1970-01-01T00:00:00 +0000",
      ...env,
    },
  }).trim();
}

const IDENTITY: CandidateCommit = {
  message: "autofixer candidate for tsk_1\n\nrun: run_1\n",
  author: { name: "AutoFixer", email: "autofixer@localhost", date: "1970-01-01T00:00:00 +0000" },
  committer: {
    name: "AutoFixer",
    email: "autofixer@localhost",
    date: "1970-01-01T00:00:00 +0000",
  },
};

describe("blob identity", () => {
  test("matches git hash-object for text and binary content", () => {
    const repo = tempRepo();
    for (const content of ["", "hello\n", "ünïcode\n", "a\r\nb\r\n"]) {
      const actual = execFileSync("git", ["hash-object", "--stdin"], {
        cwd: repo,
        input: content,
      })
        .toString()
        .trim();
      expect(gitBlobSha(content)).toBe(actual);
    }
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    const actualBinary = execFileSync("git", ["hash-object", "--stdin"], {
      cwd: repo,
      input: binary,
    })
      .toString()
      .trim();
    expect(gitBlobSha(binary)).toBe(actualBinary);
  });
});

describe("tree identity", () => {
  test("matches git write-tree for nested paths", () => {
    const repo = tempRepo();
    const files: Record<string, string> = {
      "README.md": "# project\n",
      "src/retry.ts": "export const retry = 1;\n",
      "src/nested/deep.ts": "export const deep = 2;\n",
      "web/src/app.ts": "export const app = 3;\n",
    };
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
    execFileSync("git", ["add", "--all"], { cwd: repo });
    const expected = git(repo, ["write-tree"]);
    const entries = Object.entries(files).map(([file, content]) => ({
      path: file,
      mode: "100644",
      type: "blob" as const,
      sha: gitBlobSha(content),
    }));
    expect(gitTreeSha(entries)).toBe(expected);
  });

  test("tree entries sort directories as if the name ended in a slash", () => {
    const repo = tempRepo();
    const files: Record<string, string> = {
      "foo.txt": "file\n",
      "foo/bar.txt": "dir\n",
    };
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
    execFileSync("git", ["add", "--all"], { cwd: repo });
    const expected = git(repo, ["write-tree"]);
    const entries = Object.entries(files).map(([file, content]) => ({
      path: file,
      mode: "100644",
      type: "blob" as const,
      sha: gitBlobSha(content),
    }));
    expect(gitTreeSha(entries)).toBe(expected);
  });
});

describe("commit identity", () => {
  test("matches git commit-tree for the captive epoch identity", () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    execFileSync("git", ["add", "--all"], { cwd: repo });
    const tree = git(repo, ["write-tree"]);
    const base = git(repo, ["commit-tree", tree, "-m", "base\n"]);
    const expected = git(repo, ["commit-tree", tree, "-p", base, "-m", IDENTITY.message]);
    expect(commitObjectSha({ tree_sha: tree, parent_shas: [base], identity: IDENTITY })).toBe(
      expected,
    );
    // The recorded ISO-with-space date is hashed as git's own `0 +0000`.
    expect(
      commitObjectBytes({ tree_sha: tree, parent_shas: [base], identity: IDENTITY }).toString(
        "utf8",
      ),
    ).toContain("author AutoFixer <autofixer@localhost> 0 +0000\n");
  });

  test("matches git commit-tree with a pinned parent", () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    execFileSync("git", ["add", "--all"], { cwd: repo });
    const tree = git(repo, ["write-tree"]);
    const base = git(repo, ["commit-tree", tree, "-m", "base\n"]);

    fs.writeFileSync(path.join(repo, "file.txt"), "changed\n");
    execFileSync("git", ["add", "--all"], { cwd: repo });
    const candidateTree = git(repo, ["write-tree"]);
    const expected = git(repo, ["commit-tree", candidateTree, "-p", base, "-m", IDENTITY.message]);

    expect(
      commitObjectSha({ tree_sha: candidateTree, parent_shas: [base], identity: IDENTITY }),
    ).toBe(expected);
    expect(isGitObjectId(expected)).toBe(true);
  });

  test("object bytes end with the message exactly as recorded", () => {
    const bytes = commitObjectBytes({
      tree_sha: "d4e5f60718293a4b5c6d7e8f9012345678a1b2c3",
      parent_shas: ["52081eaddca099967fd8be13b3060337fde50d3f"],
      identity: IDENTITY,
    }).toString("utf8");
    expect(bytes).toContain("author AutoFixer <autofixer@localhost> 0 +0000\n");
    expect(bytes).toContain("committer AutoFixer <autofixer@localhost> 0 +0000\n");
    expect(bytes.endsWith(IDENTITY.message)).toBe(true);
  });

  test("refuses identities git cannot serialize", () => {
    const tree = "d4e5f60718293a4b5c6d7e8f9012345678a1b2c3";
    const parent = "52081eaddca099967fd8be13b3060337fde50d3f";
    expect(() =>
      commitObjectSha({
        tree_sha: tree,
        parent_shas: [parent],
        identity: {
          ...IDENTITY,
          author: { ...IDENTITY.author, name: "Auto<Fixer" },
        },
      }),
    ).toThrow(/cannot serialize/);
    expect(() =>
      commitObjectSha({
        tree_sha: "not-a-sha",
        parent_shas: [parent],
        identity: IDENTITY,
      }),
    ).toThrow(/full git object id/);
    expect(() => commitObjectSha({ tree_sha: tree, parent_shas: [], identity: IDENTITY })).toThrow(
      /pinned base/,
    );
  });
});

describe("commit dates", () => {
  test("parses the sandbox constant and git's own form", () => {
    expect(parseCommitDate("1970-01-01T00:00:00 +0000")).toEqual({ unix: 0, tz: "+0000" });
    expect(parseCommitDate("0 +0000")).toEqual({ unix: 0, tz: "+0000" });
    expect(parseCommitDate("1700000000 +0530")).toEqual({ unix: 1700000000, tz: "+0530" });
    expect(parseCommitDate("2026-11-18T10:20:30+02:00")).toEqual({
      unix: Date.parse("2026-11-18T08:20:30Z") / 1000,
      tz: "+0200",
    });
    expect(parseCommitDate("2026-11-18T10:20:30.500Z")).toEqual({
      unix: Date.parse("2026-11-18T10:20:30Z") / 1000,
      tz: "+0000",
    });
  });

  test("round-trips through both wire forms", () => {
    expect(toGitDate("1970-01-01T00:00:00 +0000")).toBe("0 +0000");
    expect(toIsoDate("1970-01-01T00:00:00 +0000")).toBe("1970-01-01T00:00:00+00:00");
    expect(toIsoDate("1700000000 +0530")).toBe("2023-11-15T03:43:20+05:30");
  });

  test("refuses a date without an offset", () => {
    expect(() => parseCommitDate("2026-11-18T10:20:30")).toThrow(/offset/);
    expect(() => parseCommitDate("yesterday")).toThrow(/offset/);
  });
});
