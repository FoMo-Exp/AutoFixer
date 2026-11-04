/**
 * Dashboard read/export audit (DAT-230, ADR-0008 "export/read operations are
 * audited").
 *
 * Every dashboard read — including a denied, empty, or stale-data read — is an
 * audit event: who asked, for which enterprise/workspace, through which
 * resource, with which period and paging parameters, and how many records the
 * answer contained. Export is recorded as its own operation class, so a bulk
 * extraction is distinguishable from a single page read.
 *
 * The audit record holds only request metadata. It never contains prompt
 * content, tool arguments, cost amounts, token figures, or quarantine
 * material: an audit trail that leaked the data it audits would defeat the
 * separation it exists to protect.
 *
 * Entries are append-only. With a persistence path every append is written
 * durably before the call returns; a corrupt existing line fails loading
 * loudly instead of silently truncating the trail.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  DashboardAuditEntry,
  DashboardAuditOperation,
  DashboardAuditResource,
} from "./types.js";

export interface DashboardAuditScope {
  enterprise_id: string;
  workspace_id: string;
  subject: string;
}

export interface DashboardAuditAppendInput {
  enterprise_id: string;
  workspace_id: string;
  subject: string;
  role: string;
  operation: DashboardAuditOperation;
  resource: DashboardAuditResource;
  issue_id: string | null;
  query: Record<string, string | number | null>;
  record_count: number;
  request_id: string;
}

export interface DashboardAuditFilter {
  operation?: DashboardAuditOperation;
  resource?: DashboardAuditResource;
}

export interface DashboardAuditLogOptions {
  /** Private durable audit file (JSONL, 0600). Omit for a process-local log. */
  persistencePath?: string;
  now?: () => Date;
}

export class DashboardAuditLog {
  private readonly entries: DashboardAuditEntry[] = [];
  private readonly persistencePath: string | undefined;
  private readonly now: () => Date;

  constructor(options: DashboardAuditLogOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /** Append one entry; with a persistence path it is durable on return. */
  append(input: DashboardAuditAppendInput): DashboardAuditEntry {
    const entry: DashboardAuditEntry = {
      audit_id: `aud_${randomUUID().replaceAll("-", "")}`,
      at: this.now().toISOString(),
      enterprise_id: input.enterprise_id,
      workspace_id: input.workspace_id,
      subject: input.subject,
      role: input.role,
      operation: input.operation,
      resource: input.resource,
      issue_id: input.issue_id,
      query: { ...input.query },
      record_count: input.record_count,
      request_id: input.request_id,
    };
    if (this.persistencePath !== undefined) {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.persistencePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
    this.entries.push(entry);
    return entry;
  }

  /** Newest-first scoped entries; asks for another workspace are refused. */
  list(scope: DashboardAuditScope, filter: DashboardAuditFilter = {}): DashboardAuditEntry[] {
    // The log is multi-tenant; every read is filtered to the caller's
    // enterprise and workspace, and never reveals another tenant's activity.
    const out: DashboardAuditEntry[] = [];
    for (const entry of this.entries) {
      if (
        entry.enterprise_id !== scope.enterprise_id ||
        entry.workspace_id !== scope.workspace_id
      ) {
        continue;
      }
      if (filter.operation !== undefined && entry.operation !== filter.operation) {
        continue;
      }
      if (filter.resource !== undefined && entry.resource !== filter.resource) {
        continue;
      }
      out.push({ ...entry, query: { ...entry.query } });
    }
    return out.sort((a, b) => {
      const byTime = Date.parse(b.at) - Date.parse(a.at);
      return byTime !== 0 ? byTime : a.audit_id < b.audit_id ? 1 : -1;
    });
  }

  private load(): void {
    if (this.persistencePath === undefined || !fs.existsSync(this.persistencePath)) {
      return;
    }
    const text = fs.readFileSync(this.persistencePath, "utf8");
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`dashboard audit log line ${index + 1} is not valid JSON`);
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`dashboard audit log line ${index + 1} is not an object`);
      }
      this.entries.push(parsed as DashboardAuditEntry);
    }
  }
}
