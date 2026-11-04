import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CollabError } from "./errors.js";

/**
 * Content-addressed candidate store (DAT-219, ADR-0007).
 *
 * A frozen candidate must stay reviewable and deliverable after its ephemeral
 * worktree is deleted, so the diff content lives here instead: one file per
 * sha256 digest, written once and never edited. The record keeps the digest,
 * so an independent reader recomputes the hash from the retained bytes instead
 * of trusting the record.
 *
 * The store is deliberately dumb about authority: writing content grants
 * nothing, reading it does not approve anything, and no provider credential
 * exists here. Candidate freeze refuses a store that lives inside the
 * preparation worktree — content inside the ephemeral directory would not
 * survive cleanup and would not be an independent retention boundary.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Resolve a path's real location, tolerating a leaf that does not exist yet:
 * the nearest existing ancestor is resolved through symlinks and the missing
 * remainder is appended. An all-missing path resolves to itself.
 */
function realPath(target: string): string {
  const resolved = path.resolve(target);
  let current = resolved;
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const real = fs.realpathSync(current);
  return suffix.length === 0 ? real : path.join(real, ...suffix);
}

/** sha256 over the exact retained diff content (UTF-8 bytes). */
export function diffDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface StoredDiff {
  digest_algorithm: "sha256";
  digest: string;
}

export class CandidateContentStore {
  private readonly root: string;

  constructor(root: string) {
    if (root.trim() === "") {
      throw new CollabError("INVALID_INPUT", "candidate store root must be a non-empty path", {
        field: "root",
      });
    }
    this.root = path.resolve(root);
  }

  /** Absolute root; logs may show it, callers never get a write handle. */
  get rootPath(): string {
    return this.root;
  }

  /**
   * Retain one diff content blob under its sha256 digest. Idempotent: the
   * content-addressed path either exists already or is written once through a
   * temporary file and renamed, so a crash never leaves a partial blob.
   */
  put(content: string): StoredDiff {
    const digest = diffDigest(content);
    const target = this.pathFor(digest);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
    }
    return { digest_algorithm: "sha256", digest };
  }

  has(digest: string): boolean {
    return SHA256_HEX.test(digest) && fs.existsSync(this.pathFor(digest));
  }

  /** Read retained content, or null when the digest was never stored here. */
  readOrNull(digest: string): string | null {
    if (!SHA256_HEX.test(digest) || !fs.existsSync(this.pathFor(digest))) {
      return null;
    }
    return fs.readFileSync(this.pathFor(digest), "utf8");
  }

  /**
   * Read retained content and re-verify it against its digest. A blob whose
   * bytes no longer hash to the digest is an integrity failure, never a
   * silently trusted diff.
   */
  read(digest: string): string {
    const content = this.readOrNull(digest);
    if (content === null) {
      throw new CollabError("CANDIDATE_NOT_FOUND", "candidate content is not retained", {
        digest,
      });
    }
    if (diffDigest(content) !== digest) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        "retained candidate content does not match its digest",
        {
          digest,
          computed: diffDigest(content),
        },
      );
    }
    return content;
  }

  /** Independent verification of one content value against a declared digest. */
  verify(digest: string, content: string): boolean {
    return SHA256_HEX.test(digest) && diffDigest(content) === digest;
  }

  /**
   * Refuse a retention root that sits inside the preparation worktree (or is
   * the worktree itself). ADR-0007 requires the candidate to survive worktree
   * cleanup, so content stored under an ephemeral path is not a candidate.
   *
   * Containment is checked on resolved real paths: a store root that is a
   * symlink into the worktree, or that lives below a symlinked parent, would
   * otherwise pass a string prefix check and lose its blobs on cleanup.
   */
  assertOutsideWorktree(worktreePath: string): void {
    const worktree = realPath(worktreePath);
    const root = realPath(this.root);
    const inside = root === worktree || root.startsWith(worktree + path.sep);
    if (inside) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        "candidate content must be retained outside the ephemeral worktree",
        { worktree_path: worktree, store_root: root },
      );
    }
  }

  private pathFor(digest: string): string {
    if (!SHA256_HEX.test(digest)) {
      throw new CollabError("INVALID_INPUT", "digest must be a sha256 hex digest", {
        digest,
      });
    }
    return path.join(this.root, "sha256", digest.slice(0, 2), `${digest}.diff`);
  }
}
