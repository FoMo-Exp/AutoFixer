import type { components } from "../api/contracts/schema";
import type { WorkspaceRole } from "../api/identity";

/**
 * Capability projection (DAT-278 contract, consumed by DAT-279).
 *
 * The projection is an advisory snapshot: it decides which module entries and
 * action affordances the workbench draws, never whether a request is allowed.
 * Every response is validated here and fails closed:
 *
 * - an unknown schema version, a mismatched workspace, or an unparseable
 *   freshness window is a contract violation and rejects the snapshot;
 * - an expired or `stale_after`-passed snapshot is not trusted for any action;
 * - an `unverified` / `confirmed_loss` snapshot keeps its navigation entries
 *   (the role may still see the module) but forbids every data action and
 *   reports no data ceiling, even if a malformed response claims otherwise;
 * - an unknown module, action, or data ceiling is treated as absent/denied.
 */

export type WorkspaceCapabilityProjection = components["schemas"]["WorkspaceCapabilityProjection"];
export type CapabilityDataCeiling =
  WorkspaceCapabilityProjection["modules"]["tasks"]["data_ceiling"];

export const CAPABILITY_MODULES = [
  "tasks",
  "issues",
  "memory",
  "rsi",
  "dashboard",
  "members",
  "security",
  "service_integration",
] as const;

export type CapabilityModule = (typeof CAPABILITY_MODULES)[number];

/** Modules whose data is the verified repository capability intersection. */
export const DATA_MODULES: readonly CapabilityModule[] = [
  "tasks",
  "issues",
  "memory",
  "rsi",
  "dashboard",
  "members",
];

export const MODULE_LABELS: Record<CapabilityModule, string> = {
  tasks: "Tasks",
  issues: "Issues",
  memory: "Memory",
  rsi: "RSI",
  dashboard: "Dashboard",
  members: "Members & teams",
  security: "Security",
  service_integration: "Service integration",
};

const DATA_CEILINGS: readonly CapabilityDataCeiling[] = [
  "none",
  "repository",
  "internal",
  "confidential",
  "operational",
  "financial",
  "roster",
  "governance",
  "redacted",
  "audit",
  "metadata",
];

const MODULE_ACTIONS: Record<CapabilityModule, readonly string[]> = {
  tasks: ["view", "stream", "artifacts", "create", "run", "manage", "approve"],
  issues: ["view", "create", "comment", "request_approval", "decide_candidate", "deliver"],
  memory: ["view", "view_confidential", "govern_team", "govern_workspace", "restricted_access"],
  rsi: ["view", "propose", "approve", "evaluate", "replay", "canary", "rollback", "kill_switch"],
  dashboard: ["view", "view_trace", "view_financial", "audit", "export"],
  members: ["view", "manage_members", "manage_teams", "invite", "manage_roles"],
  security: [
    "audit.export",
    "audit.read",
    "case.handle",
    "case.read_redacted_status",
    "case.request_reassignment",
    "case.request_termination",
    "case.review_decide",
    "case.submit_for_review",
    "case.terminate",
    "endpoint.configure",
    "quarantine.grant_access",
    "quarantine.view",
    "recovery.approve",
    "recovery.reconcile",
    "recovery.revoke",
    "role.grant",
    "rule.activate",
    "rule.propose",
    "rule.review",
    "rule.rollback",
  ],
  service_integration: ["view_metadata", "configure"],
};

export type CapabilityState = "verified" | "unverified" | "confirmed_loss";

export interface ActionDecision {
  allowed: boolean;
  required: string;
  reason: string | null;
}

export interface ModuleAccess {
  visible: boolean;
  /** Why the module is visible without data, or hidden. */
  reason: string | null;
  dataCeiling: CapabilityDataCeiling;
  actions: Readonly<Record<string, ActionDecision>>;
}

export interface CapabilitySnapshot {
  workspaceId: string;
  enterpriseId: string;
  assignedRole: WorkspaceRole | null;
  state: CapabilityState;
  capabilities: readonly string[];
  modules: Readonly<Record<CapabilityModule, ModuleAccess>>;
  checkedAt: string;
  expiresAt: string;
  staleAfter: string;
  /** A fresh, schema-valid projection; false means no client-side decision. */
  trusted: boolean;
  /** `unverified` / `confirmed_loss`: data modules show no data. */
  dataBlocked: boolean;
  /** Safe machine reason from the server (`blocked_reason`). */
  blockedReason: string | null;
}

