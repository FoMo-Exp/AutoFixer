/**
 * Session-scoped enterprise capability projection (DAT-278). The projection
 * is the only source for the enterprise-directory entry and its action
 * affordances; every request is still authorized by the service.
 *
 * Fail closed: an unknown schema, a foreign enterprise, an unparseable
 * freshness window, an unknown module decision or an expired window leaves no
 * client-side grant. The directory is never reconstructed from a cached role.
 */

export const ENTERPRISE_MODULES = [
  "enterprise_directory",
  "identity_audit",
  "service_integration",
  "workspace_data",
] as const;

export type EnterpriseModule = (typeof ENTERPRISE_MODULES)[number];

export const ENTERPRISE_MODULE_ACTIONS: Record<EnterpriseModule, readonly string[]> = {
  enterprise_directory: ["view", "add_user", "suspend_user", "restore_user", "change_role"],
  identity_audit: ["read"],
  service_integration: ["view_metadata", "configure"],
  workspace_data: [
    "view_tasks",
    "view_issues",
    "view_memory",
    "view_rsi",
    "view_dashboard",
    "view_security",
  ],
};

export const ENTERPRISE_DATA_CEILINGS = ["none", "directory", "audit", "metadata"] as const;
export type EnterpriseDataCeiling = (typeof ENTERPRISE_DATA_CEILINGS)[number];

export interface EnterpriseActionDecision {
  allowed: boolean;
  required: string;
  reason: string | null;
}

export interface EnterpriseModuleAccess {
  visible: boolean;
  dataCeiling: EnterpriseDataCeiling;
  reason: string | null;
  actions: Readonly<Record<string, EnterpriseActionDecision>>;
}

export interface EnterpriseCapabilitySnapshot {
  enterpriseId: string;
  member: { status: "active" | "suspended"; role: "admin" | "member" };
  modules: Readonly<Record<EnterpriseModule, EnterpriseModuleAccess>>;
  checkedAt: string;
  expiresAt: string;
  staleAfter: string;
  /** A fresh, schema-valid projection; false means no client-side decision. */
  trusted: boolean;
  invalidation: readonly string[];
}

export class EnterpriseProjectionError extends Error {
  constructor(readonly code: string) {
    super(`Enterprise capability projection rejected: ${code}`);
    this.name = "EnterpriseProjectionError";
  }
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function denied(reason: string, required = "unavailable"): EnterpriseActionDecision {
  return { allowed: false, required, reason };
}

interface RawAction {
  allowed?: unknown;
  required?: unknown;
  reason?: unknown;
}

function readActions(
  raw: unknown,
  module: EnterpriseModule,
  forcedDenyReason: string | null,
): Record<string, EnterpriseActionDecision> {
  const actions: Record<string, EnterpriseActionDecision> = {};
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  for (const name of ENTERPRISE_MODULE_ACTIONS[module]) {
    const candidate = source[name];
    const entry =
      candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as RawAction)
        : undefined;
    if (forcedDenyReason !== null) {
      actions[name] = denied(
        forcedDenyReason,
        typeof entry?.required === "string" ? entry.required : "unavailable",
      );
      continue;
    }
    if (typeof entry?.allowed !== "boolean") {
      actions[name] = denied("action_policy");
      continue;
    }
    actions[name] = {
      allowed: entry.allowed,
      required: typeof entry.required === "string" ? entry.required : "unavailable",
      reason: typeof entry.reason === "string" ? entry.reason : null,
    };
  }
  return actions;
}

interface RawModule {
  visible?: unknown;
  data_ceiling?: unknown;
  reason?: unknown;
  actions?: unknown;
}

function readModule(
  raw: unknown,
  module: EnterpriseModule,
  forcedDenyReason: string | null,
): EnterpriseModuleAccess {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as RawModule) : undefined;
  return {
    visible: forcedDenyReason === null && source?.visible === true,
    reason: typeof source?.reason === "string" ? source.reason : null,
    dataCeiling:
      forcedDenyReason === null &&
      typeof source?.data_ceiling === "string" &&
      ENTERPRISE_DATA_CEILINGS.includes(source.data_ceiling as EnterpriseDataCeiling)
        ? (source.data_ceiling as EnterpriseDataCeiling)
        : "none",
    actions: readActions(source?.actions, module, forcedDenyReason),
  };
}

