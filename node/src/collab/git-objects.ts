import { createHash } from "node:crypto";

import type { CandidateCommit, CandidateCommitPerson } from "./types.js";

/**
 * Git object identity without a git binary (DAT-260).
 *
 * A candidate head is a deterministic local commit: the sandbox builds it from
 * the approved tree, the pinned base, the run-bound message, and a fixed
 * captive identity (`sandbox/change.go`). Delivery must publish *that* commit,
 * not an equivalent one with a different hash, so the delivery adapter rebuilds
 * the exact object bytes and checks the hash before it writes anything.
 *
 * Only the object forms the delivery path needs are implemented: blobs, trees,
 * and commits (annotated tags never appear). Everything is byte-exact SHA-1
 * over the same canonical serialization git uses; tests anchor the results
 * against the real `git` plumbing.
 */

export type CommitPersonIdentity = CandidateCommitPerson;

export type CommitIdentity = CandidateCommit;

export interface CommitObjectInput {
  tree_sha: string;
  parent_shas: readonly string[];
  identity: CommitIdentity;
}

const OBJECT_ID = /^[0-9a-f]{40}$/;
const GIT_DATE = /^(\d+) ([+-])(\d{2})(\d{2})$/;
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:\s*([+-])(\d{2}):?(\d{2})|Z)$/;

export function isGitObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

