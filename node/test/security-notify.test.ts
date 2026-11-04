/**
 * Security-case notification (DAT-210, ADR-0005 §2).
 *
 * Blocking notifies the workspace's designated security handler and escalates
 * to the enterprise security administrator when nobody is available. The
 * notification carries a redacted reason and an authenticated case reference
 * — never the suspected secret, and never a transferable credential: the
 * reference verifies only for the recipient it was minted for.
 */
import { describe, expect, test } from "vitest";

import {
  SecurityError,
  SecurityNotifier,
  mintCaseReference,
  verifyCaseReference,
  type NotificationSink,
  type SecurityCase,
  type SecurityNotification,
  type SecurityRecipient,
  type SecurityRoleDirectory,
} from "../src/security/index.js";

const CASE: SecurityCase = {
  caseId: "case_1",
  scope: {
    enterpriseId: "ent_test",
    workspaceId: "ws_test",
    issueId: "issue_test",
    runId: "run_test",
  },
  state: "pending",
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
  blocks: [],
  quarantineIds: [],
};

const HANDLER: SecurityRecipient = {
  recipientId: "handler_1",
  role: "workspace_security_handler",
};
const ADMIN: SecurityRecipient = {
  recipientId: "admin_1",
  role: "enterprise_security_admin",
};

const SECRET = Buffer.alloc(32, 7);

// Assembled at runtime: repository secret scanners would flag literals.
const SECRET_VALUE = "sk-" + "live-abcdef1234567890";

function directoryOf(
  workspaceHandlers: SecurityRecipient[],
  enterpriseAdmins: SecurityRecipient[] = [ADMIN],
): SecurityRoleDirectory {
  return { resolve: () => ({ workspaceHandlers, enterpriseAdmins }) };
}

function recordingSink(): {
  sink: NotificationSink;
  sent: SecurityNotification[];
} {
  const sent: SecurityNotification[] = [];
  return {
    sink: {
      send(notification: SecurityNotification) {
        sent.push(notification);
      },
    },
    sent,
  };
}

function notifierWith(directory: SecurityRoleDirectory, sink: NotificationSink): SecurityNotifier {
  return new SecurityNotifier({ directory, sink, referenceSecret: SECRET });
}

describe("SecurityNotifier routing and escalation", () => {
  test("the workspace security handler is notified with a redacted reason and case reference", async () => {
    const { sink, sent } = recordingSink();
    const notifier = notifierWith(directoryOf([HANDLER]), sink);
    const result = await notifier.notifyOpenCase(
      CASE,
      "SENSITIVE_DATA_UNCERTAIN",
      `suspected secret ${SECRET_VALUE} in request`,
    );
    expect(result.escalated).toBe(false);
    expect(result.undeliverable).toBe(false);
    expect(sent).toHaveLength(1);
    const notification = sent[0] as SecurityNotification;
    expect(notification.recipientId).toBe("handler_1");
    expect(notification.role).toBe("workspace_security_handler");
    expect(notification.reason).toBe("SENSITIVE_DATA_UNCERTAIN");
    // Redacted reason/safe text: never the suspected secret value.
    expect(JSON.stringify(notification)).not.toContain(SECRET_VALUE);
    expect(notification.caseReference).toBe(
      mintCaseReference(SECRET, "case_1", "recipient:handler_1"),
    );
  });

  test("nobody available in the workspace escalates to the enterprise security administrator", async () => {
    const { sink, sent } = recordingSink();
    const notifier = notifierWith(directoryOf([]), sink);
    const result = await notifier.notifyOpenCase(CASE, "SENSITIVE_DATA_UNCERTAIN", "blocked");
    expect(result.escalated).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.recipientId).toBe("admin_1");
    expect(sent[0]?.role).toBe("enterprise_security_admin");
    expect(sent[0]?.escalated).toBe(true);
  });

  test("no handler anywhere is an explicit undeliverable outcome, not a silent drop", async () => {
    const { sink, sent } = recordingSink();
    const notifier = notifierWith(directoryOf([], []), sink);
    const result = await notifier.notifyOpenCase(CASE, "SENSITIVE_DATA_UNCERTAIN", "blocked");
    expect(result.undeliverable).toBe(true);
    expect(sent).toHaveLength(0);
    expect(result.notifications).toHaveLength(0);
  });

  test("a failing notification sink never hides the notification outcome", async () => {
    const notifier = notifierWith(directoryOf([HANDLER]), {
      send() {
        throw new Error("transport down");
      },
    });
    await expect(
      notifier.notifyOpenCase(CASE, "SENSITIVE_DATA_UNCERTAIN", "blocked"),
    ).rejects.toThrow(SecurityError);
  });
});

describe("authenticated case references", () => {
  test("a reference verifies for its own case and audience", () => {
    const reference = mintCaseReference(SECRET, "case_1", "recipient:handler_1");
    expect(verifyCaseReference(SECRET, reference, "case_1", "recipient:handler_1")).toBe(true);
  });

  test("a reference is non-transferable: another recipient cannot use it", () => {
    const reference = mintCaseReference(SECRET, "case_1", "recipient:handler_1");
    expect(verifyCaseReference(SECRET, reference, "case_1", "recipient:admin_1")).toBe(false);
  });

  test("a tampered or forged reference never verifies", () => {
    const reference = mintCaseReference(SECRET, "case_1", "recipient:handler_1");
    expect(verifyCaseReference(SECRET, reference, "case_2", "recipient:handler_1")).toBe(false);
    const forged = mintCaseReference(Buffer.alloc(32, 9), "case_1", "recipient:handler_1");
    expect(verifyCaseReference(SECRET, forged, "case_1", "recipient:handler_1")).toBe(false);
    expect(verifyCaseReference(SECRET, "cr1.garbage", "case_1", "recipient:handler_1")).toBe(false);
  });
});
