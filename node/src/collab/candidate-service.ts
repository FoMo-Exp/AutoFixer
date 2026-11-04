import type {
  CandidateFreshness,
  CandidateNotification,
  CandidateReviewCard,
} from "./candidate.js";
import { candidateFreshness, candidateNotification, candidateReviewCard } from "./candidate.js";
import type { CandidateContentStore } from "./candidate-store.js";
import { CollabError } from "./errors.js";
import type { CollabMachine } from "./machine.js";
import type { CandidateRecord } from "./types.js";

/**
 * Candidate review-card API (DAT-219, ADR-0007).
 *
 * This is the issue-scoped read surface for the pre-PR review card. It is the
 * code behind the contract's two candidate endpoints:
 *
 * - `GET .../issues/{issue_id}/candidates` — frozen candidates in freeze order
 * - `GET .../issues/{issue_id}/candidates/{candidate_id}` — one card
 *
 * Reads never grant approval: `get`/`list` return the immutable record the
 * contract defines, and the expandable diff is served by `diff`, which
 * recomputes the sha256 from the retained bytes instead of trusting the record.
 * A candidate from another issue is an indistinguishable `CANDIDATE_NOT_FOUND`,
 * so the route cannot be used to enumerate other issues' work.
 *
 * The card remains readable after the preparation worktree is deleted, which is
 * why content retention is delegated to the candidate content store rather than
 * to the ephemeral checkout.
 */

export interface CandidateCardPage {
  items: CandidateReviewCard[];
  next_cursor: string | null;
}

export interface CandidateReviewServiceOptions {
  /** Page size for the candidate list endpoint (default 50, matching the API). */
  pageSize?: number;
}

export interface CandidateDiffView {
  candidate_id: string;
  digest_algorithm: "sha256";
  digest: string;
  changed_paths: string[];
  insertions: number;
  deletions: number;
  /**
   * The exact authorized diff. It has been re-hashed and matches the frozen
   * digest; a mismatch is an integrity failure, never a served diff.
   */
  content: string;
}

const DEFAULT_PAGE_SIZE = 50;

export class CandidateReviewService {
  private readonly machine: CollabMachine;
  private readonly store: CandidateContentStore;
  private readonly pageSize: number;

  constructor(
    machine: CollabMachine,
    store: CandidateContentStore,
    options: CandidateReviewServiceOptions = {},
  ) {
    this.machine = machine;
    this.store = store;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new CollabError("INVALID_INPUT", "pageSize must be a positive integer", {
        field: "pageSize",
      });
    }
    this.pageSize = pageSize;
  }

  /** Cards in freeze order, exactly the `Candidate[]` page of the contract. */
  list(issueId: string): CandidateReviewCard[] {
    return this.machine.listCandidates(issueId).map(candidateReviewCard);
  }

  /**
   * The `GET .../candidates` response body: one stable page plus an opaque
   * cursor. The cursor is the last served candidate id, so a reconnecting
   * client resumes exactly after it; an unknown cursor is `INVALID_CURSOR`
   * rather than a silently restarted list.
   */
  page(issueId: string, cursor: string | null = null): CandidateCardPage {
    const candidates = this.machine.listCandidates(issueId);
    let start = 0;
    if (cursor !== null && cursor !== "") {
      const index = candidates.findIndex((candidate) => candidate.candidate_id === cursor);
      if (index === -1) {
        throw new CollabError("INVALID_CURSOR", "unknown candidate cursor", { cursor });
      }
      start = index + 1;
    }
    const page = candidates.slice(start, start + this.pageSize);
    const last = page[page.length - 1];
    const more = start + page.length < candidates.length;
    return {
      items: page.map(candidateReviewCard),
      next_cursor: last !== undefined && more ? last.candidate_id : null,
    };
  }

  get(issueId: string, candidateId: string): CandidateReviewCard {
    return candidateReviewCard(this.candidateOf(issueId, candidateId));
  }

  /** Recorded invalidation or an observed base change makes the card stale. */
  freshness(issueId: string, candidateId: string, observedBaseSha?: string): CandidateFreshness {
    const candidate = this.candidateOf(issueId, candidateId);
    return candidateFreshness(candidate, observedBaseSha);
  }

  /**
   * The review card's expandable diff. The retained bytes are re-hashed, so a
   * tampered or missing blob fails closed instead of showing an unverified
   * patch to an approver.
   */
  diff(issueId: string, candidateId: string): CandidateDiffView {
    const candidate = this.candidateOf(issueId, candidateId);
    const content = this.store.read(candidate.diff.digest);
    const matches = this.store.verify(candidate.diff.digest, content);
    if (!matches) {
      throw new CollabError(
        "CANDIDATE_INVALID",
        "retained diff content does not match the frozen digest",
        { candidate_id: candidate.candidate_id, digest: candidate.diff.digest },
      );
    }
    return {
      candidate_id: candidate.candidate_id,
      digest_algorithm: "sha256",
      digest: candidate.diff.digest,
      changed_paths: [...candidate.diff.changed_paths],
      insertions: candidate.diff.insertions,
      deletions: candidate.diff.deletions,
      content,
    };
  }

  /**
   * Reviewer notification: bounded metadata plus an authenticated client link.
   * It carries no diff, no changed path names, no output digests, and no
   * credential, so an external notification channel never becomes a preview or
   * an approval.
   */
  notification(
    issueId: string,
    candidateId: string,
    options: { clientUrl: string },
  ): CandidateNotification {
    return candidateNotification(this.candidateOf(issueId, candidateId), options);
  }

  private candidateOf(issueId: string, candidateId: string): CandidateRecord {
    const candidate = this.machine.getCandidate(candidateId);
    if (!candidate || candidate.issue_id !== issueId) {
      throw new CollabError("CANDIDATE_NOT_FOUND", "unknown candidate", {
        candidate_id: candidateId,
        issue_id: issueId,
      });
    }
    return candidate;
  }
}