/** Raw SHA-1 hex over an object's declared type, size, and bytes. */
function objectId(type: "blob" | "commit" | "tree", body: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${String(body.length)}\u0000`, "utf8"))
    .update(body)
    .digest("hex");
}

/** The object id of a blob holding exactly these bytes (UTF-8 for strings). */
export function gitBlobSha(content: string | Buffer): string {
  return objectId("blob", Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
}

export interface ParsedCommitDate {
  /** Seconds since the epoch. */
  unix: number;
  /** Git's numeric offset, e.g. `+0000`. */
  tz: string;
}

/**
 * Parse one recorded commit date. Anything that is not an exact instant with a
 * numeric offset is refused: a silently "fixed up" date would produce a commit
 * the approval never covered.
 */
export function parseCommitDate(value: string): ParsedCommitDate {
  const gitForm = GIT_DATE.exec(value);
  if (gitForm !== null) {
    const unix = Number.parseInt(gitForm[1]!, 10);
    if (!Number.isSafeInteger(unix)) {
      throw new Error("commit date is out of range");
    }
    return { unix, tz: `${gitForm[2]}${gitForm[3]}${gitForm[4]}` };
  }
  const isoForm = ISO_DATE.exec(value);
  if (isoForm !== null) {
    const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = isoForm;
    const utc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    if (Number.isNaN(utc)) {
      throw new Error("commit date is not a real instant");
    }
    const tz = sign === undefined ? "+0000" : `${sign}${offsetHour}:${offsetMinute}`;
    const offsetSeconds =
      sign === undefined
        ? 0
        : (sign === "-" ? -1 : 1) * (Number(offsetHour) * 3600 + Number(offsetMinute) * 60);
    return { unix: Math.floor(utc / 1000) - offsetSeconds, tz: tz.replace(":", "") };
  }
  throw new Error("commit date must be a git or ISO-8601 timestamp with an offset");
}

/** Git's own object form: `<unix> <±hhmm>`. */
export function toGitDate(value: string): string {
  const parsed = parseCommitDate(value);
  return `${String(parsed.unix)} ${parsed.tz}`;
}

/** ISO-8601 form with the same instant and offset, for provider APIs. */
export function toIsoDate(value: string): string {
  const parsed = parseCommitDate(value);
  const sign = parsed.tz.startsWith("-") ? -1 : 1;
  const offsetSeconds =
    sign * (Number(parsed.tz.slice(1, 3)) * 3600 + Number(parsed.tz.slice(3, 5)) * 60);
  const local = new Date((parsed.unix + offsetSeconds) * 1000);
  const iso = local.toISOString().replace(/\.\d{3}Z$/, "");
  return `${iso}${parsed.tz.slice(0, 3)}:${parsed.tz.slice(3, 5)}`;
}

function personLine(role: "author" | "committer", person: CommitPersonIdentity): string {
  if (person.name.trim() === "" || person.email.trim() === "") {
    throw new Error(`${role} identity must carry a name and an email`);
  }
  // eslint-disable-next-line no-control-regex -- git cannot store these bytes in an identity
  if (/[<>\n\r\u0000]/.test(person.name) || /[<>\n\r\u0000]/.test(person.email)) {
    throw new Error(`${role} identity contains characters git cannot serialize`);
  }
  return `${role} ${person.name} <${person.email}> ${toGitDate(person.date)}\n`;
}

/** The exact commit object bytes git hashes for this identity. */
export function commitObjectBytes(input: CommitObjectInput): Buffer {
  if (!isGitObjectId(input.tree_sha)) {
    throw new Error("commit tree must be a full git object id");
  }
  if (input.parent_shas.length === 0) {
    throw new Error("a candidate commit always has its pinned base as parent");
  }
  if (input.identity.message.trim() === "") {
    throw new Error("commit message must not be empty");
  }
  const headers = [`tree ${input.tree_sha}\n`];
  for (const parent of input.parent_shas) {
    if (!isGitObjectId(parent)) {
      throw new Error("commit parent must be a full git object id");
    }
    headers.push(`parent ${parent}\n`);
  }
  headers.push(personLine("author", input.identity.author));
  headers.push(personLine("committer", input.identity.committer));
  headers.push("\n");
  return Buffer.concat([
    Buffer.from(headers.join(""), "utf8"),
    Buffer.from(input.identity.message, "utf8"),
  ]);
}

/** The commit id this identity must reproduce; never a different valid commit. */
export function commitObjectSha(input: CommitObjectInput): string {
  return objectId("commit", commitObjectBytes(input));
}

export interface GitTreeEntry {
  path: string;
  /** Git tree mode: `100644`, `100755`, `120000`, `40000`, `160000`. */
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

function treeMode(mode: string): string {
  // Git serializes a directory as `40000` inside a tree object, while the
  // provider APIs spell it `040000`. Accept both and normalize.
  return mode === "040000" ? "40000" : mode;
}

function compareTreeEntries(
  left: { name: string; isTree: boolean },
  right: { name: string; isTree: boolean },
): number {
  // Git sorts tree entries by name bytes, with a directory compared as if its
  // name ended in `/`. That ordering is part of the tree's hash.
  return Buffer.compare(
    Buffer.from(left.isTree ? `${left.name}/` : left.name, "utf8"),
    Buffer.from(right.isTree ? `${right.name}/` : right.name, "utf8"),
  );
}

/**
 * Build the exact tree object bytes for a complete path→entry map. Used to
 * verify provider-side tree construction (the delivery adapter lets the
 * provider compute the tree and only checks its id).
 */
export function gitTreeObjectBytes(entries: readonly GitTreeEntry[]): Buffer {
  interface Node {
    files: Map<string, GitTreeEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`tree path is not repository-relative: ${entry.path}`);
    }
    let node = root;
    for (const directory of segments.slice(0, -1)) {
      let child = node.dirs.get(directory);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(directory, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }

  const serialize = (node: Node): Buffer => {
    const children: { name: string; isTree: boolean; mode: string; sha: string }[] = [];
    for (const [name, file] of node.files) {
      children.push({ name, isTree: false, mode: treeMode(file.mode), sha: file.sha });
    }
    for (const [name, child] of node.dirs) {
      children.push({ name, isTree: true, mode: "40000", sha: objectId("tree", serialize(child)) });
    }
    children.sort(compareTreeEntries);
    const parts: Buffer[] = [];
    for (const child of children) {
      if (!isGitObjectId(child.sha)) {
        throw new Error(`tree entry has no full object id: ${child.name}`);
      }
      parts.push(Buffer.from(`${child.mode} ${child.name}\u0000`, "utf8"));
      parts.push(Buffer.from(child.sha, "hex"));
    }
    return Buffer.concat(parts);
  };

  return serialize(root);
}

export function gitTreeSha(entries: readonly GitTreeEntry[]): string {
  return objectId("tree", gitTreeObjectBytes(entries));
}
