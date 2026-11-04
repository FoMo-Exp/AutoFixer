/**
 * Contradiction handling (DAT-234).
 *
 * The ADR's rule is "contradiction is visible": a link is drawn, confidence
 * drops on evidence counts, a retirement proposal is raised, and nothing is
 * overwritten. These tests hold the gate to that from the mutating side — the
 * admission service — because a verdict that is not acted on is not visible.
 */

import { beforeEach, describe, expect, test } from "vitest";

import {
  admitCandidate,
  isRetrievalEligible,
  allowsFactualInjection,
} from "../src/memory/index.js";
import { bootstrap, candidate, ledger, seedItem } from "./support/memory-admission.js";
import type { Fixture } from "./support/memory-admission.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = bootstrap();
});

const STATEMENT = "The workspace runs its checks with npm run lint before every push.";
const FLIPPED = "The workspace never runs its checks with npm run lint before every push.";

function admit(overrides = {}) {
  return admitCandidate(fixture.memory, fixture.admission, fixture.scopeA, candidate(overrides), {
    evidence: ledger(),
  });
}

describe("A contradiction is recorded, never overwritten", () => {
  test("the original item survives untouched and both claims stay visible", () => {
    const original = seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const originalStatement = original.current.statement;

    const outcome = admit({ statement: FLIPPED });

    // The new claim becomes an item of its own; the old one is not edited.
    expect(outcome.verdict.disposition).toBe("admitted");
    expect(outcome.item?.item.id).not.toBe(original.item.id);
    expect(fixture.memory.items.getById(fixture.scopeA, original.item.id)?.current.statement).toBe(
      originalStatement,
    );
    expect(fixture.memory.items.list(fixture.scopeA).map((r) => r.current.statement)).toEqual(
      expect.arrayContaining([STATEMENT, FLIPPED]),
    );
  });

  test("a contradicts link is drawn between the two items", () => {
    const original = seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const outcome = admit({ statement: FLIPPED });

    const links = fixture.memory.links.listByItem(fixture.scopeA, outcome.item!.item.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      item_id: outcome.item!.item.id,
      target_item_id: original.item.id,
      link_type: "contradicts",
      reason: "contradiction_detected",
    });
  });

  test("confidence falls on both sides and is derived from rows", () => {
    const original = seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const outcome = admit({ statement: FLIPPED });

    expect(outcome.item!.item.contradiction_count).toBe(1);
    expect(
      fixture.memory.items.getById(fixture.scopeA, original.item.id)?.item.contradiction_count,
    ).toBe(1);
    // Support is counted from evidence rows, not asserted.
    expect(outcome.item!.item.support_count).toBe(1);
    expect(fixture.memory.items.getById(fixture.scopeA, original.item.id)?.item.support_count).toBe(
      0,
    );
  });

  test("a retirement proposal is raised and left pending", () => {
    seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const outcome = admit({ statement: FLIPPED });

    expect(outcome.retirement_candidates).toHaveLength(1);
    const proposal = outcome.retirement_candidates[0]!;
    expect(proposal.status).toBe("pending");
    expect(proposal.reason_code).toBe("contradiction_detected");
    // Equal trust: the incoming claim may be proposed as the successor, but
    // only as a proposal.
    expect(proposal.proposed_action).toBe("supersede");
    expect(proposal.successor_item_id).toBe(outcome.item!.item.id);

    // ...and nothing was actually retired.
    const all = fixture.memory.items.list(fixture.scopeA);
    expect(all.map((r) => r.item.status).sort()).toEqual(["candidate", "proposed"]);
  });

  test("a weaker claim may not retire a stronger one", () => {
    seedItem(fixture, fixture.scopeA, {
      statement: STATEMENT,
      provenance: { author_type: "human" },
      trust: "human",
    });
    const outcome = admit({ statement: FLIPPED });

    const proposal = outcome.retirement_candidates[0]!;
    expect(proposal.proposed_action).toBe("deprecate");
    expect(proposal.successor_item_id).toBeNull();
  });

  test("a human claim may be proposed as a supersede, still pending", () => {
    const original = seedItem(fixture, fixture.scopeA, {
      statement: STATEMENT,
      provenance: { author_type: "agent", agent_model: "claude-sonnet-5-5" },
      trust: "agent",
    });
    const outcome = admit({
      statement: FLIPPED,
      provenance: { author_type: "human" },
      trust: "human",
    });

    const proposal = outcome.retirement_candidates[0]!;
    expect(proposal.proposed_action).toBe("supersede");
    expect(proposal.successor_item_id).toBe(outcome.item!.item.id);
    expect(proposal.item_id).toBe(original.item.id);
    expect(proposal.status).toBe("pending");
  });
});

