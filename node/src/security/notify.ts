/**
 * Security-case notification and authenticated case references (DAT-210,
 * ADR-0005 §2).
 *
 * Blocking notifies the workspace's designated security handler, escalating to
 * the enterprise security administrator when nobody is available. A
 * notification carries only a redacted reason and an authenticated case
 * reference — never suspected secret material, and never a transferable
 * credential. The reference is an audience-bound MAC: it names one case for
 * exactly one recipient and never verifies for anyone else.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import { SecurityError, requireNonEmpty } from "./types.js";
import type { CaseScope, SecurityCase } from "./types.js";

export type SecurityRole = "workspace_security_handler" | "enterprise_security_admin";

export interface SecurityRecipient {
  recipientId: string;
  role: SecurityRole;
}

/**
 * ADR-0006 seam: who holds the security roles for one enterprise/workspace
 * scope. The notifier never invents recipients; a deployment resolves real
 * people here.
 */
export interface SecurityRoleDirectory {
  resolve(scope: CaseScope): {
    workspaceHandlers: readonly SecurityRecipient[];
    enterpriseAdmins: readonly SecurityRecipient[];
  };
}

/**
 * One delivered notification. `reason` and `safeDetail` are scrubbed text;
 * `caseReference` is minted for `recipient:<recipientId>` and is useless to
 * anyone else.
 */
export interface SecurityNotification {
  notificationId: string;
  caseId: string;
  recipientId: string;
  role: SecurityRole;
  reason: string;
  safeDetail: string;
  caseReference: string;
  escalated: boolean;
  sentAt: string;
}

/** Delivery seam (mail, chat, pager…). Failures surface, never silently drop. */
export interface NotificationSink {
  send(notification: SecurityNotification): void | Promise<void>;
}

/**
 * Durable deployment-grade notification sink: one JSONL line per
 * notification (non-secret by construction). A write failure propagates to
 * the notifier, which records the delivery as undeliverable — a dropped
 * notification is always explicit.
 */
export function createFileNotificationSink(file: string): NotificationSink {
  fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
  return {
    send(notification: SecurityNotification): void {
      fs.appendFileSync(file, `${JSON.stringify(notification)}\n`, { mode: 0o600 });
    },
  };
}

export interface NotifyResult {
  notifications: SecurityNotification[];
  /** True when the workspace had no handler and enterprise admins were used. */
  escalated: boolean;
  /** True when nobody was available anywhere; the case stays open and blocked. */
  undeliverable: boolean;
}

export interface NotifierDeps {
  directory: SecurityRoleDirectory;
  sink: NotificationSink;
  /** Service secret for minting audience-bound case references. */
  referenceSecret: Buffer;
  now?: () => Date;
  newId?: () => string;
}

function b64u(value: string | Buffer): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

function unb64u(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("not base64url");
  return decoded;
}

/**
 * Mint an authenticated, non-transferable case reference for one audience.
 * The reference proves which case it names and for whom; verifying it with a
 * different audience — or a different case — always fails.
 */
export function mintCaseReference(secret: Buffer, caseId: string, audience: string): string {
  const mac = createHmac("sha256", secret).update(`cr1|${caseId}|${audience}`).digest();
  return `cr1.${b64u(caseId)}.${b64u(audience)}.${b64u(mac)}`;
}

/** Constant-time verification of an audience-bound case reference. */
export function verifyCaseReference(
  secret: Buffer,
  reference: string,
  caseId: string,
  audience: string,
): boolean {
  const parts = reference.split(".");
  if (parts.length !== 4) return false;
  const [scheme, casePart, audiencePart, macPart] = parts;
  if (scheme !== "cr1" || !casePart || !audiencePart || !macPart) return false;
  let embedded: { caseId: string; audience: string; mac: Buffer };
  try {
    embedded = {
      caseId: unb64u(casePart).toString("utf8"),
      audience: unb64u(audiencePart).toString("utf8"),
      mac: unb64u(macPart),
    };
  } catch {
    return false;
  }
  if (embedded.caseId !== caseId || embedded.audience !== audience) return false;
  const expected = createHmac("sha256", secret).update(`cr1|${caseId}|${audience}`).digest();
  return embedded.mac.length === expected.length && timingSafeEqual(embedded.mac, expected);
}

export class SecurityNotifier {
  private readonly deps: NotifierDeps;

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  /**
   * Notify the designated handlers that a case opened. Escalates to the
   * enterprise security administrator when the workspace has nobody; when no
   * recipient exists anywhere the outcome is explicit `undeliverable` — the
   * case and its block still stand.
   */
  async notifyOpenCase(
    caseRecord: SecurityCase,
    reason: string,
    safeDetail: string,
  ): Promise<NotifyResult> {
    const scope = caseRecord.scope;
    const resolved = this.deps.directory.resolve(scope);
    const handlers = [...resolved.workspaceHandlers];
    const escalated = handlers.length === 0;
    const recipients = escalated ? [...resolved.enterpriseAdmins] : handlers;
    if (recipients.length === 0) {
      return { notifications: [], escalated, undeliverable: true };
    }
    const safeReason = scrubSecrets(requireNonEmpty(reason, "reason"));
    const safe = scrubSecrets(safeDetail);
    const notifications: SecurityNotification[] = [];
    for (const recipient of recipients) {
      requireNonEmpty(recipient.recipientId, "recipient.recipientId");
      const notification: SecurityNotification = {
        notificationId: this.deps.newId
          ? this.deps.newId()
          : `${caseRecord.caseId}:${recipient.recipientId}`,
        caseId: caseRecord.caseId,
        recipientId: recipient.recipientId,
        role: recipient.role,
        reason: safeReason,
        safeDetail: safe,
        caseReference: mintCaseReference(
          this.deps.referenceSecret,
          caseRecord.caseId,
          `recipient:${recipient.recipientId}`,
        ),
        escalated,
        sentAt: (this.deps.now ? this.deps.now() : new Date()).toISOString(),
      };
      try {
        await this.deps.sink.send(notification);
      } catch {
        throw new SecurityError(
          "NOTIFICATION_UNDELIVERABLE",
          `security notification for case ${caseRecord.caseId} could not be delivered`,
          { caseId: caseRecord.caseId, recipientId: recipient.recipientId },
        );
      }
      notifications.push(notification);
    }
    return { notifications, escalated, undeliverable: false };
  }
}
