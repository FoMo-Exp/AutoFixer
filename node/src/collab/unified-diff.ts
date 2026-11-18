/**
 * Unified-diff reconstruction for controlled delivery (DAT-260).
 *
 * dsh freezes a candidate as an exact tree plus the unified diff a reviewer
 * read. The GitHub adapter cannot upload a tree object directly, so it rebuilds
 * the changed file contents from that retained diff and the pinned base blobs,
 * then lets the provider compute the tree and compares its id with the
 * approved `tree_sha`. If reconstruction is even slightly wrong the tree id
 * differs and no branch or PR is written.
 *
 * Deliberately narrow, matching what `sandbox/change.go` produces
 * (`git diff --no-color --no-ext-diff --no-renames --no-textconv --unified=3`):
 *
 * - no renames (a rename is a delete plus an add);
 * - no binary patches (`git diff` without `--binary` cannot reproduce binary
 *   content, so such a change is refused rather than guessed);
 * - submodule (gitlink) changes are refused for the same reason.
 *
 * Every mismatch throws {@link PatchFormatError}; the adapter records a safe
 * machine code and performs no provider write.
 */

export class PatchFormatError extends Error {
  readonly code: "binary_patch" | "submodule_patch" | "malformed_patch" | "context_mismatch";

  constructor(code: PatchFormatError["code"], message: string) {
    super(message);
    this.name = "PatchFormatError";
    this.code = code;
  }
}

export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  /** The line had no trailing newline in the file it came from. */
  no_newline: boolean;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface DiffFileChange {
  path: string;
  kind: "add" | "modify" | "delete";
  /** Git tree mode from the diff headers, when the header names one. */
  old_mode: string | null;
  new_mode: string | null;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d{6}))?$/;

/**
 * Decode one git path token. Git quotes paths containing control characters,
 * quotes, backslashes, or non-ASCII bytes, writing those bytes as C-style
 * octal escapes (`"\303\274"`), so decoding works on bytes and then UTF-8.
 */
export function decodeGitPath(raw: string): string {
  const token = raw.split("\t")[0] ?? "";
  if (!token.startsWith('"')) {
    return token;
  }
  if (!token.endsWith('"') || token.length < 2) {
    throw new PatchFormatError("malformed_patch", "unterminated quoted path");
  }
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const escape = body[index + 1];
    if (escape === undefined) {
      throw new PatchFormatError("malformed_patch", "dangling path escape");
    }
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b,
      "\\": 0x5c,
      '"': 0x22,
    };
    const simpleByte = simple[escape];
    if (simpleByte !== undefined) {
      bytes.push(simpleByte);
      index += 1;
      continue;
    }
    const octal = body.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/.test(octal)) {
      throw new PatchFormatError("malformed_patch", "unsupported path escape");
    }
    bytes.push(Number.parseInt(octal, 8));
    index += 3;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strip the `a/` or `b/` prefix from one `---`/`+++` path, if present. */
