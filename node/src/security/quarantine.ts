/**
 * Encrypted quarantine for raw retained context (DAT-210, ADR-0005 §2).
 *
 * Raw blocked-request context, when it must be retained at all, lives here:
 * AES-256-GCM encrypted at rest, under a bounded retention, with access
 * controlled by separately granted scoped authorizations. Every view produces
 * an audit event; ordinary logs, notifications, errors, and analytics never
 * contain the quarantined values. An unavailable key fails closed — nothing
 * is ever stored in plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scrubSecrets } from "../gateway/redact.js";
import { SecurityError, isHumanOrService, requireNonEmpty } from "./types.js";
import type { SecurityActor } from "./types.js";

/**
 * Deployment-owned quarantine key seam (e.g. a KMS handle in production).
 * `currentKey` returning nothing means encryption is unavailable — the
 * quarantine fails closed rather than degrading to plaintext.
 */
export interface QuarantineKeyProvider {
  readonly keyId: string;
  currentKey(): Buffer | undefined;
}

/** Encrypted quarantine record; `ciphertext` is the only content carrier. */
export interface QuarantineRecord {
  quarantineId: string;
  caseId: string;
  keyId: string;
  createdAt: string;
  expiresAt: string;
  ciphertext: string;
  iv: string;
  tag: string;
  bytes: number;
}

/** Metadata view of a record; never carries ciphertext or content. */
export interface QuarantineRecordMeta {
  quarantineId: string;
  caseId: string;
  keyId: string;
  createdAt: string;
  expiresAt: string;
  bytes: number;
}

/**
 * One separately granted, scoped authorization to inspect quarantined
 * context. Granted by a human/service principal, bound to one subject and one
 * record, and time-limited — it is never part of a case, a notification, or a
 * case reference.
 */
export interface QuarantineAccessGrant {
  grantId: string;
  quarantineId: string;
  subject: string;
  scope: "inspect";
  grantedBy: string;
  createdAt: string;
  expiresAt: string;
}

export type QuarantineEventType =
  | "quarantine.sealed"
  | "quarantine.access_granted"
  | "quarantine.accessed"
  | "quarantine.access_denied"
  | "quarantine.expired";

export interface QuarantineAuditEvent {
  type: QuarantineEventType;
  caseId: string;
  quarantineId: string;
  actor: SecurityActor | null;
  at: string;
  /** Identifiers and counts only; never quarantined content. */
  detail: Record<string, string | number | boolean>;
}

export interface QuarantineDeps {
  keyProvider: QuarantineKeyProvider;
  /** Bounded retention for sealed context, in seconds. */
  retentionSeconds: number;
  /** Lifetime of one inspection grant, in seconds (default 15 minutes). */
  grantTtlSeconds?: number;
  now?: () => Date;
  newId?: () => string;
  persistencePath?: string;
  onEvent?: (event: QuarantineAuditEvent) => void;
  onIncident?: (message: string) => void;
}

export type SealResult =
  { quarantineId: string; expiresAt: string } | { unavailable: true; detail: string };

const SCHEMA_VERSION = 1;
const DEFAULT_GRANT_TTL_SECONDS = 900;
const IV_BYTES = 12;

interface PersistedState {
  schema_version: number;
  records: QuarantineRecord[];
  grants: QuarantineAccessGrant[];
}

function metaOf(record: QuarantineRecord): QuarantineRecordMeta {
  return {
    quarantineId: record.quarantineId,
    caseId: record.caseId,
    keyId: record.keyId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    bytes: record.bytes,
  };
}

/**
 * Authorization-boundary principal check: exactly an identified human or
 * service actor. Anonymous shapes, `run` actors, and unrecognized actorKind
 * values are refused outright — unknown kinds never become principals.
 */
function isUsablePrincipal(actor: SecurityActor): boolean {
  return isHumanOrService(actor);
}

export class EncryptedQuarantine {
  private readonly records = new Map<string, QuarantineRecord>();
  private readonly grants = new Map<string, QuarantineAccessGrant>();
  private readonly deps: QuarantineDeps;

  constructor(deps: QuarantineDeps) {
    this.deps = deps;
    this.load();
  }

