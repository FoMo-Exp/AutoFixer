import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { mapForeignError } from "../src/errors/index.js";
import { TraceStore } from "../src/trace/store.js";
import type { NewTraceEvent } from "../src/trace/schema.js";
import {
  DependentWorkPauseLedger,
  EncryptedQuarantine,
  SecurityCaseService,
  SecurityCaseStore,
  SecurityNotifier,
  auditEventFromCaseEvent,
  createMemorySecurityAuditTrail,
  inspectSecurityAuditTrailForTests,
  staticDutyDirectory,
} from "../src/security/index.js";
import type {
  NotificationSink,
  SecurityNotification,
  SecurityRoleDirectory,
} from "../src/security/index.js";

/**
 * DAT-213 acceptance: leakage tests cover notifications, errors, trace,
 * analytics, and audit exports. One secret-bearing block flows through every
 * surface; no surface may contain a planted secret value.
 *
 * Credential shapes are assembled at runtime so the repository's own secret
 * scanner does not flag the fixture.
 */

const SECRETS = {
  bearer: "0123456789abcdef0123456789abcdef",
  openaiKey: ["sk-proj-", "DEADBEEFCAFE", "0123456789"].join(""),
  awsKey: ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
  githubToken: ["ghp", "_1234567890", "abcdefghijklmnop"].join(""),
  literal: "ent-literal-secret-42",
};

function secretText(): string {
  return [
    `Authorization: Bearer ${SECRETS.bearer}`,
    `key ${SECRETS.openaiKey}`,
    `aws ${SECRETS.awsKey}`,
    `github ${SECRETS.githubToken}`,
  ].join("\n");
}

function expectNoSecrets(surfaces: Record<string, string>): void {
  for (const [name, serialized] of Object.entries(surfaces)) {
    for (const [secretName, value] of Object.entries(SECRETS)) {
      expect(serialized, `${name} leaked ${secretName}`).not.toContain(value);
    }
  }
}

const SCOPE = {
  enterpriseId: "ent_test",
  workspaceId: "ws_test",
  issueId: "issue_1",
  runId: "run_1",
};

const DUTIES = staticDutyDirectory({
  handlers: ["human_handler"],
  reviewers: ["human_reviewer"],
  admins: ["human_admin"],
});

const ROLES: SecurityRoleDirectory = {
  resolve: () => ({
    workspaceHandlers: [{ recipientId: "human_handler", role: "workspace_security_handler" }],
    enterpriseAdmins: [{ recipientId: "human_admin", role: "enterprise_security_admin" }],
  }),
};

const KEY = Buffer.alloc(32, 9);

function harness(): {
  audit: ReturnType<typeof createMemorySecurityAuditTrail>;
  service: SecurityCaseService;
  store: SecurityCaseStore;
  sent: SecurityNotification[];
} {
  const sent: SecurityNotification[] = [];
  const sink: NotificationSink = {
    send(notification) {
      sent.push(notification);
    },
  };
  const audit = createMemorySecurityAuditTrail({ key: KEY });
  const store = new SecurityCaseStore({
    onEvent: (event, record) => {
      audit.record(auditEventFromCaseEvent(record, event));
    },
  });
  const service = new SecurityCaseService({
    caseStore: store,
    pauses: new DependentWorkPauseLedger(),
    notifier: new SecurityNotifier({ directory: ROLES, sink, referenceSecret: KEY }),
    quarantine: new EncryptedQuarantine({
      keyProvider: { keyId: "test", currentKey: () => KEY },
      retentionSeconds: 3600,
    }),
    referenceSecret: KEY,
    duties: DUTIES,
  });
  return { audit, service, store, sent };
}

describe("a secret-bearing block never reaches an observable surface", () => {
  test("case history, pause state, notification, and audit trail are non-secret", async () => {
    const { audit, service, store, sent } = harness();
    const result = await service.recordBlock({
      identity: {
        ...SCOPE,
        invocationId: "inv_1",
        traceId: "trace_1",
      },
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: secretText(),
      rawContent: secretText(),
    });

    // Quarantine retained the raw context (encrypted); the case view did not.
    expect(result.quarantineId).toBeDefined();
    expectNoSecrets({
      case: JSON.stringify(store.get(result.case.caseId)),
      events: JSON.stringify(store.events(result.case.caseId)),
      pause: JSON.stringify(service.isRunHeld(SCOPE.runId)),
      notifications: JSON.stringify(sent),
      audit: JSON.stringify(inspectSecurityAuditTrailForTests(audit)),
    });
    expect(result.case.blocks[0]!.reason).toBe("SENSITIVE_DATA_UNCERTAIN");
    // The message never becomes a credential: the reference verifies for the
    // run, not for whoever holds the notification.
    expect(sent[0]!.reason).toBe("SENSITIVE_DATA_UNCERTAIN");
  });

  test("the shared error envelope and sealed diagnostics are non-secret", () => {
    const mapped = mapForeignError(
      {
        code: "SENSITIVE_DATA_UNCERTAIN",
        message: secretText(),
        details: { note: secretText() },
      },
      { traceId: "trace_1", caseRef: "case_1", literalSecrets: [SECRETS.literal] },
    );
    expectNoSecrets({
      envelope: JSON.stringify(mapped.envelope),
      diagnostics: JSON.stringify(mapped.diagnostics),
    });
  });

  test("trace persistence, trace reads, analytics, and exports are non-secret", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-trace-leak-"));
    const file = path.join(dir, "trace.json");
    const store = new TraceStore({
      persistencePath: file,
      now: () => new Date("2026-11-04T00:00:00.000Z"),
    });
    const event: NewTraceEvent = {
      source: "test",
      event_id: "evt_1",
      sequence: 1,
      event_time: "2026-11-04T00:00:00.000Z",
      record_class: "worker_evidence",
      kind: "gateway.invocation_started",
      enterprise_id: SCOPE.enterpriseId,
      workspace_id: SCOPE.workspaceId,
      issue_id: SCOPE.issueId,
      run_id: SCOPE.runId,
      trace_id: "trace_1",
      span_id: "span_1",
      invocation_id: "inv_1",
      payload: { message: secretText() },
    };
    expect(store.append(event).status).toBe("recorded");
    const scope = {
      enterprise_id: SCOPE.enterpriseId,
      workspace_id: SCOPE.workspaceId,
      subject: "human_admin",
    };
    store.flushSync();
    expectNoSecrets({
      read: JSON.stringify(store.query(scope)),
      export: JSON.stringify(store.export(scope)),
      analytics: JSON.stringify(store.aggregate(scope, undefined, ["kind"])),
      persisted: readFileSync(file, "utf8"),
    });
  });

  test("the audited export itself is non-secret", async () => {
    const { audit, service, store, sent } = harness();
    await service.recordBlock({
      identity: { ...SCOPE, invocationId: "inv_1", traceId: "trace_1" },
      reason: "SENSITIVE_DATA_UNCERTAIN",
      safeDetail: secretText(),
    });
    const exported = audit.export(
      { enterpriseId: SCOPE.enterpriseId, workspaceId: SCOPE.workspaceId },
      {
        actor: { actorId: "human_admin", actorKind: "human" },
        duties: DUTIES,
        purpose: "leak regression",
      },
    );
    expect(exported.eventCount).toBeGreaterThan(0);
    expectNoSecrets({ export: JSON.stringify(exported) });
    // Sanity: the fixture really did flow through the case machinery.
    expect(store.events(exported.entries[0]!.event.caseId as string).length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });
});