export class CapabilityProjectionError extends Error {
  constructor(readonly code: string) {
    super(`Capability projection rejected: ${code}`);
    this.name = "CapabilityProjectionError";
  }
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function denied(reason: string, required = "unavailable"): ActionDecision {
  return { allowed: false, required, reason };
}

interface RawAction {
  allowed?: unknown;
  required?: unknown;
  reason?: unknown;
}

function readActions(
  raw: unknown,
  module: CapabilityModule,
  forcedDenyReason: string | null,
): Record<string, ActionDecision> {
  const actions: Record<string, ActionDecision> = {};
  // The server keys actions by name; only names the contract closes over are read.
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  for (const name of MODULE_ACTIONS[module]) {
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
  module: CapabilityModule,
  forcedDenyReason: string | null,
  forceNoData: boolean,
): ModuleAccess {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as RawModule) : undefined;
  return {
    visible: source?.visible === true,
    reason: typeof source?.reason === "string" ? source.reason : null,
    dataCeiling:
      typeof source?.data_ceiling === "string" &&
      DATA_CEILINGS.includes(source.data_ceiling as CapabilityDataCeiling) &&
      !forceNoData
        ? (source.data_ceiling as CapabilityDataCeiling)
        : "none",
    actions: readActions(source?.actions, module, forcedDenyReason),
  };
}

export interface ParseOptions {
  /** The workspace whose projection was requested. */
  workspaceId: string;
  /** Milliseconds since epoch; injected so expiry is testable. */
  now?: number;
}

/**
 * Validate and normalize one `GET /workspaces/{id}/capabilities` response.
 * Throws `CapabilityProjectionError` for a response that cannot be trusted at
 * all (wrong version, wrong workspace, unparseable freshness).
 */
export function parseWorkspaceCapabilities(
  raw: unknown,
  options: ParseOptions,
): CapabilitySnapshot {
  const now = options.now ?? Date.now();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CapabilityProjectionError("NOT_AN_OBJECT");
  }
  const body = raw as Record<string, unknown>;
  if (body.schema_version !== "workspace-capability-v2") {
    throw new CapabilityProjectionError("UNKNOWN_SCHEMA_VERSION");
  }
  if (body.workspace_id !== options.workspaceId) {
    throw new CapabilityProjectionError("WORKSPACE_MISMATCH");
  }
  if (body.state !== "verified" && body.state !== "unverified" && body.state !== "confirmed_loss") {
    throw new CapabilityProjectionError("UNKNOWN_STATE");
  }
  if (
    body.freshness === null ||
    typeof body.freshness !== "object" ||
    Array.isArray(body.freshness)
  ) {
    throw new CapabilityProjectionError("MISSING_FRESHNESS");
  }
  const freshness = body.freshness as {
    checked_at?: unknown;
    expires_at?: unknown;
    stale_after?: unknown;
    state?: unknown;
  };
  const checkedAt = parseTime(freshness.checked_at);
  const expiresAt = parseTime(freshness.expires_at);
  const staleAfter = parseTime(freshness.stale_after);
  if (checkedAt === undefined || expiresAt === undefined || staleAfter === undefined) {
    throw new CapabilityProjectionError("INVALID_FRESHNESS");
  }
  const freshnessState = freshness.state;
  const dataBlocked = body.state !== "verified";
  const modulesSource =
    body.modules !== null && typeof body.modules === "object" && !Array.isArray(body.modules)
      ? (body.modules as Record<string, unknown>)
      : {};

  const modules = {} as Record<CapabilityModule, ModuleAccess>;
  for (const module of CAPABILITY_MODULES) {
    const isDataModule = DATA_MODULES.includes(module);
    modules[module] = readModule(
      modulesSource[module],
      module,
      isDataModule && dataBlocked ? "capability_unverified" : null,
      isDataModule && dataBlocked,
    );
  }

  const trusted =
    freshnessState === "fresh" && now < expiresAt && checkedAt <= now && now < staleAfter;