function stripSidePrefix(raw: string, side: "a" | "b"): string {
  const path = decodeGitPath(raw);
  if (path === "/dev/null") {
    return "";
  }
  const prefix = `${side}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Split `diff --git a/<p> b/<p>` when no `---`/`+++` headers exist (binary and
 * mode-only changes). With `--no-renames` both sides name the same path, so the
 * split must satisfy `a/left === b/right`.
 *
 * Git does not quote a path merely because it contains spaces, and it quotes
 * both tokens when it must quote at all, so every unquoted space is a split
 * candidate; spaces inside a quoted token are not.
 */
function splitDiffGitLine(line: string): { old_path: string; new_path: string } {
  const rest = line.slice("diff --git ".length);
  let quoted = false;
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index]!;
    if (quoted) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== " ") {
      continue;
    }
    let oldPath: string;
    let newPath: string;
    try {
      oldPath = decodeGitPath(rest.slice(0, index));
      newPath = decodeGitPath(rest.slice(index + 1));
    } catch {
      continue;
    }
    if (
      oldPath.startsWith("a/") &&
      newPath.startsWith("b/") &&
      oldPath.slice(2) === newPath.slice(2)
    ) {
      return { old_path: oldPath.slice(2), new_path: newPath.slice(2) };
    }
  }
  throw new PatchFormatError("malformed_patch", "diff --git header does not name one path");
}

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Parse one retained unified diff into file-level changes. Throws on any form
 * this delivery path cannot reproduce exactly.
 */
export function parseUnifiedDiff(diff: string): DiffFileChange[] {
  const lines = splitLines(diff);
  if (lines.length === 0) {
    return [];
  }
  const changes: DiffFileChange[] = [];
  let current: DiffFileChange | null = null;
  let index = 0;

  const assertNoChangeInProgress = (): void => {
    if (current !== null) {
      changes.push(current);
      current = null;
    }
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) {
      assertNoChangeInProgress();
      const { old_path, new_path } = splitDiffGitLine(line);
      current = {
        path: new_path,
        kind: "modify",
        old_mode: null,
        new_mode: null,
        hunks: [],
      };
      if (old_path !== new_path) {
        throw new PatchFormatError("malformed_patch", "a no-rename diff named two paths");
      }
      index += 1;
      continue;
    }
    if (current === null) {
      throw new PatchFormatError("malformed_patch", `content before any file header: ${line}`);
    }
    if (line.startsWith("new file mode ")) {
      current.kind = "add";
      current.new_mode = line.slice("new file mode ".length).trim();
      index += 1;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.kind = "delete";
      current.old_mode = line.slice("deleted file mode ".length).trim();
      index += 1;
      continue;
    }
    if (line.startsWith("old mode ")) {
      current.old_mode = line.slice("old mode ".length).trim();
      index += 1;
      continue;
    }
    if (line.startsWith("new mode ")) {
      current.new_mode = line.slice("new mode ".length).trim();
      index += 1;
      continue;
    }
    const indexLine = INDEX_LINE.exec(line);
    if (indexLine !== null) {
      if (indexLine[3] !== undefined) {
        current.new_mode ??= indexLine[3];
        current.old_mode ??= indexLine[3];
      }
      index += 1;
      continue;
    }
    if (line.startsWith("--- ")) {
      const oldPath = stripSidePrefix(line.slice(4), "a");
      if (oldPath !== "") {
        current.path = oldPath;
      }
      index += 1;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = stripSidePrefix(line.slice(4), "b");
      if (newPath === "" && current.kind !== "delete") {
        // `+++ /dev/null` without a `deleted file mode` header is a form this
        // path does not reproduce.
        throw new PatchFormatError("malformed_patch", "deleted path without its file mode");
      }
      if (newPath !== "") {
        if (newPath !== current.path) {
          throw new PatchFormatError("malformed_patch", "diff header names two different paths");
        }
        current.path = newPath;
      }
      index += 1;
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      throw new PatchFormatError(
        "binary_patch",
        "binary changes cannot be reproduced from the retained unified diff",
      );
    }
    if (line.startsWith("Submodule ")) {
      throw new PatchFormatError(
        "submodule_patch",
        "submodule changes cannot be delivered as file content",
      );
    }
    const hunkHeader = HUNK_HEADER.exec(line);
    if (hunkHeader !== null) {
      const oldStart = Number.parseInt(hunkHeader[1]!, 10);
      const oldLines = hunkHeader[2] === undefined ? 1 : Number.parseInt(hunkHeader[2], 10);
      const newStart = Number.parseInt(hunkHeader[3]!, 10);
      const newLines = hunkHeader[4] === undefined ? 1 : Number.parseInt(hunkHeader[4], 10);
      if (current.old_mode === "160000" || current.new_mode === "160000") {
        throw new PatchFormatError("submodule_patch", "gitlink entries are not file content");
      }
      const hunk: DiffHunk = {
        old_start: oldStart,
        old_lines: oldLines,
        new_start: newStart,
        new_lines: newLines,
        lines: [],
      };
      index += 1;
      while (index < lines.length) {
        const hunkLine = lines[index]!;
        if (hunkLine.startsWith("@@") || hunkLine.startsWith("diff --git ")) {
          break;
        }
        if (hunkLine === "\\ No newline at end of file") {
          const previous = hunk.lines[hunk.lines.length - 1];
          if (previous === undefined) {
            throw new PatchFormatError("malformed_patch", "no-newline marker without a line");
          }
          previous.no_newline = true;
          index += 1;
          continue;
        }
        const marker = hunkLine[0];
        if (marker === " " || marker === "+" || marker === "-") {
          hunk.lines.push({
            kind: marker === " " ? "context" : marker === "+" ? "add" : "remove",
            text: hunkLine.slice(1),
            no_newline: false,
          });
          index += 1;
          continue;
        }
        if (hunkLine === "") {
          // A completely empty line inside a diff is a truncated header, not
          // content: content lines always carry their leading marker.
          throw new PatchFormatError("malformed_patch", "unmarked blank line inside a hunk");
        }
        throw new PatchFormatError("malformed_patch", `unknown hunk line: ${hunkLine}`);
      }
      const oldCount = hunk.lines.filter((entry) => entry.kind !== "add").length;
      const newCount = hunk.lines.filter((entry) => entry.kind !== "remove").length;
      if (oldCount !== hunk.old_lines || newCount !== hunk.new_lines) {
        throw new PatchFormatError(
          "malformed_patch",
          "hunk header counts do not match its content",
        );
      }
      current.hunks.push(hunk);
      continue;
    }
    if (line === "") {
      index += 1;
      continue;
    }
    throw new PatchFormatError("malformed_patch", `unknown diff line: ${line}`);
  }
  assertNoChangeInProgress();
  return changes;
}

interface ContentLine {
  text: string;
  no_newline: boolean;
}

function contentLines(content: string): ContentLine[] {
  if (content === "") {
    return [];
  }
  const raw = content.split("\n");
  const finalNewline = raw[raw.length - 1] === "";
  if (finalNewline) {
    raw.pop();
  }
  return raw.map((text, index) => ({
    text,
    no_newline: !finalNewline && index === raw.length - 1,
  }));
}

function joinContent(lines: readonly ContentLine[]): string {
  return lines
    .map((line, index) => {
      const last = index === lines.length - 1;
      return line.text + (last && line.no_newline ? "" : "\n");
    })
    .join("");
}

/**
 * Apply one file change to its pinned base content. `base` is null exactly for
 * an added file. The result must reproduce the approved tree before anything
 * is written; a context mismatch means the retained diff and the pinned base
 * disagree, which is refused rather than repaired.
 */
export function applyFileChange(base: string | null, change: DiffFileChange): string | null {
  if (change.kind === "delete") {
    if (base === null) {
      throw new PatchFormatError("context_mismatch", "deleted file is absent from the base tree");
    }
    // A deletion is reproducible only when its hunks remove exactly the pinned
    // base content. Skipping the hunks would accept a wrong or truncated
    // deletion patch as evidence for a tree the approval never covered.
    if (applyHunks(base, change) !== "") {
      throw new PatchFormatError(
        "context_mismatch",
        "deletion patch does not remove the base content",
      );
    }
    return null;
  }
  if (change.kind === "add" && base !== null) {
    throw new PatchFormatError("context_mismatch", "added file already exists in the base tree");
  }
  if (change.kind === "modify" && base === null) {
    throw new PatchFormatError("context_mismatch", "modified file is absent from the base tree");
  }
  return applyHunks(base ?? "", change);
}

/** Apply a change's hunks to its base content, verifying every context line. */
function applyHunks(base: string, change: DiffFileChange): string {
  const original = contentLines(base);
  const output: ContentLine[] = [];
  let cursor = 0;
  for (const hunk of change.hunks) {
    // Unified-diff ranges are 1-based; a zero-length old range names the line
    // *after which* the insertion happens (0 = the beginning).
    const start = hunk.old_lines === 0 ? hunk.old_start : hunk.old_start - 1;
    if (start < cursor || start > original.length) {
      throw new PatchFormatError("context_mismatch", "hunk starts outside the base content");
    }
    output.push(...original.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push({ text: line.text, no_newline: line.no_newline });
        continue;
      }
      const source = original[cursor];
      if (source === undefined || source.text !== line.text) {
        throw new PatchFormatError("context_mismatch", "hunk context does not match the base file");
      }
      if (line.kind === "context") {
        output.push({ text: source.text, no_newline: line.no_newline });
      }
      cursor += 1;
    }
  }
  output.push(...original.slice(cursor));
  return joinContent(output);
}

/** The new mode a change installs, when it installs one. */
export function changeMode(change: DiffFileChange, baseMode: string | null): string {
  const mode = change.new_mode ?? baseMode ?? "100644";
  if (mode === "160000" || mode === "40000" || mode === "040000") {
    throw new PatchFormatError("submodule_patch", `unsupported tree mode ${mode}`);
  }
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    throw new PatchFormatError("malformed_patch", `unsupported file mode ${mode}`);
  }
  return mode;
}
