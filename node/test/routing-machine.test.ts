import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { RoutingMachine } from "../src/routing/machine.js";
import type { RouteEvidence, RoutingScope, ServiceMapping } from "../src/routing/types.js";
import {
  ACTOR,
  ALICE,
  Clock,
  SCOPE,
  blameFact,
  evidence,
  expectCode,
  identity,
  makeMachine,
  mapped,
  op,
  standardDirectory,
  substantive,
  testPolicy,
} from "./helpers/routing.js";
import { FakeDirectory } from "./helpers/routing.js";

const OTHER_SCOPE: RoutingScope = { enterprise_id: "ent_other", workspace_id: "ws_other" };

const ROUTE_EVIDENCE: RouteEvidence = evidence(
  [substantive("node/src/core.ts", 10)],
  [blameFact("node/src/core.ts", identity("github", "1"), 10)],
);

describe("routing machine delivery guarantees (DAT-217)", () => {
  test("redelivery of an applied operation returns the recorded result and appends nothing", () => {
    const machine = makeMachine(standardDirectory());
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const input = {
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      issue_id: "iss_1",
      service_mapping: mapped(),
      evidence: ROUTE_EVIDENCE,
    };
    const first = machine.route(input);
    const records = machine.auditLog().length;
    const second = machine.route(input);
    expect(second).toEqual(first);
    expect(machine.auditLog().length).toBe(records);
  });

  test("one operation id binds to exactly one payload", () => {
    const machine = makeMachine(standardDirectory());
    const operationId = op();
    machine.registerPolicy({
      operation_id: operationId,
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const records = machine.auditLog().length;
    expectCode(
      () =>
        machine.registerPolicy({
          operation_id: operationId,
          actor: ACTOR,
          scope: SCOPE,
          policy: testPolicy({ policy_version: "2026-11-03.2" }),
        }),
      "OPERATION_CONFLICT",
    );
    expect(machine.auditLog().length).toBe(records);
  });

  test("a denial is recorded and the same operation succeeds once its precondition lands", () => {
    const machine = makeMachine(standardDirectory());
    const input = {
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      issue_id: "iss_1",
      service_mapping: mapped(),
      evidence: ROUTE_EVIDENCE,
    };
    expectCode(() => machine.route(input), "POLICY_NOT_REGISTERED");
    const denied = machine.auditLog()[0];
    expect(denied).toMatchObject({
      command: "route",
      outcome: "denied",
      denial_code: "POLICY_NOT_REGISTERED",
    });

    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const decision = machine.route(input);
    expect(decision.assignee_user_id).toBe(ALICE);
    expect(machine.auditLog()[2]).toMatchObject({ command: "route", outcome: "applied" });
  });

  test("replaying the audit log reproduces the exact state", () => {
    const directory = standardDirectory();
    const machine = makeMachine(directory);
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    machine.route({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      issue_id: "iss_1",
      service_mapping: mapped(),
      evidence: ROUTE_EVIDENCE,
    });
    machine.proposeTransfer({
      operation_id: op(),
      actor: ALICE,
      scope: SCOPE,
      issue_id: "iss_1",
      to_user_id: "usr_bob",
      reason: "bob is on call",
      evidence: null,
    });

    const replayed = RoutingMachine.fromAudit(machine.auditLog(), {
      directory: new FakeDirectory(),
    });
    expect(replayed.snapshotDigest()).toBe(machine.snapshotDigest());
  });

  test("a tampered audit log fails the rebuild", () => {
    const machine = makeMachine(standardDirectory());
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const records = machine.auditLog();
    const target = records[0];
    if (target === undefined) {
      throw new Error("expected an audit record");
    }
    (target.payload as Record<string, unknown>)["actor"] = "someone-else";
    expect(() => RoutingMachine.fromAudit(records, { directory: new FakeDirectory() })).toThrow(
      /not intact/,
    );
  });

  test("a restart from the persisted audit log keeps decisions and idempotency", () => {
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "routing-machine-")), "state.json");
    const clock = new Clock();
    const directory = standardDirectory();
    const machine = new RoutingMachine({
      directory,
      persistencePath: stateFile,
      now: clock.now,
    });
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    const input = {
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      issue_id: "iss_1",
      service_mapping: mapped(),
      evidence: ROUTE_EVIDENCE,
    };
    const decision = machine.route(input);

    const restarted = new RoutingMachine({
      directory,
      persistencePath: stateFile,
      now: clock.now,
    });
    expect(restarted.snapshotDigest()).toBe(machine.snapshotDigest());
    expect(restarted.getAssignment("iss_1")?.assignee_user_id).toBe(ALICE);
    expect(restarted.route(input)).toEqual(decision);
  });

  test("cross-workspace record references are refused", () => {
    const machine = makeMachine(standardDirectory());
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: SCOPE,
      policy: testPolicy(),
    });
    machine.registerPolicy({
      operation_id: op(),
      actor: ACTOR,
      scope: OTHER_SCOPE,
      policy: testPolicy(),
    });
    const proposal = machine.proposeTransfer({
      operation_id: op(),
      actor: ALICE,
      scope: SCOPE,
      issue_id: "iss_1",
      to_user_id: "usr_bob",
      reason: "handover",
      evidence: null,
    });
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: ALICE,
          scope: OTHER_SCOPE,
          proposal_id: proposal.transfer_id,
        }),
      "PROPOSAL_NOT_FOUND",
    );
    expectCode(
      () =>
        machine.confirmTransfer({
          operation_id: op(),
          actor: ALICE,
          scope: SCOPE,
          proposal_id: "rtf_unknown",
        }),
      "PROPOSAL_NOT_FOUND",
    );
  });

  test("a route without policy is denied before any directory trust", () => {
    const machine = makeMachine(standardDirectory());
    const serviceMapping: ServiceMapping = mapped();
    expectCode(
      () =>
        machine.route({
          operation_id: op(),
          actor: ACTOR,
          scope: SCOPE,
          issue_id: "iss_1",
          service_mapping: serviceMapping,
          evidence: ROUTE_EVIDENCE,
        }),
      "POLICY_NOT_REGISTERED",
    );
  });
});