export interface EnterpriseParseOptions {
  /** The enterprise whose projection was requested. */
  enterpriseId: string;
  /** Milliseconds since epoch; injected so expiry is testable. */
  now?: number;
}

/**
 * Validate and normalize one `GET /enterprises/{id}/capabilities` response.
 * Throws `EnterpriseProjectionError` when the response cannot be trusted at
 * all (wrong version, wrong enterprise, unparseable freshness).
 */
export function parseEnterpriseCapabilities(
  raw: unknown,
  options: EnterpriseParseOptions,
): EnterpriseCapabilitySnapshot {
  const now = options.now ?? Date.now();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EnterpriseProjectionError("NOT_AN_OBJECT");
  }
  const body = raw as Record<string, unknown>;
  if (body.schema_version !== "enterprise-capability-v1") {
    throw new EnterpriseProjectionError("UNKNOWN_SCHEMA_VERSION");
  }
  if (body.enterprise_id !== options.enterpriseId) {
    throw new EnterpriseProjectionError("ENTERPRISE_MISMATCH");
  }
  const memberRaw =
    body.member !== null && typeof body.member === "object" && !Array.isArray(body.member)
      ? (body.member as Record<string, unknown>)
      : undefined;
  if (
    memberRaw === undefined ||
    (memberRaw.status !== "active" && memberRaw.status !== "suspended") ||
    (memberRaw.role !== "admin" && memberRaw.role !== "member")
  ) {
    throw new EnterpriseProjectionError("INVALID_MEMBER");
  }
  if (
    body.freshness === null ||
    typeof body.freshness !== "object" ||
    Array.isArray(body.freshness)
  ) {
    throw new EnterpriseProjectionError("MISSING_FRESHNESS");
  }
  const freshness = body.freshness as {
    checked_at?: unknown;
    expires_at?: unknown;
    stale_after?: unknown;
    state?: unknown;
    invalidation?: unknown;
  };
  const checkedAt = parseTime(freshness.checked_at);
  const expiresAt = parseTime(freshness.expires_at);
  const staleAfter = parseTime(freshness.stale_after);
  if (checkedAt === undefined || expiresAt === undefined || staleAfter === undefined) {
    throw new EnterpriseProjectionError("INVALID_FRESHNESS");
  }
  const expires = freshness.state === "fresh" && now < expiresAt && now < staleAfter;

  const modulesSource =
    body.modules !== null && typeof body.modules === "object" && !Array.isArray(body.modules)
      ? (body.modules as Record<string, unknown>)
      : {};
  const modules = {} as Record<EnterpriseModule, EnterpriseModuleAccess>;
  for (const module of ENTERPRISE_MODULES) {
    modules[module] = readModule(
      modulesSource[module],
      module,
      expires ? null : "capability_unverified",
    );
  }

  return {
    enterpriseId: options.enterpriseId,
    member: { status: memberRaw.status, role: memberRaw.role },
    modules,
    checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    staleAfter: new Date(staleAfter).toISOString(),
    trusted:
      expires && checkedAt <= now && memberRaw.status === "active" && memberRaw.role === "admin",
    invalidation: Array.isArray(freshness.invalidation)
      ? freshness.invalidation.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export function enterpriseModuleVisible(
  snapshot: EnterpriseCapabilitySnapshot | undefined,
  module: EnterpriseModule,
): boolean {
  return snapshot !== undefined && snapshot.trusted && snapshot.modules[module].visible;
}

export function enterpriseAccess(
  snapshot: EnterpriseCapabilitySnapshot | undefined,
  module: EnterpriseModule,
): EnterpriseModuleAccess | undefined {
  if (snapshot === undefined || !snapshot.trusted) return undefined;
  return snapshot.modules[module];
}

export function enterpriseActionAllowed(
  snapshot: EnterpriseCapabilitySnapshot | undefined,
  module: EnterpriseModule,
  action: string,
): boolean {
  const access = enterpriseAccess(snapshot, module);
  if (access === undefined || !access.visible) return false;
  return access.actions[action]?.allowed === true;
}

/** A module read is allowed only when the entry and its ceiling agree. */
export function enterpriseModuleHasData(
  snapshot: EnterpriseCapabilitySnapshot | undefined,
  module: EnterpriseModule,
  readAction: string,
): boolean {
  const access = enterpriseAccess(snapshot, module);
  return (
    access !== undefined &&
    access.visible &&
    access.dataCeiling !== "none" &&
    access.actions[readAction]?.allowed === true
  );
}