  return {
    workspaceId: options.workspaceId,
    enterpriseId: typeof body.enterprise_id === "string" ? body.enterprise_id : "",
    assignedRole:
      body.assigned_role === "owner" ||
      body.assigned_role === "admin" ||
      body.assigned_role === "member" ||
      body.assigned_role === "viewer"
        ? body.assigned_role
        : null,
    state: body.state,
    capabilities: Array.isArray(body.capabilities)
      ? body.capabilities.filter((entry): entry is string => typeof entry === "string")
      : [],
    modules,
    checkedAt: new Date(checkedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    staleAfter: new Date(staleAfter).toISOString(),
    trusted,
    dataBlocked,
    blockedReason: typeof body.blocked_reason === "string" ? body.blocked_reason : null,
  };
}

/** A module may be entered only when the snapshot is trusted and visible. */
export function moduleVisible(
  snapshot: CapabilitySnapshot | undefined,
  module: CapabilityModule,
): boolean {
  return snapshot !== undefined && snapshot.trusted && snapshot.modules[module].visible;
}

/** An action is available only when the snapshot is trusted and allows it. */
export function actionAllowed(
  snapshot: CapabilitySnapshot | undefined,
  module: CapabilityModule,
  action: string,
): boolean {
  if (snapshot === undefined || !snapshot.trusted) return false;
  const access = snapshot.modules[module];
  if (!access.visible) return false;
  return access.actions[action]?.allowed === true;
}

export function actionReason(
  snapshot: CapabilitySnapshot | undefined,
  module: CapabilityModule,
  action: string,
): string | null {
  return snapshot?.modules[module].actions[action]?.reason ?? null;
}

/** A module entry exists only when it can be entered (visible + readable). */
export function moduleEnterable(
  snapshot: CapabilitySnapshot | undefined,
  module: CapabilityModule,
): boolean {
  if (!moduleVisible(snapshot, module)) return false;
  if (module === "security") {
    return (
      actionAllowed(snapshot, "security", "case.read_redacted_status") ||
      actionAllowed(snapshot, "security", "audit.read") ||
      actionAllowed(snapshot, "security", "rule.propose")
    );
  }
  if (module === "service_integration") {
    return actionAllowed(snapshot, "service_integration", "view_metadata");
  }
  return actionAllowed(snapshot, module, "view");
}

/** Data reads are allowed only when the module entry and its read action agree. */
export function moduleHasData(
  snapshot: CapabilitySnapshot | undefined,
  module: CapabilityModule,
): boolean {
  return (
    moduleEnterable(snapshot, module) &&
    snapshot !== undefined &&
    !snapshot.dataBlocked &&
    snapshot.modules[module].dataCeiling !== "none"
  );
}

/**
 * Operator copy for a hidden module or a denied action. The reason is a safe
 * machine token from the contract; nothing here claims the server would allow
 * the request.
 */
export function capabilityReasonLabel(reason: string | null): string {
  switch (reason) {
    case "workspace_role":
      return "Your workspace role does not allow this.";
    case "workspace_role:viewer":
      return "This module requires more than viewer access.";
    case "workspace_role:member":
      return "This module requires the member role.";
    case "workspace_role:admin":
      return "This action requires the admin role.";
    case "workspace_role:owner":
      return "This action requires the owner role.";
    case "team_leader":
      return "This action requires leading a team in this workspace.";
    case "security_duty":
      return "This module requires an explicit security duty.";
    case "enterprise_admin":
      return "This module requires enterprise administration.";
    case "capability_unverified":
      return "The repository capability set could not be verified, so no workspace data is available.";
    case "data_ceiling_none":
      return "The service reports no verified data ceiling for this module, so no data is read.";
    case "capability_ceiling_changed":
      return "Your capability ceiling changed; the workspace data scope was refreshed.";
    case "authority_unknown":
      return "Provider authority is unknown, so no workspace data is available.";
    case "authority_stale":
      return "Provider authority is stale, so no workspace data is available.";
    case "verification_expired":
      return "Capability verification expired, so no workspace data is available.";
    case "action_policy":
      return "This action is not available through this surface.";
    case "session_revoked":
      return "The session was revoked. Sign in again.";
    case null:
    case undefined:
      return "This capability is not available.";
    default:
      return reason;
  }
}

/**
 * A module action from an already-normalized access object. Callers that have
 * no projection (the local-operator legacy mode) keep their own role gate;
 * everything else must pass the projection.
 */
export function accessAllowed(access: ModuleAccess | undefined, action: string): boolean {
  return access?.actions[action]?.allowed === true;
}

const LEGACY_ACTIONS: ActionDecision = { allowed: true, required: "legacy_operator", reason: null };

/**
 * The local-operator mode (`authMode: legacy`) has no identity subsystem and
 * therefore no capability projection. It keeps the surfaces it had before
 * DAT-279 and the Node service stays the only authorization point; identity
 * deployments never take this path, so an unknown projection always fails
 * closed there.
 */
export function legacyCapabilitySnapshot(): CapabilitySnapshot {
  const modules = {} as Record<CapabilityModule, ModuleAccess>;
  for (const module of CAPABILITY_MODULES) {
    const allowed =
      module !== "members" && module !== "service_integration" && module !== "security";
    const actions: Record<string, ActionDecision> = {};
    for (const name of MODULE_ACTIONS[module]) {
      actions[name] = allowed ? LEGACY_ACTIONS : denied("action_policy");
    }
    modules[module] =
      module === "security"
        ? {
            visible: false,
            reason: "security_duty",
            dataCeiling: "none",
            actions,
          }
        : {
            visible: allowed,
            reason: null,
            dataCeiling:
              module === "memory"
                ? "confidential"
                : module === "dashboard"
                  ? "financial"
                  : "repository",
            actions,
          };
  }
  const farFuture = new Date(Date.now() + 86_400_000).toISOString();
  return {
    workspaceId: "legacy",
    enterpriseId: "",
    assignedRole: null,
    state: "verified",
    capabilities: [],
    modules,
    checkedAt: new Date().toISOString(),
    expiresAt: farFuture,
    staleAfter: farFuture,
    trusted: true,
    dataBlocked: false,
    blockedReason: null,
  };
}