describe("A contradicting item is visible but not a fact", () => {
  test("it is not auto-active and its claim is not injected as fact", () => {
    seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const outcome = admit({ statement: FLIPPED });

    expect(outcome.item!.item.status).toBe("candidate");
    expect(outcome.item!.item.status).not.toBe("active");
    expect(outcome.verdict.retrieval_eligible).toBe(true);
    expect(outcome.verdict.factual_injection_allowed).toBe(false);
  });

  test("both sides are blocked from factual injection while the conflict stands", () => {
    seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const outcome = admit({ statement: FLIPPED });

    const originalRecord = fixture.memory.items.getById(fixture.scopeA, outcome.item!.item.id)!;
    expect(
      allowsFactualInjection({
        item: originalRecord.item,
        version: originalRecord.current,
        decisions: fixture.admission.listDecisionsForItem(fixture.scopeA, originalRecord.item.id),
      }),
    ).toBe(false);

    // The pre-existing item has no admission decision at all, so it is not
    // eligible either — the conflict did not quietly promote it.
    const seeded = fixture.memory.items
      .list(fixture.scopeA)
      .find((r) => r.current.statement === STATEMENT)!;
    expect(
      isRetrievalEligible({
        item: seeded.item,
        version: seeded.current,
        decisions: fixture.admission.listDecisionsForItem(fixture.scopeA, seeded.item.id),
      }),
    ).toBe(false);
  });

  test("no contradiction means the claim may be presented as fact", () => {
    const outcome = admit({ statement: STATEMENT });
    expect(outcome.verdict.disposition).toBe("admitted");
    expect(outcome.verdict.contradictions).toHaveLength(0);
    expect(outcome.verdict.factual_injection_allowed).toBe(true);
    expect(
      allowsFactualInjection({
        item: outcome.item!.item,
        version: outcome.item!.current,
        decisions: [outcome.decision],
      }),
    ).toBe(true);
  });
});

describe("Contradiction detection stays inside its band", () => {
  test("unrelated claims do not contradict each other", () => {
    seedItem(fixture, fixture.scopeA, { statement: "The workspace runs npm run lint." });
    const outcome = admit({
      statement: "The web build always emits a sourcemap artifact for debugging.",
    });
    expect(outcome.verdict.contradictions).toHaveLength(0);
    expect(outcome.verdict.factual_injection_allowed).toBe(true);
  });

  test("claims that can never meet do not contradict", () => {
    seedItem(fixture, fixture.scopeA, {
      statement: "The workspace runs its checks with npm run lint before every push.",
      scope: { language: "typescript" },
    });
    const outcome = admit({
      statement: FLIPPED,
      scope: { language: "go" },
    });
    expect(outcome.verdict.contradictions).toHaveLength(0);
  });

  test("the same claim under different preconditions is not a contradiction", () => {
    seedItem(fixture, fixture.scopeA, {
      statement: "Run the migration before deploying.",
      preconditions: ["when the schema changed"],
    });
    const outcome = admit({
      statement: "Never run the migration before deploying.",
      preconditions: ["when only the docs changed"],
    });
    expect(outcome.verdict.contradictions).toHaveLength(0);
  });
});

describe("Retirement proposals are decided by a human, not by the gate", () => {
  test("a proposal resolves exactly once and keeps its history", () => {
    seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const outcome = admit({ statement: FLIPPED });
    const proposal = outcome.retirement_candidates[0]!;

    expect(proposal.status).toBe("pending");
    const accepted = fixture.admission.resolveRetirementCandidate(
      fixture.scopeA,
      proposal.id,
      "accepted",
      "usr_lead",
    );
    expect(accepted.status).toBe("accepted");
    expect(accepted.resolved_by).toBe("usr_lead");

    // A second resolution is an idempotent no-op, not an overwrite.
    const again = fixture.admission.resolveRetirementCandidate(
      fixture.scopeA,
      proposal.id,
      "rejected",
      "usr_other",
    );
    expect(again.status).toBe("accepted");
    expect(again.resolved_by).toBe("usr_lead");

    // Resolving the proposal did not retire anything by itself.
    const all = fixture.memory.items.list(fixture.scopeA);
    expect(all.map((r) => r.item.status).sort()).toEqual(["candidate", "proposed"]);
  });

  test("re-admitting the same conflict does not stack duplicate proposals", () => {
    seedItem(fixture, fixture.scopeA, { statement: STATEMENT });
    const first = admit({ statement: FLIPPED });
    expect(first.retirement_candidates).toHaveLength(1);

    const again = admit({ statement: FLIPPED });
    expect(again.decision.id).toBe(first.decision.id);
    expect(again.retirement_candidates).toHaveLength(1);
    expect(
      fixture.admission.listRetirementCandidates(fixture.scopeA, { status: "pending" }),
    ).toHaveLength(1);
  });
});