  /**
   * Seal raw context for one case. Encryption is all-or-nothing: when no
   * usable key exists nothing is stored and the caller is told the quarantine
   * is unavailable (the block and case still stand).
   */
  seal(caseId: string, content: string): SealResult {
    requireNonEmpty(caseId, "caseId");
    if (typeof content !== "string") {
      throw new SecurityError("SECURITY_INPUT_INVALID", "quarantine content must be text");
    }
    const key = this.currentKey();
    if (!key) {
      this.incident(`quarantine seal failed closed: no usable key for case ${caseId}`);
      return { unavailable: true, detail: "quarantine encryption key is unavailable" };
    }
    const quarantineId = this.newId();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`crq|${quarantineId}|${caseId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const now = this.timestamp();
    const record: QuarantineRecord = {
      quarantineId,
      caseId,
      keyId: this.deps.keyProvider.keyId,
      createdAt: now,
      expiresAt: new Date(this.now().getTime() + this.deps.retentionSeconds * 1000).toISOString(),
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      bytes: Buffer.byteLength(content, "utf8"),
    };
    this.records.set(quarantineId, record);
    this.persist();
    this.emit("quarantine.sealed", caseId, quarantineId, null, {
      keyId: record.keyId,
      bytes: record.bytes,
    });
    return { quarantineId: record.quarantineId, expiresAt: record.expiresAt };
  }

  /**
   * Grant one subject scoped, time-limited inspection of one record. Human
   * or service principals only — a run never authorizes its own inspection —
   * and the grant is separate from case handling or notification. The calling
   * actor is validated at this authorization boundary, before anything is
   * recorded or issued.
   */
  grantAccess(quarantineId: string, subject: string, actor: SecurityActor): QuarantineAccessGrant {
    requireNonEmpty(subject, "subject");
    const record = this.records.get(quarantineId);
    if (!record) {
      throw new SecurityError("QUARANTINE_NOT_FOUND", `no quarantine record ${quarantineId}`, {
        quarantineId,
      });
    }
    if (!isUsablePrincipal(actor)) {
      this.emit("quarantine.access_denied", record.caseId, quarantineId, null, { action: "grant" });
      throw new SecurityError(
        "QUARANTINE_ACCESS_DENIED",
        "quarantine access is restricted to human or service actors",
        { quarantineId },
      );
    }
    if (this.isPast(record.expiresAt)) {
      throw new SecurityError("QUARANTINE_EXPIRED", `quarantine record ${quarantineId} expired`, {
        quarantineId,
      });
    }
    const grant: QuarantineAccessGrant = {
      grantId: this.newId(),
      quarantineId,
      subject,
      scope: "inspect",
      grantedBy: actor.actorId,
      createdAt: this.timestamp(),
      expiresAt: new Date(
        this.now().getTime() + (this.deps.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS) * 1000,
      ).toISOString(),
    };
    this.grants.set(grant.grantId, grant);
    this.persist();
    this.emit("quarantine.access_granted", record.caseId, quarantineId, actor, {
      grantId: grant.grantId,
      subject,
    });
    return grant;
  }

  /**
   * View quarantined content under one scoped grant, addressed by its id.
   * Only a grant this store actually issued — looked up here, never a
   * caller-supplied object — can authorize a read: the authorization is
   * unforgeable. The calling actor is validated at this boundary before any
   * decrypt, and every attempt — allowed or denied — produces an audit event.
   */
  read(quarantineId: string, grantId: string, actor: SecurityActor): string {
    const record = this.records.get(quarantineId);
    if (!record) {
      throw new SecurityError("QUARANTINE_NOT_FOUND", `no quarantine record ${quarantineId}`, {
        quarantineId,
      });
    }
    const deny = (detail: Record<string, string | number | boolean>): never => {
      this.emit("quarantine.access_denied", record.caseId, quarantineId, null, detail);
      throw new SecurityError(
        "QUARANTINE_ACCESS_DENIED",
        "quarantined context requires a separately granted scoped access",
        { quarantineId },
      );
    };
    // Authorization boundary first: an anonymous or run principal never
    // reads, whatever it presents.
    if (!isUsablePrincipal(actor)) {
      return deny({ action: "read" });
    }
    if (this.isPast(record.expiresAt)) {
      this.emit("quarantine.expired", record.caseId, quarantineId, null, { grantId: "" });
      throw new SecurityError("QUARANTINE_EXPIRED", `quarantine record ${quarantineId} expired`, {
        quarantineId,
      });
    }
    // The grant must be one this store issued, for this record, to this
    // subject: a forged id or borrowed grant reads nothing.
    const grant =
      typeof grantId === "string" && grantId.length > 0 ? this.grants.get(grantId) : undefined;
    if (!grant || grant.quarantineId !== quarantineId || grant.subject !== actor.actorId) {
      return deny({ action: "read" });
    }
    if (this.isPast(grant.expiresAt)) {
      this.emit("quarantine.access_denied", record.caseId, quarantineId, actor, {
        action: "read",
        expired: true,
      });
      throw new SecurityError("QUARANTINE_EXPIRED", `quarantine grant ${grant.grantId} expired`, {
        quarantineId,
      });
    }
    const key = this.currentKey();
    if (!key) {
      return deny({ action: "read", keyUnavailable: true });
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
      decipher.setAAD(Buffer.from(`crq|${quarantineId}|${record.caseId}`, "utf8"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      this.emit("quarantine.accessed", record.caseId, quarantineId, actor, {
        grantId: grant.grantId,
      });
      return plaintext;
    } catch {
      return deny({ action: "read", decrypt: "failed" });
    }
  }

  /** Metadata only; ciphertext and content never leave the store. */
  get(quarantineId: string): QuarantineRecordMeta | undefined {
    const record = this.records.get(quarantineId);
    return record ? metaOf(record) : undefined;
  }

  /** Delete expired records; the deletion itself is an audited event. */
  sweep(): string[] {
    const swept: string[] = [];
    for (const record of [...this.records.values()]) {
      if (!this.isPast(record.expiresAt)) continue;
      this.records.delete(record.quarantineId);
      swept.push(record.quarantineId);
      this.emit("quarantine.expired", record.caseId, record.quarantineId, null, {
        sweep: true,
      });
    }
    if (swept.length > 0) this.persist();
    return swept;
  }

  private currentKey(): Buffer | undefined {
    let key: Buffer | undefined;
    try {
      key = this.deps.keyProvider.currentKey();
    } catch {
      key = undefined;
    }
    return key && Buffer.isBuffer(key) && key.length === 32 ? key : undefined;
  }

  private emit(
    type: QuarantineEventType,
    caseId: string,
    quarantineId: string,
    actor: SecurityActor | null,
    detail: Record<string, string | number | boolean>,
  ): void {
    if (!this.deps.onEvent) return;
    this.deps.onEvent({
      type,
      caseId,
      quarantineId,
      actor,
      at: this.timestamp(),
      detail: Object.fromEntries(
        Object.entries(detail).map(([keyName, value]) => [
          keyName,
          typeof value === "string" ? scrubSecrets(value) : value,
        ]),
      ),
    });
  }

  private incident(message: string): void {
    if (this.deps.onIncident) {
      this.deps.onIncident(message);
      return;
    }
    console.error(message);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private isPast(iso: string): boolean {
    return Date.parse(iso) <= this.now().getTime();
  }

  private newId(): string {
    return this.deps.newId ? this.deps.newId() : randomUUID();
  }

  private load(): void {
    const file = this.deps.persistencePath;
    if (!file || !fs.existsSync(file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new SecurityError(
        "QUARANTINE_STORE_INVALID",
        "quarantine state file is not valid JSON",
      );
    }
    const state = parsed as Partial<PersistedState>;
    if (
      state.schema_version !== SCHEMA_VERSION ||
      !Array.isArray(state.records) ||
      !Array.isArray(state.grants)
    ) {
      throw new SecurityError(
        "QUARANTINE_STORE_INVALID",
        "quarantine state file has an unsupported shape",
      );
    }
    for (const record of state.records) this.records.set(record.quarantineId, record);
    for (const grant of state.grants) this.grants.set(grant.grantId, grant);
  }

  private persist(): void {
    const file = this.deps.persistencePath;
    if (!file) return;
    const state: PersistedState = {
      schema_version: SCHEMA_VERSION,
      records: [...this.records.values()],
      grants: [...this.grants.values()],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}
