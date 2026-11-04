import { TASK_EVENT_TYPES, UI_STATUSES } from "./task-store.js";
import {
  PI_SUMMARY_SOURCE_KINDS,
  PI_SUMMARY_SOURCE_VERSION,
  PI_SUMMARY_STATUSES,
  PI_SUMMARY_UNAVAILABLE_REASONS,
} from "./pi-summary.js";
import {
  TURN_REPORT_ACTIVITIES,
  TURN_REPORT_AREAS,
  TURN_REPORT_MAX_ITEMS,
  TURN_REPORT_OUTCOMES,
} from "../pi/turn-report.js";
import { DSH_STATES } from "../dsh/types.js";
import {
  APPROVAL_INVALIDATION_REASONS,
  APPROVAL_STATES,
  DELIVERY_STATES,
  ISSUE_EVENT_TYPES,
  TASK_EVIDENCE_CONTRACT_VERSION,
} from "../collab/contract.js";
import { PRODUCT_STATES } from "../collab/states.js";
import { GRANT_STATES, ROLES, TASK_STATES } from "../collab/types.js";
import {
  ERROR_CATEGORIES,
  ERROR_ENVELOPE_VERSION,
  ERROR_NEXT_ACTIONS,
  ERROR_STAGES,
} from "./errors.js";

type JsonObject = Record<string, unknown>;

/** Loosely-typed OpenAPI 3.1 document; schemas stay plain JSON objects. */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  /** Global security requirement; every operation also carries it explicitly. */
  security: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

const errorSchema: JsonObject = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      description:
        "The shared versioned error envelope (ADR-0008, DAT-226 alignment): " +
        "a stable machine code, the processing stage, the outcome category, a " +
        "safe localizable user message, service-decided retryability, " +
        "retry-after where applicable, the request_id trace/case reference, " +
        "safe-only structured details, and the authorized next action. No " +
        "field ever carries secrets, credentials, invitation tokens, or " +
        "sensitive diagnostics; those stay behind separate access checks.",
      required: [
        "envelope_version",
        "code",
        "stage",
        "category",
        "message",
        "retryable",
        "retry_after_seconds",
        "request_id",
        "details",
        "next_action",
      ],
      properties: {
        envelope_version: {
          type: "integer",
          enum: [ERROR_ENVELOPE_VERSION],
          description:
            "Envelope format version. Evolution within a version is additive " +
            "only; a new version signals a breaking envelope change.",
        },
        code: {
          type: "string",
          description:
            "Stable machine code. Never localized and never re-mapped to a " +
            "different meaning; display text lives in `message`. Unknown codes " +
            "render from `message` plus `next_action`.",
        },
        stage: {
          type: "string",
          enum: [...ERROR_STAGES],
          description: "The processing stage that rejected the request.",
        },
        category: {
          type: "string",
          enum: [...ERROR_CATEGORIES],
          description:
            "Outcome semantics: denial (refused by authority/policy; do not " +
            "retry), stop (fix the request or state; do not retry), retry (a " +
            "retry may succeed within limits), unknown (reconcile before " +
            "further writes). The service, never a model or a client, decides " +
            "retry eligibility; a policy denial is never rewritten as a " +
            "generic server error.",
        },
        message: {
          type: "string",
          description:
            "Safe user-facing guidance. Localizable without changing `code`; " +
            "a trace ID alone is never the only guidance. An unexpected " +
            "INTERNAL_ERROR serves one fixed safe message; its cause stays in " +
            "server-side logs, correlated by `request_id`.",
        },
        retryable: { type: "boolean" },
        retry_after_seconds: {
          type: ["integer", "null"],
          minimum: 0,
          description:
            "Seconds to wait before a retry; non-null when applicable " +
            "(typically 429 and retryable 503), matching the Retry-After " +
            "header where the server sends one.",
        },
        request_id: {
          type: "string",
          description: "Trace/case reference to quote in support and security cases.",
        },
        details: {
          type: "object",
          additionalProperties: true,
          description:
            "Safe structured context only (e.g. a conflicting version, a " +
            "denied capability category). Never secrets, raw provider errors, " +
            "invitation tokens, or sensitive diagnostics.",
        },
        next_action: {
          type: ["string", "null"],
          enum: [...ERROR_NEXT_ACTIONS, null],
          description:
            "The authorized next action, as a machine code. Additive " +
            "vocabulary: a client renders an unknown action as generic " +
            "guidance from `message`. Null when no action applies.",
        },
      },
    },
  },
};

// --- Identity, session, and administration schemas (DAT-202) ---------------

const userSchema: JsonObject = {
  type: "object",
  description:
    "An account, matched across providers only by (provider instance, stable " +
    "subject). `identities` is the linked-provider provenance (DAT-203's " +
    "views serve it); the core projection is served everywhere.",
  required: ["id", "display_name", "status"],
  properties: {
    id: { type: "string" },
    display_name: { type: "string" },
    status: { type: "string", enum: ["active", "suspended"] },
    identities: {
      type: "array",
      items: { $ref: "#/components/schemas/UserIdentity" },
    },
  },
};

const membershipSchema: JsonObject = {
  type: "object",
  description:
    "A workspace membership. Effective access intersects enterprise " +
    "membership, workspace role, current repository access, and action " +
    "policy (ADR-0006); a role here is never sufficient authority on its own. " +
    "The administrator grant response serves the core projection; the " +
    "workspace-admin views (`GET /api/v1/workspaces/{workspace_id}/members`, " +
    "invitation redemption) additionally serve `user`, `authority`, " +
    "`version`, `created_at`, and `updated_at`.",
  required: ["id", "enterprise_id", "workspace_id", "user_id", "role"],
  properties: {
    id: { type: "string" },
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
    user_id: { type: "string" },
    role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
    user: { $ref: "#/components/schemas/UserRef" },
    authority: { $ref: "#/components/schemas/MemberAuthority" },
    version: {
      type: "integer",
      description: "Optimistic-concurrency token for state-changing operations.",
    },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const sessionInfoSchema: JsonObject = {
  type: "object",
  required: ["user", "kind", "csrf_token", "expires_at", "enterprise_roles", "memberships"],
  properties: {
    user: { $ref: "#/components/schemas/User" },
    kind: { type: "string", enum: ["web", "desktop"] },
    csrf_token: {
      type: "string",
      description:
        "Paired with the HttpOnly session cookie: cookie-authenticated " +
        "mutating requests must echo it in the X-CSRF-Token header. It is " +
        "readable by the page on purpose — possession without the cookie " +
        "grants nothing.",
    },
    expires_at: { type: "string", format: "date-time" },
    enterprise_roles: {
      type: "array",
      items: {
        type: "object",
        required: ["enterprise_id", "role"],
        properties: {
          enterprise_id: { type: "string" },
          role: { type: "string", enum: ["admin"] },
        },
      },
    },
    memberships: {
      type: "array",
      items: {
        type: "object",
        required: ["enterprise_id", "workspace_id", "role"],
        properties: {
          enterprise_id: { type: "string" },
          workspace_id: { type: "string" },
          role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
        },
      },
    },
  },
};

const loginProviderSchema: JsonObject = {
  type: "object",
  required: ["provider_instance_id", "provider_type", "display_origin"],
  properties: {
    provider_instance_id: { type: "string" },
    provider_type: { type: "string", enum: ["github", "gitlab"] },
    display_origin: { type: "string", examples: ["https://github.com"] },
  },
};

const providerInstanceSchema: JsonObject = {
  type: "object",
  required: ["id", "enterprise_id", "provider_type", "origin_url", "version"],
  properties: {
    id: { type: "string" },
    enterprise_id: { type: "string" },
    provider_type: { type: "string", enum: ["github", "gitlab"] },
    origin_url: {
      type: "string",
      description:
        "Administrator-approved provider origin. Registration enforces " +
        "HTTPS, no credentials/path/query/fragment, the default port, and a " +
        "public hostname or IP literal that resolves to public addresses " +
        "only — internal-network origins are refused.",
    },
    version: { type: "number" },
  },
};

const desktopFlowSchema: JsonObject = {
  type: "object",
  required: ["flow_id", "secret", "login_url", "expires_at"],
  properties: {
    flow_id: { type: "string" },
    secret: {
      type: "string",
      description:
        "Single-use desktop-held secret, returned exactly once at creation " +
        "and exchanged once for the desktop session. It never appears in a " +
        "URL, log, or audit record.",
    },
    login_url: {
      type: "string",
      description: "Open in the system browser to complete sign-in.",
    },
    expires_at: { type: "string", format: "date-time" },
  },
};

const authAuditRecordSchema: JsonObject = {
  type: "object",
  required: ["id", "at", "event", "actor_kind", "details"],
  properties: {
    id: { type: "string" },
    at: { type: "string", format: "date-time" },
    event: {
      type: "string",
      examples: [
        "login.started",
        "login.completed",
        "login.rejected",
        "session.created",
        "session.revoked",
        "desktop_flow.created",
        "desktop_flow.consumed",
        "user.provisioned",
        "user.suspended",
        "user.activated",
        "membership.granted",
        "membership.revoked",
        "provider_instance.registered",
        "admin.bootstrap",
        "admin.denied",
      ],
    },
    enterprise_id: { type: ["string", "null"] },
    actor_kind: { type: "string", enum: ["user", "deployment", "anonymous"] },
    actor_user_id: { type: ["string", "null"] },
    subject_user_id: { type: ["string", "null"] },
    provider_instance_id: { type: ["string", "null"] },
    details: {
      type: "object",
      additionalProperties: true,
      description: "Secret-free detail; never carries tokens, codes, or states.",
    },
  },
};

const artifactMetadataSchema: JsonObject = {
  type: "object",
  required: ["artifact_id", "available", "digest", "head_sha"],
  properties: {
    artifact_id: { type: "string", examples: ["evidence_bundle", "patch_report"] },
    available: { type: "boolean" },
    digest: { type: ["string", "null"], examples: ["sha256:…"] },
    head_sha: { type: ["string", "null"] },
  },
};

const taskSchema: JsonObject = {
  type: "object",
  required: [
    "id",
    "workspace_id",
    "version",
    "created_at",
    "updated_at",
    "current_run_id",
    "run_history_url",
    "repository",
    "request",
    "association",
    "revision",
    "status",
    "status_reason",
    "risk",
    "progress",
    "pi_summary",
    "governance",
    "artifacts",
  ],
  properties: {
    id: { type: "string" },
    workspace_id: {
      type: "string",
      description:
        "Durable workspace ownership. Always equal to the workspace in the " +
        "scoped path; a task can never be addressed through another " +
        "workspace's route family.",
    },
    version: { type: "integer" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    current_run_id: { type: ["string", "null"] },
    run_history_url: {
      type: "string",
      description:
        "Relative run-history URL on the route family that served the task: " +
        "`/api/v1/tasks/{task_id}/runs` on the legacy family and " +
        "`/api/v1/workspaces/{workspace_id}/tasks/{task_id}/runs` on the " +
        "workspace-scoped family. Following it never crosses into another " +
        "workspace's route family.",
    },
    repository: {
      type: "object",
      required: ["id", "display_name", "base_ref", "base_sha"],
      properties: {
        id: { type: "string" },
        display_name: { type: "string" },
        base_ref: { type: "string" },
        base_sha: { type: "string" },
      },
    },
    request: {
      type: "object",
      required: ["summary", "source_reference"],
      properties: {
        summary: { type: "string" },
        source_reference: { type: ["string", "null"] },
      },
    },
    association: {
      type: "object",
      description:
        "Verifiable task/run/repository/revision binding. run_id and " +
        "head_sha are projected from the authoritative dsh run; task_id, " +
        "repository_id, and base_sha are the creation bindings dsh accepted " +
        "and pinned for the run. Node never invents any of these values.",
      required: ["task_id", "run_id", "repository_id", "base_sha", "head_sha"],
      properties: {
        task_id: { type: "string" },
        run_id: { type: ["string", "null"] },
        repository_id: { type: "string" },
        base_sha: { type: "string" },
        head_sha: { type: ["string", "null"] },
      },
    },
    revision: {
      type: "object",
      required: ["base_sha", "head_sha"],
      properties: {
        base_sha: { type: "string" },
        head_sha: { type: ["string", "null"] },
      },
    },
    status: { type: "string", enum: [...UI_STATUSES] },
    archived: {
      type: "boolean",
      description:
        "Whether the cancelled task is in the archive view; the run status is unchanged.",
    },
    status_reason: { type: ["string", "null"] },
    risk: {
      type: ["object", "null"],
      required: ["class", "decision_code", "requires_human_approval"],
      properties: {
        class: { type: "string", enum: ["low", "elevated", "prohibited"] },
        decision_code: { type: "string" },
        requires_human_approval: { type: "boolean" },
      },
    },
    progress: {
      type: "object",
      required: ["phase", "actions_completed", "actions_total"],
      properties: {
        phase: { type: ["string", "null"] },
        actions_completed: { type: "integer" },
        actions_total: { type: ["integer", "null"] },
      },
    },
    pi_summary: {
      description:
        "Display-safe summary of the latest settled Pi turn for the current " +
        "run (DAT-191). Null until a Pi session exists for the task. The " +
        "raw pi.text_delta stream is never the display source: text is " +
        "exposed only through this fail-closed, Node-judged summary, and only " +
        "with a verifiable source record (DAT-194) — a summary whose source " +
        "cannot be re-proven, including every legacy DAT-191/192 record, is " +
        "served unavailable with text null.",
      oneOf: [{ $ref: "#/components/schemas/PiSummary" }, { type: "null" }],
    },
    governance: {
      type: "object",
      description:
        "GitHub merge-boundary projection for the current head. Approvals " +
        "and checks observed against an older head are invalidated: " +
        "observations_valid turns false and merge_queue_eligible turns false " +
        "until dsh observes them against the current head.",
      required: ["current_head_sha", "observations_valid", "merge_queue_eligible"],
      properties: {
        current_head_sha: { type: ["string", "null"] },
        observations_valid: { type: "boolean" },
        merge_queue_eligible: { type: "boolean" },
      },
    },
    artifacts: {
      type: "object",
      required: ["patch", "report", "evidence_bundle_available", "index"],
      properties: {
        patch: { type: "null" },
        report: { type: "null" },
        evidence_bundle_available: { type: "boolean" },
        index: {
          type: "array",
          items: { $ref: "#/components/schemas/ArtifactMetadata" },
        },
      },
    },
  },
};

const taskEventSchema: JsonObject = {
  type: "object",
  required: ["event_id", "sequence", "occurred_at", "task_id", "task_version", "type", "data"],
  properties: {
    event_id: { type: "string" },
    sequence: { type: "integer" },
    occurred_at: { type: "string", format: "date-time" },
    task_id: { type: "string" },
    task_version: { type: "integer" },
    type: {
      type: "string",
      enum: [...TASK_EVENT_TYPES],
    },
    data: { type: "object", additionalProperties: true },
  },
};

const runSummarySchema: JsonObject = {
  type: "object",
  required: ["run_id", "state", "created_at"],
  properties: {
    run_id: { type: "string" },
    state: { type: "string", enum: [...DSH_STATES] },
    created_at: { type: "string", format: "date-time" },
  },
};

const piSummarySchema: JsonObject = {
  type: "object",
  description:
    "A display-safe natural-language summary of the latest settled Pi turn " +
    "for one task run (DAT-191, classification boundary DAT-192, trust " +
    "boundary DAT-193, verifiable provenance DAT-194). Displayability comes " +
    "from provenance, not text inspection: text is exposed only when it comes " +
    "from an auditable trusted source whose composition is reviewable in the " +
    "orchestrator, and free model output never has one — no rule table can " +
    "prove that arbitrary free text contains no command — so a settled model " +
    "turn is withheld in full. The Node-side fail-closed classifier still " +
    "names why material is kept out: credentials, shell syntax, absolute " +
    "workspace paths, command invocations, argument material, unredacted " +
    "logs, and opaque high-entropy strings fail closed as unsafe_content; " +
    "an execution report or a sentence/line opener it cannot recognise as " +
    "narrative prose (capitalisation confers no exemption; every line " +
    "start is judged) fails closed as undecidable; a turn no rule flags is " +
    "withheld as untrusted_source — a pass of the rule table is a " +
    "classification, not a certification. Fail closed: an unavailable " +
    "summary always carries text=null, never redacted or partial content. " +
    "The one available path (DAT-193) is the turn's validated structured " +
    "Pi report: closed-enum parameters on the report_turn_summary tool, " +
    "server-side validation, and fixed wording composed by Node and framed " +
    "as Pi's own report — never free model text, never run status or " +
    "activity counts, and no additional model, network, or permission. A " +
    "missing, unknown, or invalid report fails closed exactly like a turn " +
    "with no report. " +
    "Provenance (DAT-194): `source` is the machine-checkable record behind " +
    "that claim — closed channel, proof-format version, task/run/turn " +
    "attribution, and the echoed structured report — non-null exactly when " +
    "status is available. The server re-proves every served available " +
    "summary from it and withholds anything it cannot prove: a missing or " +
    "unknown source, an unknown version, attribution to a different " +
    "task/run/turn, tampered text, or a damaged record all serve as " +
    "unavailable/untrusted_source with text null. Nothing is inferred from " +
    "the text's shape, a timestamp, or the service's current version; no " +
    "persisted record or recorded event is rewritten, so legacy " +
    "DAT-191/192 free-text summaries keep their history but are never " +
    "served as displayable. " +
    "Lifecycle: null on the task until a Pi " +
    "session exists; pending from " +
    "session start (and at the start of every run) until a turn settles; " +
    "then exactly one available/unavailable per settled turn, each replacing " +
    "the previous summary — a turn settles (and publishes) exactly once, " +
    "including the duplicated agent_error/agent_settled emission of a " +
    "provider failure. A terminal task whose last turn never settled keeps " +
    "status pending with text null; no summary is fabricated after the " +
    "terminal frame. A pi.summary.updated event carries the same " +
    "object on the SSE stream and in the timeline, replayable by " +
    "Last-Event-ID like every other event, and passes the same provenance " +
    "gate, so projection and events always agree.",
  required: [
    "task_id",
    "run_id",
    "turn_id",
    "status",
    "text",
    "unavailable_reason",
    "source",
    "updated_at",
  ],
  properties: {
    task_id: { type: "string" },
    run_id: {
      type: ["string", "null"],
      description: "The run whose Pi session produced this summary.",
    },
    turn_id: {
      type: ["string", "null"],
      description: "The Pi turn this summary describes; null while pending.",
    },
    status: { type: "string", enum: [...PI_SUMMARY_STATUSES] },
    text: {
      type: ["string", "null"],
      maxLength: 240,
      description:
        "The fixed-wording rendering of the turn's validated structured Pi " +
        "report (DAT-193), framed as Pi's own report; non-null iff status is " +
        "available. Never free model text. Bound to 240 characters.",
    },
    unavailable_reason: {
      type: ["string", "null"],
      enum: [...PI_SUMMARY_UNAVAILABLE_REASONS, null],
      description:
        "Why no text is exposed: no_content (the settled turn produced no " +
        "displayable text), unsafe_content (identified unsafe material), " +
        "undecidable (the classifier could not recognise the turn: an " +
        "execution report or an unrecognised sentence opener), gate_error " +
        "(the classifier itself failed), untrusted_source (no rule flagged " +
        "the content, but it has no auditable trusted source: free model " +
        "text, a structured report that failed server-side validation, or a " +
        "recorded summary whose source cannot be re-proven on read — " +
        "legacy, missing, forged, or unknown-version provenance). " +
        "Null unless status is unavailable. " +
        "The enum is additive: clients render an unknown reason — and an " +
        "unknown status — as a plain unavailable state. " +
        "A legacy available summary is served this way after the DAT-194 " +
        "gate downgrades it, so an old client that renders on status and " +
        "text alone stops displaying historical free text without " +
        "understanding the source field.",
    },
    source: {
      description:
        "Verifiable provenance of `text`; non-null iff status is available. " +
        "Null for pending and unavailable summaries, and for any summary " +
        "whose source the server cannot re-proven (which is then served " +
        "unavailable with text null instead of exposing an unproven source).",
      oneOf: [{ $ref: "#/components/schemas/PiSummarySource" }, { type: "null" }],
    },
    updated_at: { type: "string", format: "date-time" },
  },
};

const piSummarySourceSchema: JsonObject = {
  type: "object",
  description:
    "Verifiable provenance of a displayable summary's text (DAT-194). " +
    "Non-null exactly when the summary is available. The trust chain it " +
    "states: `kind` is the closed provenance channel (only `turn_report` — " +
    "the model's closed-enum report_turn_summary tool, validated by the " +
    "server and fixed-rendered by the server), `version` versions the proof " +
    "format and rendering vocabulary (carried by the record; an unknown " +
    "version is unverifiable), task_id/run_id/turn_id bind the proof to the " +
    "task, run, and turn the summary describes, and `report` echoes the " +
    "validated closed-enum report the text was rendered from. The server " +
    "re-proves every served available summary from this record — valid " +
    "report, re-rendered wording equal to the stored text, identical " +
    "attribution, known kind and version — and serves anything it cannot " +
    "prove as unavailable/untrusted_source with text null. Legacy " +
    "DAT-191/192 summaries carry no source and are therefore never served " +
    "as displayable. A client MAY corroborate these fields (enums, " +
    "attribution, version); that check is not the safety boundary.",
  required: ["kind", "version", "task_id", "run_id", "turn_id", "report"],
  properties: {
    kind: {
      type: "string",
      enum: [...PI_SUMMARY_SOURCE_KINDS],
      description:
        "The provenance channel. Closed set: any other kind is not a " +
        "trusted source and fails closed.",
    },
    version: {
      type: "integer",
      enum: [PI_SUMMARY_SOURCE_VERSION],
      description:
        "Version of the source proof format and its rendering vocabulary. " +
        "This contract defines 1; a client MUST treat an unknown version as " +
        "unverifiable, and the server serves such summaries as unavailable.",
    },
    task_id: { type: "string", description: "Task the proof is bound to." },
    run_id: {
      type: ["string", "null"],
      description: "Run the proof is bound to; must equal the summary's run_id.",
    },
    turn_id: {
      type: "string",
      description: "Pi turn the proof is bound to; must equal the summary's turn_id.",
    },
    report: {
      $ref: "#/components/schemas/TurnReport",
    },
  },
};

const turnReportSchema: JsonObject = {
  type: "object",
  description:
    "One validated structured Pi turn report: the closed-enum parameters of " +
    "the report_turn_summary tool (DAT-193). Every parameter is a key from a " +
    "closed vocabulary — there is no free-text field — and the server " +
    "validates membership and cardinality before recording it. Summary text " +
    "is fixed-rendered from exactly this structure.",
  required: ["areas", "activities", "outcome"],
  properties: {
    areas: {
      type: "array",
      minItems: 1,
      maxItems: TURN_REPORT_MAX_ITEMS,
      items: { type: "string", enum: [...TURN_REPORT_AREAS] },
    },
    activities: {
      type: "array",
      minItems: 1,
      maxItems: TURN_REPORT_MAX_ITEMS,
      items: { type: "string", enum: [...TURN_REPORT_ACTIVITIES] },
    },
    outcome: { type: "string", enum: [...TURN_REPORT_OUTCOMES] },
  },
};

/**
 * Workspace roles (ADR-0006), assigned only within the actor's authority.
 * Enterprise administration never grants repository data access by itself.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;

/**
 * Normalized provider-role provenance (ADR-0006): organization owners, groups,
 * inherited roles, and direct collaborators are named explicitly and an
 * authority that belongs to an organization is never invented as a repository
 * "owner" user. `unknown` fails closed.
 */
export const MEMBER_PROVENANCES = [
  "organization_owner",
  "group",
  "inherited_role",
  "direct_collaborator",
  "unknown",
] as const;

const userIdentitySchema: JsonObject = {
  type: "object",
  description:
    "A linked provider identity. Identity is bound by provider instance and " +
    "stable subject ID — never by email address or blame author name (ADR-0006).",
  required: ["provider_instance_id", "provider_type", "subject_id"],
  properties: {
    provider_instance_id: { type: "string" },
    provider_type: { type: "string", enum: ["github", "gitlab"] },
    subject_id: {
      type: "string",
      description: "Stable provider subject ID (e.g. the numeric GitHub account ID).",
    },
  },
};

const userRefSchema: JsonObject = {
  type: "object",
  required: ["id", "display_name"],
  properties: { id: { type: "string" }, display_name: { type: "string" } },
};

const enterpriseRefSchema: JsonObject = {
  type: "object",
  description:
    "The enterprise that owns the surrounding scope. Enterprises are " +
    "represented explicitly even when a deployment serves exactly one.",
  required: ["id", "name", "slug"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
  },
};

const workspaceRepositorySchema: JsonObject = {
  type: "object",
  description:
    "The workspace's provider repository binding: the provider instance and " +
    "the immutable provider-assigned repository ID — never a mutable URL. " +
    "Renames change metadata only; a transfer replaces this binding through " +
    "the dedicated, authority-revalidated transfer operation.",
  required: ["repository_id", "provider_instance_id", "provider_type"],
  properties: {
    repository_id: { type: "string", examples: ["123456789"] },
    provider_instance_id: { type: "string" },
    provider_type: { type: "string", enum: ["github", "gitlab"] },
  },
};

const workspaceSchema: JsonObject = {
  type: "object",
  description:
    "One workspace binds exactly one provider repository within one " +
    "enterprise (ADR-0006). Within an enterprise an active workspace per " +
    "repository is enforced transactionally.",
  required: [
    "id",
    "enterprise_id",
    "name",
    "status",
    "repository",
    "role",
    "version",
    "created_at",
    "updated_at",
  ],
  properties: {
    id: { type: "string" },
    enterprise_id: { type: "string" },
    name: { type: "string" },
    status: { type: "string", enum: ["active", "archived"] },
    repository: { $ref: "#/components/schemas/WorkspaceRepository" },
    role: {
      type: "string",
      enum: [...WORKSPACE_ROLES],
      description:
        "The caller's effective workspace role, computed server-side from " +
        "authenticated membership. A projection for display only — never an " +
        "input, never authoritative from the client.",
    },
    version: {
      type: "integer",
      description: "Optimistic-concurrency token for state-changing operations.",
    },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const workspaceRefSchema: JsonObject = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "string" }, name: { type: "string" } },
};

const memberAuthoritySchema: JsonObject = {
  type: "object",
  description:
    "Provenance of the member's effective provider role (ADR-0006): how the " +
    "provider conferred authority, when it was last verified, and whether it " +
    "is stale. Missing or unverifiable provenance is `unknown`, never " +
    "invented; stale or unknown authority blocks sensitive actions pending " +
    "reconciliation (DAT-203).",
  required: ["provider_role", "provenance", "verified_at", "stale"],
  properties: {
    provider_role: {
      type: ["string", "null"],
      description:
        "Normalized effective provider role label as reported by the " +
        "provider adapter; null until verified.",
    },
    provenance: { type: "string", enum: [...MEMBER_PROVENANCES] },
    verified_at: { type: ["string", "null"], format: "date-time" },
    stale: {
      type: "boolean",
      description:
        "True when provider authority changed or went unverified and " +
        "reconciliation has not confirmed it.",
    },
  },
};

const memberCandidateSchema: JsonObject = {
  type: "object",
  description:
    "A provider-roster candidate for workspace membership (DAT-203): the " +
    "eligibility view an owner/admin selects joins from. Roster completeness " +
    "is fail-closed — incomplete rosters are an error, never an empty list.",
  required: [
    "user",
    "provider_role",
    "provenance",
    "already_member",
    "eligible",
    "ineligible_reason",
  ],
  properties: {
    user: {
      type: "object",
      required: ["display_name", "identities"],
      properties: {
        display_name: { type: "string" },
        identities: { type: "array", items: { $ref: "#/components/schemas/UserIdentity" } },
      },
    },
    provider_role: { type: ["string", "null"] },
    provenance: { type: "string", enum: [...MEMBER_PROVENANCES] },
    already_member: { type: "boolean" },
    eligible: { type: "boolean" },
    ineligible_reason: {
      type: ["string", "null"],
      description:
        "Machine code naming why the candidate cannot be imported (e.g. " +
        "`stale_authority`, `no_repository_access`); null when eligible. " +
        "Additive vocabulary.",
    },
  },
};

const teamSchema: JsonObject = {
  type: "object",
  description:
    "A workspace team (ADR-0006). Teams are a routing signal, never an " +
    "authorization source: team leadership or membership grants no " +
    "repository access, security privilege, or delivery approval. Leaders " +
    "must be active workspace members.",
  required: [
    "id",
    "workspace_id",
    "name",
    "leader_user_id",
    "leader",
    "responsibility",
    "version",
    "created_at",
    "updated_at",
  ],
  properties: {
    id: { type: "string" },
    workspace_id: { type: "string" },
    name: { type: "string" },
    leader_user_id: { type: "string" },
    leader: { $ref: "#/components/schemas/UserRef" },
    responsibility: {
      type: ["string", "null"],
      description: "Responsibility description or path mapping; null when unset.",
    },
    version: { type: "integer" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const invitationSchema: JsonObject = {
  type: "object",
  description:
    "An owner-created invitation (ADR-0006). The bearer token is returned " +
    "exactly once, by the create response only; every other view is " +
    "token-free. An invitation grants nothing by itself: redemption adds a " +
    "member-role membership only after login, explicit join confirmation, " +
    "and live eligibility checks.",
  required: [
    "id",
    "workspace_id",
    "role",
    "expires_at",
    "bound_provider_subject",
    "status",
    "created_by",
    "created_at",
    "revoked_at",
    "redeemed_at",
    "version",
  ],
  properties: {
    id: { type: "string" },
    workspace_id: { type: "string" },
    role: {
      type: "string",
      enum: ["member"],
      description:
        "Invitations grant `member` only; administrative role elevation is a " +
        "separate audited action after joining (ADR-0006).",
    },
    expires_at: { type: "string", format: "date-time" },
    bound_provider_subject: {
      type: ["string", "null"],
      description:
        "When set, only this verified provider subject may redeem the " +
        "invitation; forwarded or wrong-subject use stays denied.",
    },
    status: {
      type: "string",
      enum: ["active", "consumed", "revoked", "expired"],
      description: "Server-computed state of this one-time invitation.",
    },
    created_by: { $ref: "#/components/schemas/UserRef" },
    created_at: { type: "string", format: "date-time" },
    revoked_at: { type: ["string", "null"], format: "date-time" },
    redeemed_at: { type: ["string", "null"], format: "date-time" },
    version: { type: "integer" },
  },
};

const createdInvitationSchema: JsonObject = {
  type: "object",
  description: "The create response is the only place the bearer token ever appears.",
  required: ["invitation", "token", "invite_url"],
  properties: {
    invitation: { $ref: "#/components/schemas/Invitation" },
    token: {
      type: "string",
      description:
        "The opaque bearer invitation: at least 128 bits of random entropy, " +
        "URL-safe, stored server-side only as a keyed digest. Shown exactly " +
        "once, in this response only — never in any later read, telemetry, " +
        "referrer, error message, log, analytics export, or third-party " +
        "asset. Both presentations convey this same value: the grouped " +
        "copyable code is only a display formatting of it, and the QR encodes " +
        "`invite_url`.",
    },
    invite_url: {
      type: "string",
      description:
        "Trusted-service invitation landing URL carrying the bearer in the " +
        "URL fragment (`…#<token>`), never in the query. The landing page " +
        "never consumes the token on GET — link previews and security " +
        "scanners learn nothing — clears the fragment from browser history " +
        "after capture, and submits the token only in an authenticated " +
        "confirmation POST body (ADR-0006).",
    },
  },
};

const invitationPreviewSchema: JsonObject = {
  type: "object",
  description:
    "What the join-confirmation screen renders before the explicit join. " +
    "Every non-consumable state fails exactly like redemption: one " +
    "non-enumerating INVITATION_NOT_ACCEPTED.",
  required: ["workspace", "enterprise", "role", "expires_at", "inviter", "already_joined"],
  properties: {
    workspace: { $ref: "#/components/schemas/WorkspaceRef" },
    enterprise: { $ref: "#/components/schemas/EnterpriseRef" },
    role: { type: "string", enum: ["member"] },
    expires_at: { type: "string", format: "date-time" },
    inviter: { $ref: "#/components/schemas/UserRef" },
    already_joined: {
      type: "boolean",
      description:
        "True when the caller already redeemed this invitation; redemption " +
        "is then an idempotent replay of their own join, never a second join.",
    },
  },
};

const invitationRedemptionSchema: JsonObject = {
  type: "object",
  required: ["workspace", "membership"],
  properties: {
    workspace: { $ref: "#/components/schemas/Workspace" },
    membership: { $ref: "#/components/schemas/Membership" },
  },
};

// --- Collaboration v1 schemas (DAT-221, ADR-0007) --------------------------
//
// The issue/task/run/candidate/approval/delivery surface. Product stages and
// harness run states are separate vocabularies: an issue's `product_state`
// describes the product lifecycle, while a run's `state` is the observed
// dsh/FP-01 harness state. `awaiting_change_approval` is a product stage with
// an immutable candidate and no PR; harness `awaiting_review` exists only once
// a provider PR exists. The contract never lets one stand in for the other.

const workspaceScopeSchema: JsonObject = {
  type: "object",
  description:
    "The enterprise/workspace pair that owns an issue and everything derived " +
    "from it (ADR-0006). Resolved server-side from the caller's authenticated " +
    "membership; it is never accepted from a request body.",
  required: ["enterprise_id", "workspace_id"],
  properties: {
    enterprise_id: { type: "string" },
    workspace_id: { type: "string" },
  },
};

const issueRepositorySchema: JsonObject = {
  type: "object",
  description:
    "Immutable repository identity an issue, its runs, candidates, and " +
    "deliveries are bound to (ADR-0006 binds an id, not a mutable URL).",
  required: ["repository_id", "url", "base_ref", "base_sha"],
  properties: {
    repository_id: { type: "string" },
    url: { type: "string" },
    base_ref: { type: "string" },
    base_sha: { type: "string" },
  },
};

const digestSchema: JsonObject = {
  type: "object",
  description:
    "A digest value with the algorithm that produced it; an unverifiable or " +
    "algorithm-less digest is never a valid evidence reference.",
  required: ["algorithm", "value"],
  properties: { algorithm: { type: "string" }, value: { type: "string" } },
};

const artifactReferenceSchema: JsonObject = {
  type: "object",
  description:
    "Immutable artifact reference (ADR-0007: handoffs carry artifact " +
    "references and head identity, never raw memory). The digest binds the " +
    "reference to exactly one artifact content; `base_sha`/`head_sha` bind it " +
    "to the revision it was produced from.",
  required: ["artifact_id", "kind", "digest_algorithm", "digest", "base_sha", "head_sha"],
  properties: {
    artifact_id: { type: "string" },
    kind: { type: "string", examples: ["candidate", "patch", "report", "evidence_bundle"] },
    digest_algorithm: { type: "string" },
    digest: { type: "string" },
    base_sha: { type: "string" },
    head_sha: { type: ["string", "null"] },
  },
};

const issueSchema: JsonObject = {
  type: "object",
  description:
    "A product issue (ADR-0007): the durable aggregate the workspace triages, " +
    "plans, implements, validates, approves, and delivers. `product_state` is " +
    "the product lifecycle stage — never a harness run state — and terminal " +
    "stages (`completed`, `cancelled`) have no outgoing edge. `completed` " +
    "requires a provider-confirmed merge; a published PR alone is not " +
    "completion. `needs_human` records a stop reason awaiting human " +
    "disposition, with other `needs_human` exits requiring that disposition.",
  required: [
    "issue_id",
    "workspace",
    "repository",
    "dedupe_key",
    "summary",
    "source_reference",
    "product_state",
    "state_reason",
    "created_at",
    "updated_at",
  ],
  properties: {
    issue_id: { type: "string" },
    workspace: { $ref: "#/components/schemas/WorkspaceScope" },
    repository: { $ref: "#/components/schemas/IssueRepository" },
    dedupe_key: {
      type: "string",
      description:
        "Service-derived fingerprint (versioned for log signals) that binds a " +
        "repeated alert to one issue instead of spawning unbounded tasks; a " +
        "repeat updates the existing issue's evidence.",
    },
    summary: { type: "string" },
    source_reference: {
      type: ["string", "null"],
      description: "Immutable originating signal or manual submission reference.",
    },
    product_state: { type: "string", enum: [...PRODUCT_STATES] },
    state_reason: {
      type: ["string", "null"],
      description:
        "Recorded reason for the current product stage; always set for a " +
        "`needs_human` stop and for an explicit cancellation.",
    },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const issueStageSchema: JsonObject = {
  type: "object",
  description:
    "The issue's product lifecycle stage and the stages it may move to next, " +
    "derived from the ADR-0007 stage table. A transition is refused when the " +
    "edge does not exist (409 TRANSITION_FORBIDDEN) or when the target stage " +
    "is inconsistent with the observed harness states of the issue's runs " +
    "(409 PRODUCT_HARNESS_CONFLICT). Leaving `needs_human` without a recorded " +
    "human disposition is 428 DISPOSITION_REQUIRED.",
  required: ["issue_id", "product_state", "state_reason", "allowed_transitions", "updated_at"],
  properties: {
    issue_id: { type: "string" },
    product_state: { type: "string", enum: [...PRODUCT_STATES] },
    state_reason: { type: ["string", "null"] },
    allowed_transitions: {
      type: "array",
      items: { type: "string", enum: [...PRODUCT_STATES] },
      description: "Exact outgoing edges of the current stage; empty for terminal stages.",
    },
    updated_at: { type: "string", format: "date-time" },
  },
};

const issueTaskSchema: JsonObject = {
  type: "object",
  description:
    "A child task of an issue: one bounded unit of work routed to a specific " +
    "Pi role (ADR-0007), never an implicitly distributed squad. `depends_on` " +
    "names tasks that must reach `done` first; a blocked dependency is 409 " +
    "TASK_BLOCKED and an invalid dependency graph is 409 " +
    "TASK_DEPENDENCY_INVALID.",
  required: [
    "task_id",
    "issue_id",
    "role",
    "assignee_agent_id",
    "depends_on",
    "state",
    "created_at",
    "updated_at",
  ],
  properties: {
    task_id: { type: "string" },
    issue_id: { type: "string" },
    role: { type: "string", enum: [...ROLES] },
    assignee_agent_id: { type: ["string", "null"] },
    depends_on: { type: "array", items: { type: "string" } },
    state: { type: "string", enum: [...TASK_STATES] },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const runWorktreeSchema: JsonObject = {
  type: "object",
  description:
    "One run's isolated checkout. Different runs use separate worktrees; one " +
    "worktree identity is never bound to two concurrent runs.",
  required: ["worktree_id", "path"],
  properties: { worktree_id: { type: "string" }, path: { type: "string" } },
};

const runScopeSchema: JsonObject = {
  type: "object",
  description:
    "Tool, path, and network scope recorded for one bounded run. Missing " +
    "scope means denied: the scope narrows what dsh may grant, never widens it.",
  required: ["tools", "paths", "network"],
  properties: {
    tools: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: { type: "string" } },
    network: { type: "array", items: { type: "string" } },
  },
};

const runLimitsSchema: JsonObject = {
  type: "object",
  description: "Duration, resource, and token limits recorded for one bounded run.",
  required: ["max_wall_clock_seconds", "max_memory_mb", "max_tokens"],
  properties: {
    max_wall_clock_seconds: { type: "integer" },
    max_memory_mb: { type: "integer" },
    max_tokens: { type: "integer" },
  },
};

const runLeaseSchema: JsonObject = {
  type: "object",
  description:
    "Lease with a monotonic fencing token. Only the current holder of the " +
    "current fencing token may mutate the run; a token is never reused, so a " +
    "worker that lost its lease (expiry, crash, restart) can never overwrite " +
    "a newer writer.",
  required: ["holder", "fencing_token", "acquired_at", "expires_at"],
  properties: {
    holder: { type: "string" },
    fencing_token: { type: "integer" },
    acquired_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
  },
};

const runGrantSchema: JsonObject = {
  type: "object",
  description:
    "Capability grant recorded for one run (task-evidence-contract-v1 §2). " +
    "The recorded grant mirrors what dsh issued and grants nothing by itself — " +
    "dsh re-checks every operation. `state` is the effective state at read " +
    "time: revocation is recorded and permanent, expiry is derived from the " +
    "clock, and a stopped or terminal run's grants are revoked.",
  required: [
    "grant_id",
    "run_id",
    "state",
    "capability_grant_version",
    "policy_version",
    "issued_at",
    "expires_at",
    "may_create_patch",
    "may_create_or_update_pr",
    "scope_digest",
    "revoked_at",
    "revoked_reason",
  ],
  properties: {
    grant_id: { type: "string" },
    run_id: { type: "string" },
    state: { type: "string", enum: [...GRANT_STATES] },
    capability_grant_version: { type: "string" },
    policy_version: { type: "string" },
    issued_at: { type: "string", format: "date-time" },
    expires_at: { type: "string", format: "date-time" },
    may_create_patch: { type: "boolean" },
    may_create_or_update_pr: {
      type: "boolean",
      description:
        "Whether this grant permits PR creation; PR capability never includes " +
        "merge, self-review, or check waiver, and delivery still requires a " +
        "current candidate-bound human approval.",
    },
    scope_digest: { type: "string" },
    revoked_at: { type: ["string", "null"] },
    revoked_reason: { type: ["string", "null"] },
  },
};

const issueRunSchema: JsonObject = {
  type: "object",
  description:
    "One bounded remediation run: isolated checkout, scope, limits, capability " +
    "grants, lease, and the observed harness (FP-01) state. `state` is the " +
    "harness state dsh reported and is never invented here. A `stopped` run " +
    "requires human disposition and never resumes: it may become `cancelled`, " +
    "or a new grant may move it to `approved` — stopped-to-running does not " +
    "exist. `timed_out`, `expired`, `rejected`, `cancelled`, and `merged` are " +
    "terminal for the grant; a later attempt is a new run id beginning in " +
    "`requested`.",
  required: [
    "run_id",
    "issue_id",
    "task_id",
    "role",
    "workspace",
    "repository",
    "worktree",
    "scope",
    "limits",
    "state",
    "head_sha",
    "stop_reason",
    "stopped_at",
    "lease",
    "grants",
    "artifact_refs",
    "opened_at",
    "updated_at",
  ],
  properties: {
    run_id: { type: "string" },
    issue_id: { type: "string" },
    task_id: { type: ["string", "null"] },
    role: { type: "string", enum: [...ROLES] },
    workspace: { $ref: "#/components/schemas/WorkspaceScope" },
    repository: { $ref: "#/components/schemas/IssueRepository" },
    worktree: { $ref: "#/components/schemas/RunWorktree" },
    scope: { $ref: "#/components/schemas/RunScope" },
    limits: { $ref: "#/components/schemas/RunLimits" },
    state: { type: "string", enum: [...DSH_STATES] },
    head_sha: {
      type: ["string", "null"],
      description: "Candidate head identity produced by the run so far; null until one exists.",
    },
    stop_reason: {
      type: ["string", "null"],
      description:
        "Why the run stopped (validation failure, policy/security stop, " +
        "resource violation, …). A stop is an outcome, not a retry: " +
        "continuation needs human disposition and a fresh run/grant.",
    },
    stopped_at: { type: ["string", "null"], format: "date-time" },
    lease: {
      oneOf: [{ $ref: "#/components/schemas/RunLease" }, { type: "null" }],
    },
    grants: { type: "array", items: { $ref: "#/components/schemas/RunGrant" } },
    artifact_refs: {
      type: "array",
      items: { $ref: "#/components/schemas/ArtifactReference" },
    },
    opened_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const validationResultSchema: JsonObject = {
  type: "object",
  description:
    "One validation attempt against the exact candidate revision: the tool " +
    "invoked, its redacted exit status, the digest of its redacted output, and " +
    "the matching append-only event reference.",
  required: ["tool", "exit_status", "output_digest", "event_reference"],
  properties: {
    tool: { type: "string" },
    exit_status: { type: ["integer", "null"] },
    output_digest: {
      oneOf: [{ $ref: "#/components/schemas/Digest" }, { type: "null" }],
    },
    event_reference: { type: "string" },
  },
};

const changeRiskSchema: JsonObject = {
  type: "object",
  description:
    "The pre-approval risk decision for the candidate's work. `prohibited` is " +
    "never downgraded in the same run; an `elevated` assessment requires the " +
    "recorded pre-grant human approval reference.",
  required: ["class", "decision_code", "requires_human_approval"],
  properties: {
    class: { type: "string", enum: ["low", "elevated", "prohibited"] },
    decision_code: { type: "string" },
    requires_human_approval: { type: "boolean" },
  },
};

const candidateSchema: JsonObject = {
  type: "object",
  description:
    "An immutable frozen candidate (ADR-0007): the exact patch, revision " +
    "identity, diff digest, changed paths, validation configuration/" +
    "environment identity, test results, risk, and provenance a human reviews " +
    "before any remote branch push or PR. Local preparation stops and the " +
    "preparation run's grant is revoked while the candidate is preserved " +
    "outside the ephemeral workspace. Nothing may be added or edited after " +
    "validation, and no approval or delivery applies to any other revision. " +
    "The review card shows `summary` and expands to the authorized diff " +
    "(`diff`, artifacts), tests (`validation`), risks (`risk`), and provenance " +
    "(`artifacts`, `audit_refs`).",
  required: [
    "contract_version",
    "candidate_id",
    "issue_id",
    "run_id",
    "repository",
    "base_sha",
    "head_sha",
    "tree_sha",
    "diff",
    "summary",
    "validation",
    "risk",
    "artifacts",
    "audit_refs",
    "created_at",
  ],
  properties: {
    contract_version: { type: "string", enum: [TASK_EVIDENCE_CONTRACT_VERSION] },
    candidate_id: { type: "string" },
    issue_id: { type: "string" },
    run_id: { type: "string", description: "The preparation run that produced the candidate." },
    repository: { $ref: "#/components/schemas/IssueRepository" },
    base_sha: { type: "string" },
    head_sha: { type: "string", description: "Candidate commit identity (the frozen revision)." },
    tree_sha: { type: "string" },
    diff: {
      type: "object",
      description: "Digest and shape of the exact diff an approver reviews.",
      required: ["digest_algorithm", "digest", "changed_paths", "insertions", "deletions"],
      properties: {
        digest_algorithm: { type: "string" },
        digest: { type: "string" },
        changed_paths: { type: "array", items: { type: "string" } },
        insertions: { type: "integer" },
        deletions: { type: "integer" },
      },
    },
    summary: { type: "string", description: "Bounded change summary for the review card." },
    validation: {
      type: "object",
      description:
        "The validation evidence the approval is bound to: configuration " +
        "digest, environment identity, and every validation attempt.",
      required: ["config_digest", "environment", "results"],
      properties: {
        config_digest: { type: "string" },
        environment: { type: "string" },
        required_checks: {
          type: "array",
          items: { type: "string" },
          description:
            "Validation identities the approved test plan requires. A candidate " +
            "freezes only when every required check has a recorded passing " +
            "attempt against its exact revision; a failed or unexecuted required " +
            "check stops the run instead of producing a review card.",
        },
        results: {
          type: "array",
          items: { $ref: "#/components/schemas/ValidationResult" },
        },
      },
    },
    risk: { $ref: "#/components/schemas/ChangeRisk" },
    artifacts: {
      type: "array",
      items: { $ref: "#/components/schemas/ArtifactReference" },
      description: "Patch, report, and evidence-bundle references, retained after cleanup.",
    },
    audit_refs: {
      type: "array",
      items: { type: "string" },
      description: "References into the append-only audit/evidence records backing the candidate.",
    },
    created_at: { type: "string", format: "date-time" },
    invalidated_at: {
      type: ["string", "null"],
      format: "date-time",
      description:
        "When the candidate stopped being valid for delivery (base advancement, " +
        "test-evidence, target, policy, or authority change). An invalidated " +
        "candidate never authorizes delivery; a new revision needs a new run and " +
        "a new candidate. Absent on records that predate this field and never " +
        "invalidated.",
    },
    invalidated_reason: {
      type: ["string", "null"],
      enum: [...APPROVAL_INVALIDATION_REASONS, null],
      description: "Why the candidate was invalidated; always paired with `invalidated_at`.",
    },
  },
};

const approvalBindingSchema: JsonObject = {
  type: "object",
  description:
    "Everything one approval is bound to (ADR-0007). Content, required test " +
    "evidence, base advancement, target, approval policy, expiry, or relevant " +
    "authority changes invalidate the approval; refresh/rebase and rerun tests, " +
    "then request a new card. Never rebase after approval and push under the " +
    "old one.",
  required: [
    "workspace",
    "repository",
    "candidate_id",
    "head_sha",
    "diff_digest",
    "test_evidence_digest",
    "target_branch",
    "policy_version",
  ],
  properties: {
    workspace: { $ref: "#/components/schemas/WorkspaceScope" },
    repository: { $ref: "#/components/schemas/IssueRepository" },
    candidate_id: { type: "string" },
    head_sha: { type: "string" },
    diff_digest: { $ref: "#/components/schemas/Digest" },
    test_evidence_digest: { $ref: "#/components/schemas/Digest" },
    target_branch: {
      type: "string",
      description:
        "Intended PR target branch. Writes are restricted to the issue's " +
        "autofixer branch and PR; direct main writes are never permitted.",
    },
    policy_version: { type: "string" },
  },
};

const approvalDecisionSchema: JsonObject = {
  type: "object",
  description:
    "A recorded approver decision. The approver is the authenticated caller — " +
    "never a body field — and the decision must be a confirmed mutation.",
  required: ["decision", "decided_by", "decided_at", "note"],
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    decided_by: { $ref: "#/components/schemas/UserRef" },
    decided_at: { type: "string", format: "date-time" },
    note: { type: ["string", "null"] },
  },
};

const approvalSchema: JsonObject = {
  type: "object",
  description:
    "A candidate-bound pre-PR human approval request (ADR-0007). One named " +
    "eligible human delivery approver — selected from workspace-configured " +
    "maintainers — must approve the frozen candidate before any remote branch " +
    "push or PR mutation; assignee/blame/team-leader status alone is " +
    "insufficient, and current repository access plus explicit approval " +
    "authority are checked. Approval is consumed by exactly one delivery " +
    "operation; safe retries reconcile that same operation and never reuse the " +
    "approval for a new candidate or PR. An approval never substitutes for the " +
    "repository's own PR review, checks, or quorum.",
  required: [
    "contract_version",
    "approval_id",
    "issue_id",
    "candidate_id",
    "state",
    "binding",
    "approver",
    "requested_at",
    "decided_at",
    "expires_at",
    "decision",
    "invalidated_at",
    "invalidated_reason",
    "consumed_by_delivery_id",
  ],
  properties: {
    contract_version: { type: "string", enum: [TASK_EVIDENCE_CONTRACT_VERSION] },
    approval_id: { type: "string" },
    issue_id: { type: "string" },
    candidate_id: { type: "string" },
    state: { type: "string", enum: [...APPROVAL_STATES] },
    binding: { $ref: "#/components/schemas/ApprovalBinding" },
    approver: {
      oneOf: [{ $ref: "#/components/schemas/UserRef" }, { type: "null" }],
      description:
        "The named human the request is addressed to; null while no eligible " +
        "approver is available (the issue then awaits human triage, never an " +
        "automatic approval).",
    },
    requested_at: { type: "string", format: "date-time" },
    decided_at: { type: ["string", "null"], format: "date-time" },
    expires_at: {
      type: "string",
      format: "date-time",
      description: "Finite approval TTL; the proposed default is 24 hours.",
    },
    decision: {
      oneOf: [{ $ref: "#/components/schemas/ApprovalDecision" }, { type: "null" }],
    },
    invalidated_at: { type: ["string", "null"], format: "date-time" },
    invalidated_reason: {
      type: ["string", "null"],
      enum: [...APPROVAL_INVALIDATION_REASONS, null],
    },
    consumed_by_delivery_id: { type: ["string", "null"] },
  },
};

const deliverySchema: JsonObject = {
  type: "object",
  description:
    "One broker-controlled delivery operation (ADR-0007). Only the trusted " +
    "delivery broker obtains provider write credentials; before each write it " +
    "re-checks current human approval, enterprise/repository permissions, the " +
    "dsh grant, audit availability, branch constraints, and exact candidate " +
    "identity. Operation identity and intention are persisted before the " +
    "write; ambiguous push/PR outcomes are reconciled by branch and provider " +
    "operation evidence before any retry, so a retry never merges, " +
    "self-approves, or creates a duplicate PR. A pushed branch whose PR " +
    "creation failed remains an explicit `partial` delivery — neither success " +
    "nor automatic deletion. No state change deploys the change or claims the " +
    "incident is fixed in production.",
  required: [
    "delivery_id",
    "operation_id",
    "issue_id",
    "candidate_id",
    "approval_id",
    "repository",
    "target_branch",
    "head_sha",
    "provider",
    "state",
    "branch",
    "pr_id",
    "pr_url",
    "error_code",
    "created_at",
    "updated_at",
    "reconciled_at",
  ],
  properties: {
    delivery_id: { type: "string" },
    operation_id: {
      type: "string",
      description:
        "Idempotent operation identity. Safe retries reconcile this same " +
        "operation; they never authorize a new candidate or PR.",
    },
    issue_id: { type: "string" },
    candidate_id: { type: "string" },
    approval_id: { type: "string" },
    repository: { $ref: "#/components/schemas/IssueRepository" },
    target_branch: { type: "string" },
    head_sha: { type: "string", description: "The exact approved candidate commit published." },
    provider: {
      type: "string",
      enum: ["github", "gitlab"],
      description:
        "Provider the broker writes through. GitLab delivery requires a " +
        "reviewed mapping to that provider's repository governance before " +
        "enablement; unsupported governance or missing integration permissions " +
        "leave delivery blocked rather than silently advertised.",
    },
    state: { type: "string", enum: [...DELIVERY_STATES] },
    branch: {
      type: ["string", "null"],
      description: "The issue's autofixer branch once the push is verified; null before.",
    },
    pr_id: { type: ["string", "null"] },
    pr_url: { type: ["string", "null"] },
    error_code: {
      type: ["string", "null"],
      description:
        "Safe machine code of the last provider failure (shared error " +
        "vocabulary); raw provider text and credentials never appear.",
    },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
    reconciled_at: {
      type: ["string", "null"],
      format: "date-time",
      description:
        "When the latest unknown/partial outcome was reconciled against provider evidence.",
    },
  },
};

const issueEventSchema: JsonObject = {
  type: "object",
  description:
    "One issue event on the SSE stream: the projection of exactly one durable " +
    "audit record. Replay semantics: a reconnect sends the last delivered " +
    "`event_id` in `Last-Event-ID`; the service replays every later event in " +
    "`sequence` order from the durable projection (including events written " +
    "while no client was connected, and across orchestrator restarts), so no " +
    "business event is duplicated or lost. Delivery is at least once: " +
    "`event_id` is stable and idempotent across replays — replayed frames " +
    "carry the same id and payload — so a consumer MUST deduplicate on " +
    "`event_id` and treat `sequence` as the ordering cursor. An unknown " +
    "`Last-Event-ID` replays from the start of the retained log. The stream " +
    "closes after `issue.terminal` is replayed, and a terminal issue's stream " +
    "always closes after its replay even when the anchor is already at " +
    "`issue.terminal`. A 404 ISSUE_NOT_FOUND is returned before any event is " +
    "sent when the issue is not visible to the caller.",
  required: ["event_id", "sequence", "occurred_at", "issue_id", "type", "data"],
  properties: {
    event_id: {
      type: "string",
      description:
        "Stable, replay-stable event identity and the consumer's idempotency " +
        "key. A new event never reuses an id; a replay never changes it.",
    },
    sequence: {
      type: "integer",
      description: "Monotonic, gap-free order within the issue's event log.",
    },
    occurred_at: { type: "string", format: "date-time" },
    issue_id: { type: "string" },
    type: { type: "string", enum: [...ISSUE_EVENT_TYPES] },
    data: { type: "object", additionalProperties: true },
  },
};

/** The replay-safe command identity every collaboration mutation carries. */
const IDEMPOTENCY_KEY_PARAMETER: JsonObject = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 256 },
  description:
    "Replay-safe command identity. Repeating the request with the same key " +
    "and payload returns the recorded result instead of applying the command " +
    "twice; the same key with a different payload is 409 " +
    "IDEMPOTENCY_CONFLICT. A safe retry reuses the key; a new intent uses a " +
    "new one.",
};

const WORKSPACE_ID_PARAMETER: JsonObject = {
  name: "workspace_id",
  in: "path",
  required: true,
  schema: { type: "string" },
};

const ISSUE_ID_PARAMETER: JsonObject = {
  name: "issue_id",
  in: "path",
  required: true,
  schema: { type: "string" },
};

function errorResponse(description: string): JsonObject {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

function jsonRef(ref: string): JsonObject {
  return { content: { "application/json": { schema: { $ref: ref } } } };
}

/**
 * The single Bearer security requirement applied to every operation. The
 * per-process token (see the M0 Authentication section) is what authorizes a
 * caller — approvals included — so a client generated from this contract
 * knows to send `Authorization: Bearer <token>` on every call.
 */
const BEARER_SECURITY: Array<Record<string, string[]>> = [{ bearerAuth: [] }];

/** Web sessions: HttpOnly cookie plus the X-CSRF-Token echo on writes. */
const SESSION_SECURITY: Array<Record<string, string[]>> = [
  { sessionCookie: [] },
  { bearerAuth: [] },
];

/**
 * Administration: the deployment bootstrap token (the first provider
 * approval and the one-time first-administrator grant) or an enterprise
 * administrator session.
 */
const ADMIN_SECURITY: Array<Record<string, string[]>> = [
  { bootstrapToken: [] },
  { sessionCookie: [] },
  { bearerAuth: [] },
];

/** Bootstrap grants are deployment-owned: never an ordinary session. */
const BOOTSTRAP_SECURITY: Array<Record<string, string[]>> = [{ bootstrapToken: [] }];

/** Anonymous login surface: no credential is required to start a login. */
const ANONYMOUS_SECURITY: Array<Record<string, string[]>> = [];

const MUTATING_METHODS: Record<string, true> = { post: true, patch: true, put: true, delete: true };

/**
 * The CSRF header every state-changing operation documents. Cookie
 * (ambient) credentials must echo the session's `csrf_token` here; bearer
 * credentials are not ambient and do not send it.
 */
const CSRF_PARAMETER: JsonObject = {
  name: "X-CSRF-Token",
  in: "header",
  required: false,
  schema: { type: "string" },
  description:
    "Required for cookie-authenticated state-changing requests: echo the " +
    "session's `csrf_token`. A missing or wrong value is 403 " +
    "CSRF_TOKEN_INVALID. Bearer-authenticated requests do not send it.",
};

/** The shared pagination parameter: opaque, server-defined cursors. */
const CURSOR_PARAMETER: JsonObject = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: "string" },
  description:
    "Opaque pagination cursor copied from a previous page's `next_cursor`. " +
    "Clients must not construct, parse, or interpret cursors; an unknown " +
    "cursor is 400 INVALID_CURSOR.",
};

function pageSchema(itemRef: string): JsonObject {
  return {
    type: "object",
    required: ["items", "next_cursor"],
    properties: {
      items: { type: "array", items: { $ref: itemRef } },
      next_cursor: {
        type: ["string", "null"],
        description: "Opaque cursor for the next page; null at the end of the list.",
      },
    },
  };
}

/** The 401 response every operation can return when the credential is unusable. */
function unauthorizedResponse(): JsonObject {
  return errorResponse(
    "UNAUTHENTICATED — missing, invalid, expired, or invalidated credential " +
      "(bearer token or session cookie). The response is uniform for every " +
      "authentication failure; it never names the cause (see the contract's " +
      "Non-enumeration section).",
  );
}

/**
 * Stamp the security requirement and the 401 response onto every operation
 * that does not declare its own `security` (the identity surface declares
 * its own; task operations accept either credential — the enterprise web
 * client is session-authenticated and desktop keeps the bearer). Every
 * state-changing operation whose security includes the ambient session
 * cookie also documents the CSRF echo header.
 */
function stampAuth(paths: Record<string, Record<string, unknown>>): void {
  for (const methods of Object.values(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation === null || typeof operation !== "object") {
        continue;
      }
      const op = operation as {
        security?: Array<Record<string, string[]>>;
        parameters?: Array<JsonObject>;
        responses?: Record<string, unknown>;
      };
      if (op.security === undefined) {
        op.security = SESSION_SECURITY;
        op.responses = { ...op.responses, 401: unauthorizedResponse() };
      }
      const cookieCredential = (op.security ?? []).some(
        (entry) => entry["sessionCookie"] !== undefined,
      );
      if (cookieCredential && MUTATING_METHODS[method]) {
        const hasCsrf = (op.parameters ?? []).some(
          (parameter) => parameter["name"] === "X-CSRF-Token",
        );
        if (!hasCsrf) {
          op.parameters = [...(op.parameters ?? []), CSRF_PARAMETER];
        }
      }
    }
  }
}

/**
 * Build the OpenAPI 3.1 description of forgepilot-api/v1.
 *
 * Derived from the same route and schema vocabulary the HTTP server serves;
 * the generated document at web/src/api/contracts/openapi.json is the merged
 * baseline the UI milestone consumes. Shapes follow docs/contracts/
 * forgepilot-api-v1.md (M0) exactly.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {
    "/api/v1/tasks": {
      post: {
        operationId: "createTask",
        summary: "Create a remediation task",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 256 },
            description:
              "Replay-safe create. Repeating the request with the same key " +
              "and payload returns the original task instead of minting a " +
              "second run; the same key with a different payload is 409 " +
              "IDEMPOTENCY_CONFLICT.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["repository_id", "base_ref", "summary"],
                properties: {
                  repository_id: { type: "string", examples: ["github:Luthiel/AutoFixer"] },
                  base_ref: { type: "string", examples: ["main"] },
                  summary: { type: "string" },
                  source_reference: { type: "string" },
                  acceptance_criteria: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Task created", ...jsonRef("#/components/schemas/Task") },
          400: errorResponse("Invalid request"),
          409: errorResponse("Task state conflict or IDEMPOTENCY_CONFLICT"),
          422: errorResponse(
            "Prohibited work was rejected by dsh (details.task_id names the rejected task)",
          ),
          503: errorResponse("PI_UNAVAILABLE or DSH_UNAVAILABLE"),
        },
      },
      get: {
        operationId: "listTasks",
        summary: "List tasks",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: [...UI_STATUSES] } },
        ],
        responses: {
          200: {
            description: "Task page",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "next_cursor"],
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/Task" } },
                    next_cursor: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          400: errorResponse("Invalid cursor or status"),
        },
      },
    },
    "/api/v1/tasks/{task_id}": {
      get: {
        operationId: "getTask",
        summary: "Read one task",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Task", ...jsonRef("#/components/schemas/Task") },
          404: errorResponse("Task not found"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/runs": {
      get: {
        operationId: "getTaskRuns",
        summary: "List the task's runs, ordered by creation time",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Run summaries",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/RunSummary" } },
                  },
                },
              },
            },
          },
          404: errorResponse("Task not found"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/messages": {
      post: {
        operationId: "sendMessage",
        summary: "Queue a steering or follow-up message for the task's Pi session",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["mode", "content"],
                properties: {
                  mode: { type: "string", enum: ["steer", "follow_up"] },
                  content: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          202: {
            description: "Message queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["task_id", "queued"],
                  properties: { task_id: { type: "string" }, queued: { type: "boolean" } },
                },
              },
            },
          },
          400: errorResponse("Invalid request"),
          404: errorResponse("Task not found"),
          409: errorResponse("Task state conflict"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/approvals": {
      post: {
        operationId: "approveTask",
        summary: "Record the pre-grant approval decision for an elevated task",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["decision", "scope_digest"],
                properties: {
                  decision: { type: "string", enum: ["approve", "reject"] },
                  scope_digest: { type: "string", examples: ["sha256:…"] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Task after the decision",
            ...jsonRef("#/components/schemas/Task"),
          },
          400: errorResponse("Invalid request"),
          404: errorResponse("Task not found"),
          409: errorResponse("Task state conflict"),
          403: errorResponse("FORBIDDEN or a dsh policy denial"),
          503: errorResponse("PI_UNAVAILABLE or DSH_UNAVAILABLE"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/cancel": {
      post: {
        operationId: "cancelTask",
        summary: "Cancel a task",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { reason: { type: "string" } },
              },
            },
          },
        },
        responses: {
          202: { description: "Cancellation requested", ...jsonRef("#/components/schemas/Task") },
          404: errorResponse("Task not found"),
          409: errorResponse("The task cannot be cancelled in its terminal state."),
        },
      },
    },
    "/api/v1/tasks/{task_id}/archive": {
      post: {
        operationId: "archiveTask",
        summary: "Move a cancelled task to the archive",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Task after archiving", ...jsonRef("#/components/schemas/Task") },
          404: errorResponse("Task not found"),
          409: errorResponse("Task is not cancelled"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/recover": {
      post: {
        operationId: "recoverTask",
        summary: "Restore a cancelled task to the workspace",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Task after restoring its visibility",
            ...jsonRef("#/components/schemas/Task"),
          },
          404: errorResponse("Task not found"),
          409: errorResponse("Task is not cancelled"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/timeline": {
      get: {
        operationId: "getTaskTimeline",
        summary: "Read the task's redacted event timeline",
        parameters: [{ name: "task_id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: {
            description: "Timeline items",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/TaskEvent" } },
                  },
                },
              },
            },
          },
          404: errorResponse("Task not found"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/artifacts/{artifact_id}": {
      get: {
        operationId: "getTaskArtifact",
        summary: "Read one redacted artifact for the task's current run",
        parameters: [
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
          { name: "artifact_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Redacted artifact, already redacted by dsh",
            content: {
              "application/json": { schema: { type: "object", additionalProperties: true } },
            },
          },
          403: errorResponse("Artifact access denied"),
          404: errorResponse("Task or artifact not found"),
          409: errorResponse("Artifact not finalized"),
          410: errorResponse("Artifact expired"),
        },
      },
    },
    "/api/v1/tasks/{task_id}/stream": {
      get: {
        operationId: "streamTaskEvents",
        summary:
          "SSE stream of task events; replays by Last-Event-ID in sequence order " +
          "from the durable projection, so a reconnect after an orchestrator " +
          "restart resumes exactly where the client stopped without duplicating " +
          "business events. A terminal task's stream always closes after its " +
          "replay, including when Last-Event-ID is already anchored at " +
          "task.terminal and the replay has nothing left to write.",
        parameters: [
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Last-Event-ID",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Replay events after this event_id; unknown ids replay from the start.",
          },
        ],
        responses: {
          200: {
            description:
              "text/event-stream. Each event carries id (event_id), the event type, " +
              "and data: the TaskEvent envelope. The stream ends after task.terminal.",
            content: {
              "text/event-stream": {
                schema: { $ref: "#/components/schemas/TaskEvent" },
              },
            },
          },
          404: errorResponse("Task not found"),
        },
      },
    },

    // --- Workspace-scoped tasks (DAT-244) ----------------------------------
    //
    // The `{workspace_id}` segment is a locator, never a grant: each
    // operation resolves the caller's live membership for that workspace on
    // the request path, and no-membership, revoked, cross-enterprise, and
    // unknown are one indistinguishable 404 NOT_FOUND. A task owned by any
    // other workspace is the same 404, so the family is not an enumeration
    // oracle.

    "/api/v1/workspaces/{workspace_id}/tasks": {
      post: {
        operationId: "createWorkspaceTask",
        summary: "Create a task in one workspace",
        description:
          "Creates the task and its dsh run inside the path workspace. The " +
          "workspace's own binding supplies the repository, base revision, " +
          "and model-gateway enterprise/workspace identity; the deployment's " +
          "configured repository is never a fallback. `repository_id` must " +
          "equal the workspace's repository binding (`400 " +
          "REPOSITORY_NOT_IN_WORKSPACE`) and `base_ref` must equal that " +
          "binding's pinned base revision (`400 BASE_REF_NOT_SUPPORTED`). " +
          "Unknown/archived workspaces and non-members are one " +
          "`404 NOT_FOUND`; viewers are `403 FORBIDDEN`. A workspace whose " +
          "repository has no pinned base revision in this deployment is " +
          "`409 REPOSITORY_BINDING_UNAVAILABLE`, and a provider instance " +
          "that is no longer registered is `409 " +
          "PROVIDER_INSTANCE_NOT_APPROVED`; both refuse before any dsh " +
          "dispatch. Each workspace has its own idempotency-key namespace.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 256 },
            description:
              "Replay-safe create scoped to this workspace. Repeating the " +
              "request with the same key and payload returns the original " +
              "task instead of minting a second run; the same key with a " +
              "different payload is 409 IDEMPOTENCY_CONFLICT.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["repository_id", "base_ref", "summary"],
                properties: {
                  repository_id: { type: "string", examples: ["github:Luthiel/AutoFixer"] },
                  base_ref: { type: "string", examples: ["main"] },
                  summary: { type: "string" },
                  source_reference: { type: "string" },
                  acceptance_criteria: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Task created in this workspace",
            ...jsonRef("#/components/schemas/Task"),
          },
          400: errorResponse(
            "INVALID_REQUEST, REPOSITORY_NOT_IN_WORKSPACE, or BASE_REF_NOT_SUPPORTED",
          ),
          403: errorResponse("FORBIDDEN — viewer, or repository authority denied"),
          404: errorResponse("NOT_FOUND — no live membership for this workspace"),
          409: errorResponse(
            "IDEMPOTENCY_CONFLICT, REPOSITORY_BINDING_UNAVAILABLE, or PROVIDER_INSTANCE_NOT_APPROVED",
          ),
          422: errorResponse(
            "Prohibited work was rejected by dsh (details.task_id names the rejected task)",
          ),
          503: errorResponse("PI_UNAVAILABLE or DSH_UNAVAILABLE"),
        },
      },
      get: {
        operationId: "listWorkspaceTasks",
        summary: "List tasks owned by one workspace",
        description:
          "Cursor/status semantics are identical to `GET /api/v1/tasks`, but " +
          "only tasks whose durable `workspace_id` is this workspace are " +
          "visible; a foreign task id is never a valid cursor.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: [...UI_STATUSES] } },
        ],
        responses: {
          200: {
            description: "Workspace task page",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "next_cursor"],
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/Task" } },
                    next_cursor: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          400: errorResponse("INVALID_REQUEST — unknown status filter"),
          404: errorResponse(
            "NOT_FOUND — no live membership for this workspace, or a cursor from another workspace",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}": {
      get: {
        operationId: "getWorkspaceTask",
        summary: "Read one task in a workspace",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Task", ...jsonRef("#/components/schemas/Task") },
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/runs": {
      get: {
        operationId: "getWorkspaceTaskRuns",
        summary: "List the task's runs in a workspace",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Run summaries",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/RunSummary" } },
                  },
                },
              },
            },
          },
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/messages": {
      post: {
        operationId: "sendWorkspaceTaskMessage",
        summary: "Queue a steering or follow-up message for the task's Pi session",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["mode", "content"],
                properties: {
                  mode: { type: "string", enum: ["steer", "follow_up"] },
                  content: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          202: {
            description: "Message queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["task_id", "queued"],
                  properties: { task_id: { type: "string" }, queued: { type: "boolean" } },
                },
              },
            },
          },
          400: errorResponse("Invalid request"),
          403: errorResponse("FORBIDDEN — viewer is read-only"),
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
          409: errorResponse("Task state conflict"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/approvals": {
      post: {
        operationId: "approveWorkspaceTask",
        summary: "Record the pre-grant approval decision for an elevated task",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["decision", "scope_digest"],
                properties: {
                  decision: { type: "string", enum: ["approve", "reject"] },
                  scope_digest: { type: "string", examples: ["sha256:…"] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Task after the decision",
            ...jsonRef("#/components/schemas/Task"),
          },
          400: errorResponse("Invalid request"),
          403: errorResponse("FORBIDDEN — viewer, provider authority, or dsh policy denial"),
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
          409: errorResponse("Task state conflict"),
          503: errorResponse("PI_UNAVAILABLE or DSH_UNAVAILABLE"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/cancel": {
      post: {
        operationId: "cancelWorkspaceTask",
        summary: "Cancel a task",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { reason: { type: "string" } },
              },
            },
          },
        },
        responses: {
          202: { description: "Cancellation requested", ...jsonRef("#/components/schemas/Task") },
          403: errorResponse("FORBIDDEN — viewer is read-only"),
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
          409: errorResponse("The task cannot be cancelled in its terminal state."),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/archive": {
      post: {
        operationId: "archiveWorkspaceTask",
        summary: "Move a cancelled task to the archive",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Task after archiving", ...jsonRef("#/components/schemas/Task") },
          403: errorResponse("FORBIDDEN — viewer is read-only"),
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
          409: errorResponse("Task is not cancelled"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/recover": {
      post: {
        operationId: "recoverWorkspaceTask",
        summary: "Restore a cancelled task to the workspace",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Task after restoring its visibility",
            ...jsonRef("#/components/schemas/Task"),
          },
          403: errorResponse("FORBIDDEN — viewer is read-only"),
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
          409: errorResponse("Task is not cancelled"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/timeline": {
      get: {
        operationId: "getWorkspaceTaskTimeline",
        summary: "Read the task's redacted event timeline",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Timeline items",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/TaskEvent" } },
                  },
                },
              },
            },
          },
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/artifacts/{artifact_id}": {
      get: {
        operationId: "getWorkspaceTaskArtifact",
        summary: "Read one redacted artifact for the task's current run",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
          { name: "artifact_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Redacted artifact, already redacted by dsh",
            content: {
              "application/json": { schema: { type: "object", additionalProperties: true } },
            },
          },
          403: errorResponse("Artifact access denied"),
          404: errorResponse("NOT_FOUND — workspace access, task ownership, or artifact missing"),
          409: errorResponse("Artifact not finalized"),
          410: errorResponse("Artifact expired"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/tasks/{task_id}/stream": {
      get: {
        operationId: "streamWorkspaceTaskEvents",
        summary: "SSE stream of task events in one workspace",
        description:
          "Replay and Last-Event-ID semantics match `GET /api/v1/tasks/" +
          "{task_id}/stream`. The subscription is bound to both the session " +
          "and this workspace: logout, account suspension, or losing this " +
          "workspace's membership closes it immediately, while membership " +
          "changes in another workspace leave it untouched.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Last-Event-ID",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Replay events after this event_id; unknown ids replay from the start.",
          },
        ],
        responses: {
          200: {
            description:
              "text/event-stream. Each event carries id (event_id), the event type, " +
              "and data: the TaskEvent envelope. The stream ends after task.terminal " +
              "or when the subscription's authority ends.",
            content: {
              "text/event-stream": {
                schema: { $ref: "#/components/schemas/TaskEvent" },
              },
            },
          },
          404: errorResponse("NOT_FOUND — workspace access or task ownership missing"),
        },
      },
    },

    // --- Identity and sessions (DAT-202) -----------------------------------

    "/api/v1/auth/providers": {
      get: {
        operationId: "listLoginProviders",
        summary: "List administrator-approved provider instances available for login",
        security: ANONYMOUS_SECURITY,
        responses: {
          200: {
            description: "Approved login providers",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: {
                      type: "array",
                      items: { $ref: "#/components/schemas/LoginProvider" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/auth/login": {
      get: {
        operationId: "startLogin",
        summary: "Start a provider OAuth login (authorization code + state + PKCE)",
        description:
          "Browser navigation: responds 302 to the provider's authorize URL " +
          "with an exact pre-registered redirect_uri, a single-use state, and " +
          "an S256 PKCE challenge. Set-Cookie fp_oauth_binding (HttpOnly) " +
          "binds the flow to this browser so a login-CSRF callback cannot " +
          "complete. desktop_flow binds the login to a pending desktop flow.",
        security: ANONYMOUS_SECURITY,
        parameters: [
          {
            name: "provider_instance_id",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Must name an administrator-approved provider instance.",
          },
          {
            name: "return_to",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Relative same-deployment path only; absolute URLs fall back to /.",
          },
          {
            name: "desktop_flow",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Pending desktop auth flow id to bind this login to.",
          },
        ],
        responses: {
          302: {
            description: "Redirect to the provider authorize endpoint",
            headers: {
              Location: { schema: { type: "string" } },
              "Set-Cookie": {
                schema: { type: "string" },
                description: "fp_oauth_binding=<secret>; HttpOnly; SameSite=Lax",
              },
            },
          },
          400: errorResponse("Unknown/unusable provider instance"),
          410: errorResponse("AUTH_FLOW_EXPIRED: desktop flow is not startable"),
        },
      },
    },
    "/api/v1/auth/callback": {
      get: {
        operationId: "completeLogin",
        summary: "OAuth callback: single-use code/state exchange into a session",
        description:
          "Validates the single-use state and the browser binding, exchanges " +
          "the code with PKCE, and matches the account only by (provider " +
          "instance, stable subject) — never by email. Web flows get the " +
          "session as an HttpOnly cookie and a 302 to return_to; desktop " +
          "flows get a plain completion page and deliver the credential " +
          "through the single-use exchange instead.",
        security: ANONYMOUS_SECURITY,
        parameters: [
          { name: "code", in: "query", required: true, schema: { type: "string" } },
          { name: "state", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          302: {
            description: "Web login complete; redirect to return_to",
            headers: {
              Location: { schema: { type: "string" } },
              "Set-Cookie": {
                schema: { type: "string" },
                description: "fp_session=<token>; HttpOnly; SameSite=Lax; Max-Age",
              },
            },
          },
          200: {
            description: "Desktop login complete; return to the application",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          400: errorResponse("AUTH_FLOW_INVALID: unknown state or malformed callback"),
          403: errorResponse("FORBIDDEN: binding mismatch (login CSRF) or suspended account"),
          410: errorResponse("AUTH_FLOW_CONSUMED (replay) or AUTH_FLOW_EXPIRED"),
          502: errorResponse("PROVIDER_ERROR: provider token/userinfo call failed (retryable)"),
        },
      },
    },
    "/api/v1/auth/session": {
      get: {
        operationId: "getSession",
        summary: "Describe the current session, roles, memberships, and CSRF token",
        security: SESSION_SECURITY,
        responses: {
          200: {
            description: "Current session",
            ...jsonRef("#/components/schemas/SessionInfo"),
          },
          401: unauthorizedResponse(),
        },
      },
    },
    "/api/v1/auth/logout": {
      post: {
        operationId: "logout",
        summary: "Revoke the current session immediately",
        description:
          "Revokes the session server-side (reads, writes, and live SSE " +
          "subscriptions die with it) and expires the cookie. Cookie " +
          "sessions must echo the session CSRF token in X-CSRF-Token.",
        security: SESSION_SECURITY,
        parameters: [
          {
            name: "X-CSRF-Token",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "Required for cookie sessions; desktop bearer sessions are exempt.",
          },
        ],
        responses: {
          204: { description: "Session revoked" },
          401: unauthorizedResponse(),
          403: errorResponse("FORBIDDEN: missing or invalid CSRF token"),
        },
      },
    },
    "/api/v1/auth/desktop/flows": {
      post: {
        operationId: "createDesktopFlow",
        summary: "Start a desktop system-browser sign-in binding",
        description:
          "Returns a flow id and a single-use secret held by the desktop only. " +
          "The desktop opens login_url in the system browser; sign-in " +
          "completes server-side and one exchange delivers the session.",
        security: ANONYMOUS_SECURITY,
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  provider_instance_id: {
                    type: "string",
                    description: "Optional preselection included in login_url.",
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Desktop flow created",
            ...jsonRef("#/components/schemas/DesktopFlow"),
          },
        },
      },
    },
    "/api/v1/auth/desktop/flows/{flow_id}/exchange": {
      post: {
        operationId: "exchangeDesktopFlow",
        summary: "Single-use exchange of the desktop secret for a session token",
        security: ANONYMOUS_SECURITY,
        parameters: [{ name: "flow_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["secret"],
                properties: { secret: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Session issued (exactly once per flow)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "token", "csrf_token", "expires_at", "user"],
                  properties: {
                    status: { type: "string", enum: ["ok"] },
                    token: {
                      type: "string",
                      description: "Desktop session token for Authorization: Bearer.",
                    },
                    csrf_token: { type: "string" },
                    expires_at: { type: "string", format: "date-time" },
                    user: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
          400: errorResponse("AUTH_FLOW_INVALID: unknown flow"),
          401: errorResponse("UNAUTHENTICATED: wrong secret (attempts are counted)"),
          410: errorResponse("AUTH_FLOW_CONSUMED (replay) or AUTH_FLOW_EXPIRED"),
          428: errorResponse("AUTH_FLOW_NOT_READY: browser sign-in has not completed"),
          429: errorResponse("RATE_LIMITED: too many exchange attempts (retryable)"),
        },
      },
    },

    // --- Administration (DAT-202) ------------------------------------------

    "/api/v1/admin/enterprises/{enterprise_id}/bootstrap": {
      post: {
        operationId: "bootstrapAdmin",
        summary: "Deployment-owned, audited grant of the first enterprise administrator",
        description:
          "Names the administrator by provider instance and stable subject " +
          "explicitly — whoever signed in first cannot capture the role — and " +
          "succeeds at most once per enterprise. Requires the deployment " +
          "bootstrap token (X-Bootstrap-Token); ordinary sessions are refused.",
        security: BOOTSTRAP_SECURITY,
        parameters: [
          {
            name: "enterprise_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "X-Bootstrap-Token",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["provider_instance_id", "subject"],
                properties: {
                  provider_instance_id: { type: "string" },
                  subject: {
                    type: "string",
                    description: "Stable provider subject; the identity must have signed in.",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Enterprise administrator granted (idempotent for the same identity)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["enterprise_id", "user_id", "role"],
                  properties: {
                    enterprise_id: { type: "string" },
                    user_id: { type: "string" },
                    role: { type: "string", enum: ["admin"] },
                  },
                },
              },
            },
          },
          401: unauthorizedResponse(),
          403: errorResponse("FORBIDDEN: session callers are never deployment authority"),
          404: errorResponse("NOT_FOUND: enterprise, provider instance, or signed-in identity"),
          409: errorResponse("BOOTSTRAP_CONFLICT: an administrator already exists"),
          503: errorResponse("BOOTSTRAP_UNAVAILABLE: no deployment token configured (retryable)"),
        },
      },
    },
    "/api/v1/admin/enterprises/{enterprise_id}/provider-instances": {
      post: {
        operationId: "registerProviderInstance",
        summary: "Administrator approval of a provider instance origin",
        description:
          "The approval gate for OAuth logins. Refuses internal-network or " +
          "arbitrary self-hosted origins: HTTPS, no credentials/path/query/" +
          "fragment, default port, public hostname or IP literal, public DNS " +
          "answers, and a configured OAuth application are all required.",
        security: ADMIN_SECURITY,
        parameters: [
          {
            name: "enterprise_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["provider_type", "origin_url"],
                properties: {
                  provider_type: { type: "string", enum: ["github", "gitlab"] },
                  origin_url: { type: "string", examples: ["https://github.com"] },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Provider instance approved",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["provider_instance"],
                  properties: {
                    provider_instance: { $ref: "#/components/schemas/ProviderInstance" },
                  },
                },
              },
            },
          },
          400: errorResponse("INVALID_REQUEST: unusable origin or no OAuth application"),
          401: unauthorizedResponse(),
          403: errorResponse("PROVIDER_ORIGIN_REJECTED or missing administrator authority"),
        },
      },
    },
    "/api/v1/admin/enterprises/{enterprise_id}/auth-audit": {
      get: {
        operationId: "listAuthAudit",
        summary: "Read the secret-free authentication/authorization audit trail",
        security: ADMIN_SECURITY,
        parameters: [
          {
            name: "enterprise_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          200: {
            description: "Audit records, newest first",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: {
                      type: "array",
                      items: { $ref: "#/components/schemas/AuthAuditRecord" },
                    },
                  },
                },
              },
            },
          },
          401: unauthorizedResponse(),
          403: errorResponse("FORBIDDEN: administrator authority required"),
        },
      },
    },
    "/api/v1/admin/enterprises/{enterprise_id}/workspaces/{workspace_id}/members/{user_id}": {
      put: {
        operationId: "grantMembership",
        summary: "Grant or fail on a workspace membership (administrator)",
        security: ADMIN_SECURITY,
        parameters: [
          {
            name: "enterprise_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "workspace_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "user_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["role"],
                properties: {
                  role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Membership granted",
            ...jsonRef("#/components/schemas/Membership"),
          },
          401: unauthorizedResponse(),
          403: errorResponse("FORBIDDEN: administrator authority required"),
          404: errorResponse("Workspace or user not found"),
          409: errorResponse("CONFLICT: already a member"),
        },
      },
      delete: {
        operationId: "revokeMembership",
        summary: "Revoke a workspace membership; live streams close immediately",
        security: ADMIN_SECURITY,
        parameters: [
          {
            name: "enterprise_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "workspace_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          { name: "user_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          204: { description: "Membership revoked" },
          401: unauthorizedResponse(),
          403: errorResponse("FORBIDDEN: administrator authority required"),
          404: errorResponse("Membership not found"),
        },
      },
    },
    "/api/v1/admin/users/{user_id}/suspend": {
      post: {
        operationId: "suspendUser",
        summary: "Suspend a user: all sessions, SSE streams, and logins die",
        security: ADMIN_SECURITY,
        parameters: [{ name: "user_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  enterprise_id: {
                    type: "string",
                    description: "Optional locator for deployment actors.",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "User suspended",
            ...jsonRef("#/components/schemas/User"),
          },
          401: unauthorizedResponse(),
          403: errorResponse("FORBIDDEN: administrator authority over this user required"),
          404: errorResponse("User not found"),
        },
      },
    },
    "/api/v1/admin/users/{user_id}/activate": {
      post: {
        operationId: "activateUser",
        summary: "Reactivate a suspended user",
        security: ADMIN_SECURITY,
        parameters: [{ name: "user_id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { enterprise_id: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: {
            description: "User activated",
            ...jsonRef("#/components/schemas/User"),
          },
          401: unauthorizedResponse(),
          403: errorResponse("FORBIDDEN: administrator authority over this user required"),
          404: errorResponse("User not found"),
        },
      },
    },
    "/api/v1/workspaces": {
      get: {
        operationId: "listWorkspaces",
        summary: "List workspaces the caller can access",
        description:
          "Exactly the workspaces the caller's authenticated enterprise " +
          "memberships grant — resolved server-side; substituting an ID " +
          "anywhere in a request never widens this list (ADR-0006). Pages are " +
          "`{items, next_cursor}` with opaque cursors, ordered by creation " +
          "time, throughout this API.",
        parameters: [CURSOR_PARAMETER],
        responses: {
          200: {
            description: "Workspace page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Workspace") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
        },
      },
      post: {
        operationId: "createWorkspace",
        summary: "Create a workspace binding a provider repository",
        description:
          "Enterprise owner/admin only. The workspace binds the provider " +
          "instance and the immutable provider-assigned `repository_id`; " +
          "within one enterprise one active workspace per repository is " +
          "enforced transactionally. Creation never expands credentials and " +
          "never changes enterprise scope.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "repository_id", "provider_instance_id"],
                properties: {
                  name: { type: "string" },
                  repository_id: { type: "string" },
                  provider_instance_id: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Workspace created",
            ...jsonRef("#/components/schemas/Workspace"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN"),
          409: errorResponse(
            "WORKSPACE_REPOSITORY_CONFLICT — the repository already has an " +
              "active workspace in this enterprise",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}": {
      get: {
        operationId: "getWorkspace",
        summary: "Read one workspace",
        description:
          "404 NOT_FOUND is non-enumerating: identical whether the workspace " +
          "does not exist, belongs to another enterprise, or the caller's " +
          "membership was revoked (see Non-enumeration).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Workspace", ...jsonRef("#/components/schemas/Workspace") },
          404: errorResponse("NOT_FOUND"),
        },
      },
      patch: {
        operationId: "renameWorkspace",
        summary: "Rename a workspace (metadata only)",
        description:
          "Owner/admin only. Renames update metadata; the repository binding, " +
          "the enterprise, and credentials are unchanged. `version` is the " +
          "optimistic-concurrency token from the resource being modified.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "version"],
                properties: {
                  name: { type: "string" },
                  version: {
                    type: "integer",
                    description: "The resource's current version (optimistic concurrency).",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Workspace after rename",
            ...jsonRef("#/components/schemas/Workspace"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("VERSION_CONFLICT"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/archive": {
      post: {
        operationId: "archiveWorkspace",
        summary: "Archive a workspace",
        description:
          "Owner/admin only. Archiving is transactional and reversible via " +
          "restore; archived workspaces leave the default list. An archived " +
          "workspace never blocks another workspace from binding the same " +
          "repository.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version"],
                properties: {
                  version: {
                    type: "integer",
                    description: "The resource's current version (optimistic concurrency).",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Workspace after archiving",
            ...jsonRef("#/components/schemas/Workspace"),
          },
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("VERSION_CONFLICT"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/restore": {
      post: {
        operationId: "restoreWorkspace",
        summary: "Restore an archived workspace",
        description:
          "Owner/admin only. Restore re-checks the one-active-workspace-per-" +
          "repository rule transactionally and fails with " +
          "WORKSPACE_REPOSITORY_CONFLICT rather than creating a second active " +
          "binding.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version"],
                properties: {
                  version: {
                    type: "integer",
                    description: "The resource's current version (optimistic concurrency).",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Workspace after restore",
            ...jsonRef("#/components/schemas/Workspace"),
          },
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("VERSION_CONFLICT or WORKSPACE_REPOSITORY_CONFLICT"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/transfer": {
      post: {
        operationId: "transferWorkspace",
        summary: "Replace the workspace's repository binding",
        description:
          "Owner/admin only. A repository transfer replaces the immutable " +
          "binding and requires authority revalidation against the provider: " +
          "it never silently changes the enterprise and never expands " +
          "credentials. When current authority is stale or unknown the " +
          "transfer is blocked with AUTHORITY_RECHECK_REQUIRED pending " +
          "reconciliation (ADR-0006, DAT-203).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["repository_id", "provider_instance_id", "version"],
                properties: {
                  repository_id: { type: "string" },
                  provider_instance_id: { type: "string" },
                  version: {
                    type: "integer",
                    description: "The resource's current version (optimistic concurrency).",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Workspace after transfer",
            ...jsonRef("#/components/schemas/Workspace"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse(
            "VERSION_CONFLICT, WORKSPACE_REPOSITORY_CONFLICT, or " + "AUTHORITY_RECHECK_REQUIRED",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/members": {
      get: {
        operationId: "listWorkspaceMembers",
        summary: "List workspace memberships with provider-role provenance",
        description:
          "Owner/admin and members see the roster with the provenance of " +
          "effective provider roles (MemberAuthority). Provenance is " +
          "normalized explicitly and fails closed: unverified authority shows " +
          "`unknown`, and stale authority blocks sensitive actions pending " +
          "reconciliation (DAT-203).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: {
            description: "Membership page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Membership") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
      post: {
        operationId: "addWorkspaceMember",
        summary: "Add a member selected from the provider roster",
        description:
          "Owner/admin only; the user must be an eligible discovered " +
          "candidate (see `GET /api/v1/workspaces/{workspace_id}/" +
          "member-candidates`). Roles are granted only within the actor's own " +
          "authority — a grant above it is 403 ROLE_NOT_ASSIGNABLE. Every " +
          "grant is audited (ADR-0006).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["user_id", "role"],
                properties: {
                  user_id: { type: "string" },
                  role: { type: "string", enum: [...WORKSPACE_ROLES] },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Membership created",
            ...jsonRef("#/components/schemas/Membership"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN or ROLE_NOT_ASSIGNABLE"),
          404: errorResponse("NOT_FOUND — workspace or candidate not visible"),
          409: errorResponse("MEMBERSHIP_CONFLICT — the user is already a member"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/members/{membership_id}": {
      patch: {
        operationId: "updateWorkspaceMember",
        summary: "Change a member's workspace role",
        description:
          "Owner/admin only. Roles are assigned only within the actor's own " +
          "authority (403 ROLE_NOT_ASSIGNABLE for escalation). Administrative " +
          "role elevation is this separate audited action — invitations " +
          "always join as `member` (ADR-0006).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "membership_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["role", "version"],
                properties: {
                  role: { type: "string", enum: [...WORKSPACE_ROLES] },
                  version: {
                    type: "integer",
                    description: "The resource's current version (optimistic concurrency).",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Membership after the role change",
            ...jsonRef("#/components/schemas/Membership"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN or ROLE_NOT_ASSIGNABLE"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("VERSION_CONFLICT"),
        },
      },
      delete: {
        operationId: "removeWorkspaceMember",
        summary: "Remove a member (revoke access)",
        description:
          "Owner/admin only. Removal is enforced on the same request path " +
          "from this point: reads, streams, artifacts, approvals, and writes " +
          "are rejected, and the member's workspace-scoped SSE subscriptions " +
          "are terminated (see Session invalidation). Capability grants " +
          "derived from the membership are revoked (ADR-0006, DAT-203).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "membership_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          204: { description: "Membership removed" },
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/member-candidates": {
      get: {
        operationId: "listMemberCandidates",
        summary: "Provider-roster eligibility view for imports (owner/admin)",
        description:
          "The provider member roster, normalized explicitly: organization " +
          "owners, groups, inherited roles, and direct collaborators are " +
          "named as such, and authority that belongs to an organization is " +
          'never invented as a repository "owner" user (ADR-0006). ' +
          "Completeness is fail-closed: missing provider permissions or " +
          "incomplete roster pages are the error PROVIDER_ROSTER_INCOMPLETE, " +
          "never an empty 200 list. Candidates with stale or unknown " +
          "authority carry `eligible: false` with an `ineligible_reason` " +
          "code (DAT-203).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: {
            description: "Candidate page — served only when the roster is complete",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/MemberCandidate") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          503: errorResponse(
            "PROVIDER_ROSTER_INCOMPLETE — missing provider permissions or " +
              "incomplete roster pages; never an empty list",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/teams": {
      get: {
        operationId: "listWorkspaceTeams",
        summary: "List workspace teams",
        description:
          "Teams are a routing signal, never an authorization source: team " +
          "leadership or membership grants no repository access, security " +
          "privilege, or delivery approval (ADR-0006).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: {
            description: "Team page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Team") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
      post: {
        operationId: "createWorkspaceTeam",
        summary: "Create a team (owner/admin)",
        description:
          "Owner/admin only. Leaders must be active workspace members — a " +
          "leader outside the workspace is 422 TEAM_LEADER_NOT_MEMBER.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "leader_user_id"],
                properties: {
                  name: { type: "string" },
                  leader_user_id: { type: "string" },
                  responsibility: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Team created", ...jsonRef("#/components/schemas/Team") },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          422: errorResponse("TEAM_LEADER_NOT_MEMBER — the leader is not an active member"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/teams/{team_id}": {
      get: {
        operationId: "getWorkspaceTeam",
        summary: "Read one team",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "team_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Team", ...jsonRef("#/components/schemas/Team") },
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
      patch: {
        operationId: "updateWorkspaceTeam",
        summary: "Update a team (owner/admin)",
        description:
          "Owner/admin only. A leader change re-checks that the new leader is " +
          "an active workspace member (422 TEAM_LEADER_NOT_MEMBER). " +
          "`responsibility` accepts a string to set and null to clear.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "team_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version"],
                properties: {
                  name: { type: "string" },
                  leader_user_id: { type: "string" },
                  responsibility: {
                    type: ["string", "null"],
                    description: "Set a responsibility description/path mapping; null clears it.",
                  },
                  version: {
                    type: "integer",
                    description: "The resource's current version (optimistic concurrency).",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Team after update", ...jsonRef("#/components/schemas/Team") },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          409: errorResponse("VERSION_CONFLICT"),
          422: errorResponse("TEAM_LEADER_NOT_MEMBER — the leader is not an active member"),
        },
      },
      delete: {
        operationId: "deleteWorkspaceTeam",
        summary: "Delete a team (owner/admin)",
        description: "Owner/admin only. Deletion never affects memberships or repository access.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          { name: "team_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          204: { description: "Team deleted" },
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/invitations": {
      get: {
        operationId: "listInvitations",
        summary: "List invitations (owner/admin; token-free)",
        description:
          "Only the create response ever carries the bearer token; every " +
          "listed invitation is token-free and cannot be used to derive it. " +
          "Ordered by creation time, newest first.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: {
            description: "Invitation page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Invitation") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
      post: {
        operationId: "createInvitation",
        summary: "Create an owner-created invitation (owner/admin)",
        description:
          "Owner/admin only. Creates the opaque bearer invitation (at least " +
          "128 bits of random entropy, stored server-side only as a keyed " +
          "digest). Defaults (ADR-0006): 24-hour expiry, one redemption, " +
          "`member` role only; an owner may only shorten `expires_in_seconds` " +
          "or bind a verified provider subject. The response is the ONLY " +
          "place the raw token ever appears. Rate-limited by actor and " +
          "request origin; the token is never echoed in errors, logs, " +
          "telemetry, or analytics.",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  expires_in_seconds: {
                    type: "integer",
                    minimum: 1,
                    maximum: 86400,
                    description:
                      "Shorten the default 24-hour expiry; values above the " +
                      "default are rejected.",
                  },
                  bound_provider_subject: {
                    type: "string",
                    description:
                      "Bind redemption to this verified provider subject; " +
                      "forwarded or wrong-subject use then stays denied.",
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Created invitation — bearer token shown exactly once",
            ...jsonRef("#/components/schemas/CreatedInvitation"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
          429: errorResponse("RATE_LIMITED"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}": {
      delete: {
        operationId: "revokeInvitation",
        summary: "Revoke an invitation (owner/admin)",
        description:
          "Owner/admin only. Revocation is immediate and idempotent; an " +
          "already-revoked or consumed invitation returns 204 without effect. " +
          "Invitations never outlive the inviter's authority: outstanding " +
          "invitations become non-redeemable once their creator loses current " +
          "repository administration authority (ADR-0006).",
        parameters: [
          { name: "workspace_id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "invitation_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          204: { description: "Invitation revoked or already inactive" },
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND"),
        },
      },
    },
    "/api/v1/invitations/preview": {
      post: {
        operationId: "previewInvitation",
        summary: "Preview an invitation for the join-confirmation screen",
        description:
          "Authenticated. The bearer token is submitted in this POST body " +
          "only — never in a URL, never on GET: link previews and security " +
          "scanners hitting the landing page consume and learn nothing " +
          "(ADR-0006). Shows what the explicit join would grant and runs live " +
          "eligibility checks WITHOUT consuming the invitation. Every " +
          "non-consumable state — unknown, expired, revoked, already " +
          "consumed, wrong-subject for a bound invitation, ineligible or " +
          "already-member invitee — is the same 403 INVITATION_NOT_ACCEPTED: " +
          "the caller cannot enumerate which condition failed. Rate-limited " +
          "by actor and request origin; the token is never echoed in errors, " +
          "logs, or analytics.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: {
                  token: {
                    type: "string",
                    description:
                      "The opaque bearer invitation from the QR URL fragment " +
                      "or the grouped copyable code (same value).",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Preview of the join",
            ...jsonRef("#/components/schemas/InvitationPreview"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED — login is always required"),
          403: errorResponse("INVITATION_NOT_ACCEPTED"),
          429: errorResponse("RATE_LIMITED"),
        },
      },
    },
    "/api/v1/invitations/redeem": {
      post: {
        operationId: "redeemInvitation",
        summary: "Redeem an invitation: the explicit join confirmation",
        description:
          "Authenticated. Consumes the invitation in one transaction: " +
          "expiry, revocation, remaining uses, the intended " +
          "enterprise/workspace/subject, the inviter's current authority, " +
          "existing membership, and the invitee's current repository access " +
          "are checked, then the `member` membership is added and the " +
          "invitation consumed atomically. Concurrent redeemers cannot both " +
          "succeed. The same subject retrying their own redemption is an " +
          "idempotent replay of the join (200, never a second join); every " +
          "other failure is the same non-enumerating 403 " +
          "INVITATION_NOT_ACCEPTED — unknown, expired, revoked, consumed, " +
          "wrong-subject, ineligible, and already-member are " +
          "indistinguishable. Workspace scope comes from the invitation " +
          "itself, never from client input. The invitation grants no " +
          "repository access; the membership does. Login alone or possession " +
          "of a leaked code never grants access. Rate-limited by actor and " +
          "request origin; the token is never echoed in errors, logs, or " +
          "analytics.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: {
                  token: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Joined — idempotent for the redeeming subject's retries",
            ...jsonRef("#/components/schemas/InvitationRedemption"),
          },
          400: errorResponse("INVALID_REQUEST"),
          401: errorResponse("UNAUTHENTICATED — login is always required"),
          403: errorResponse("INVITATION_NOT_ACCEPTED"),
          429: errorResponse("RATE_LIMITED"),
        },
      },
    },
    // --- Collaboration v1: issues, tasks, runs, candidates, approvals,
    //     deliveries, and the issue event stream (DAT-221, ADR-0007) -------

    "/api/v1/workspaces/{workspace_id}/issues": {
      get: {
        operationId: "listIssues",
        summary: "List the workspace's issues (workbench)",
        description:
          "Exactly the issues visible in the caller's authenticated workspace " +
          "scope, newest first, with opaque cursor pagination. `product_state` " +
          "filters by product stage (never by harness run state).",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          CURSOR_PARAMETER,
          {
            name: "product_state",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...PRODUCT_STATES] },
            description: "Only issues currently in this product stage.",
          },
        ],
        responses: {
          200: {
            description: "Issue page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Issue") },
            },
          },
          400: errorResponse("INVALID_CURSOR or INVALID_REQUEST"),
          404: errorResponse(
            "NOT_FOUND — non-enumerating: the workspace is not visible to the caller",
          ),
        },
      },
      post: {
        operationId: "createIssue",
        summary: "Submit an issue manually",
        description:
          "Manual issue submission (ADR-0007). The service derives the dedupe " +
          "fingerprint and owns routing: the response is the durable issue, not " +
          "an assignee assertion. A repeated signal or resubmission for the same " +
          "repository and source reference is 409 ISSUE_DEDUPE_CONFLICT with " +
          "`details.existing_issue_id` instead of spawning a second issue.",
        parameters: [WORKSPACE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["repository_id", "base_ref", "summary"],
                properties: {
                  repository_id: {
                    type: "string",
                    description: "Immutable provider repository id bound to the workspace.",
                  },
                  base_ref: { type: "string", examples: ["main"] },
                  summary: { type: "string" },
                  source_reference: {
                    type: ["string", "null"],
                    description: "Immutable report/signal reference; never a grant.",
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Issue created", ...jsonRef("#/components/schemas/Issue") },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse("FORBIDDEN"),
          404: errorResponse("NOT_FOUND — the repository is not bound to this workspace"),
          409: errorResponse(
            "ISSUE_DEDUPE_CONFLICT — the fingerprint already maps to an open " +
              "issue (`details.existing_issue_id`) — or IDEMPOTENCY_CONFLICT",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}": {
      get: {
        operationId: "getIssue",
        summary: "Read one issue",
        description:
          "404 ISSUE_NOT_FOUND is uniform — nonexistent, in another workspace, " +
          "or not visible to the caller — and reveals no other issue's existence.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER],
        responses: {
          200: { description: "Issue", ...jsonRef("#/components/schemas/Issue") },
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/stage": {
      get: {
        operationId: "getIssueStage",
        summary: "Read the issue's product stage and its allowed transitions",
        description:
          "The product lifecycle stage with the exact outgoing edges the " +
          "workbench may render. Product stages are distinct from harness run " +
          "states; `awaiting_change_approval` means an immutable candidate " +
          "awaits a human change approval and no PR exists.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER],
        responses: {
          200: { description: "Issue stage", ...jsonRef("#/components/schemas/IssueStage") },
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
      post: {
        operationId: "transitionIssueStage",
        summary: "Move the issue to another product stage",
        description:
          "Applies one edge of the ADR-0007 stage table. The service — not the " +
          "client — enforces the edge, the product/harness consistency rules, " +
          "and the candidate requirement: `awaiting_change_approval` requires a " +
          "stopped preparation run that preserved a candidate, `pr_review` " +
          "requires an observed PR, and `completed` requires a provider- " +
          "confirmed merge. Leaving `needs_human` requires a recorded human " +
          "disposition; it is a stop outcome, never a retry of the stopped run. " +
          "A `needs_human` or `cancelled` transition revokes the issue's " +
          "remaining grants.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to"],
                properties: {
                  to: { type: "string", enum: [...PRODUCT_STATES] },
                  reason: {
                    type: ["string", "null"],
                    description: "Required for a stop or cancellation.",
                  },
                  disposition: {
                    type: "object",
                    description:
                      "Human disposition reference required when leaving " +
                      "`needs_human`; the actor is the authenticated caller.",
                    required: ["reference"],
                    properties: { reference: { type: "string" } },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Issue stage after the transition",
            ...jsonRef("#/components/schemas/IssueStage"),
          },
          400: errorResponse("INVALID_REQUEST"),
          404: errorResponse("ISSUE_NOT_FOUND"),
          409: errorResponse(
            "TRANSITION_FORBIDDEN, PRODUCT_HARNESS_CONFLICT — the target stage " +
              "contradicts the observed harness states — or IDEMPOTENCY_CONFLICT",
          ),
          428: errorResponse(
            "DISPOSITION_REQUIRED — leaving `needs_human` needs a recorded human " +
              "disposition; category `stop`, not retryable",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks": {
      get: {
        operationId: "listIssueTasks",
        summary: "List the issue's child tasks",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, CURSOR_PARAMETER],
        responses: {
          200: {
            description: "Task page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/IssueTask") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
      post: {
        operationId: "addIssueTask",
        summary: "Add a child task to the issue",
        description:
          "Routing a bounded unit of work to a Pi role. Dependencies must name " +
          "tasks of the same issue and must not form a cycle.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["role"],
                properties: {
                  role: { type: "string", enum: [...ROLES] },
                  assignee_agent_id: { type: ["string", "null"] },
                  depends_on: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Task added", ...jsonRef("#/components/schemas/IssueTask") },
          400: errorResponse("INVALID_REQUEST"),
          404: errorResponse("ISSUE_NOT_FOUND"),
          409: errorResponse("TASK_DEPENDENCY_INVALID or IDEMPOTENCY_CONFLICT"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks/{task_id}": {
      get: {
        operationId: "getIssueTask",
        summary: "Read one child task",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Task", ...jsonRef("#/components/schemas/IssueTask") },
          404: errorResponse("TASK_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/tasks/{task_id}/state": {
      post: {
        operationId: "setIssueTaskState",
        summary: "Move a child task to another state",
        description:
          "A task with unfinished dependencies cannot leave `open` " +
          "(409 TASK_BLOCKED), and a terminal state has no outgoing edge.",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "task_id", in: "path", required: true, schema: { type: "string" } },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["to"],
                properties: { to: { type: "string", enum: [...TASK_STATES] } },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Task after the transition",
            ...jsonRef("#/components/schemas/IssueTask"),
          },
          400: errorResponse("INVALID_REQUEST"),
          404: errorResponse("TASK_NOT_FOUND"),
          409: errorResponse("TASK_STATE_CONFLICT, TASK_BLOCKED, or IDEMPOTENCY_CONFLICT"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/runs": {
      get: {
        operationId: "listIssueRuns",
        summary: "List the issue's bounded remediation runs",
        description:
          "Runs in creation order, including terminal attempts. Each run's " +
          "`state` is the observed harness state; a terminal run never resumes.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, CURSOR_PARAMETER],
        responses: {
          200: {
            description: "Run page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/IssueRun") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
      post: {
        operationId: "openIssueRun",
        summary: "Open a bounded remediation run for the issue",
        description:
          "Records one bounded attempt: role, isolated worktree, tool/path/" +
          "network scope, and duration/resource/token limits. The service " +
          "allocates the worktree and resolves the issue's repository binding; " +
          "the run begins in harness state `requested` and dsh remains the " +
          "execution gate — opening a run grants nothing. Terminal or cancelled " +
          "issues cannot open runs (409 RUN_OPEN_FORBIDDEN).",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["role", "scope", "limits"],
                properties: {
                  task_id: { type: ["string", "null"] },
                  role: { type: "string", enum: [...ROLES] },
                  scope: { $ref: "#/components/schemas/RunScope" },
                  limits: { $ref: "#/components/schemas/RunLimits" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Run opened", ...jsonRef("#/components/schemas/IssueRun") },
          400: errorResponse("INVALID_REQUEST"),
          404: errorResponse("ISSUE_NOT_FOUND or TASK_NOT_FOUND"),
          409: errorResponse("RUN_OPEN_FORBIDDEN or IDEMPOTENCY_CONFLICT"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/runs/{run_id}": {
      get: {
        operationId: "getIssueRun",
        summary: "Read one run with its lease, grants, and artifacts",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "run_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Run", ...jsonRef("#/components/schemas/IssueRun") },
          404: errorResponse("RUN_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/candidates": {
      get: {
        operationId: "listIssueCandidates",
        summary: "List the issue's frozen candidates",
        description:
          "Immutable candidates in freeze order. A candidate is produced by the " +
          "service when local preparation stops; it is never client-authored or " +
          "client-mutated.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, CURSOR_PARAMETER],
        responses: {
          200: {
            description: "Candidate page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Candidate") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/candidates/{candidate_id}": {
      get: {
        operationId: "getIssueCandidate",
        summary: "Read one candidate — the review card's source",
        description:
          "The full summary/diff/test/risk/provenance record the pre-PR " +
          "reviewer confirms. Reading it never grants approval authority.",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "candidate_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Candidate", ...jsonRef("#/components/schemas/Candidate") },
          404: errorResponse("CANDIDATE_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/approvals": {
      get: {
        operationId: "listIssueApprovals",
        summary: "List the issue's approval requests",
        description:
          "Candidate-bound approval requests, including invalidated, expired, " +
          "rejected, and consumed history; only a `pending` request addressed to " +
          "the caller is actionable.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, CURSOR_PARAMETER],
        responses: {
          200: {
            description: "Approval page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Approval") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/approvals/{approval_id}": {
      get: {
        operationId: "getIssueApproval",
        summary: "Read one approval request",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "approval_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Approval", ...jsonRef("#/components/schemas/Approval") },
          404: errorResponse("APPROVAL_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/approvals/{approval_id}/decision": {
      post: {
        operationId: "decideIssueApproval",
        summary: "Record the approver's confirmed decision on a candidate",
        description:
          "The one pre-PR human approval gate. The approver is the " +
          "authenticated caller: agents cannot approve their own work, and a " +
          "body field can never assert an identity. `diff_digest` must equal the " +
          "candidate's reviewed diff digest — approving a different revision is " +
          "409 APPROVAL_BINDING_STALE, and a stale, invalidated, expired, " +
          "consumed, or already-decided request is 409 APPROVAL_STATE_CONFLICT. " +
          "A `reject` decision refuses delivery for that candidate; a new " +
          "candidate requires a new request.",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "approval_id", in: "path", required: true, schema: { type: "string" } },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["decision", "diff_digest"],
                properties: {
                  decision: { type: "string", enum: ["approve", "reject"] },
                  diff_digest: {
                    $ref: "#/components/schemas/Digest",
                  },
                  note: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Approval after the decision",
            ...jsonRef("#/components/schemas/Approval"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse(
            "FORBIDDEN — the caller is not the addressed approver or lacks " +
              "current repository access/approval authority",
          ),
          404: errorResponse("APPROVAL_NOT_FOUND"),
          409: errorResponse(
            "APPROVAL_BINDING_STALE, APPROVAL_STATE_CONFLICT, or IDEMPOTENCY_CONFLICT",
          ),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries": {
      get: {
        operationId: "listIssueDeliveries",
        summary: "List the issue's delivery operations",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, CURSOR_PARAMETER],
        responses: {
          200: {
            description: "Delivery page",
            content: {
              "application/json": { schema: pageSchema("#/components/schemas/Delivery") },
            },
          },
          400: errorResponse("INVALID_CURSOR"),
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
      post: {
        operationId: "requestIssueDelivery",
        summary: "Request broker-controlled delivery for an approved candidate",
        description:
          "Records the delivery operation (identity and intention) before any " +
          "provider write and returns it in state `pending`; the trusted broker " +
          "performs the push/PR. Delivery requires a current, valid " +
          "candidate-bound approval (409 APPROVAL_NOT_APPROVED) — an assignee, " +
          "blame author, or team leader is never sufficient — and consumes that " +
          "approval: reusing a consumed approval is 409 APPROVAL_CONSUMED. A " +
          "safe retry with the same Idempotency-Key reconciles the same " +
          "operation instead of creating a second branch/PR. No direct main " +
          "write, merge, self-review, or check waiver exists.",
        parameters: [WORKSPACE_ID_PARAMETER, ISSUE_ID_PARAMETER, IDEMPOTENCY_KEY_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["approval_id"],
                properties: { approval_id: { type: "string" } },
              },
            },
          },
        },
        responses: {
          202: {
            description: "Delivery operation recorded",
            ...jsonRef("#/components/schemas/Delivery"),
          },
          400: errorResponse("INVALID_REQUEST"),
          403: errorResponse(
            "FORBIDDEN — missing delivery authority, unsupported governance, or " +
              "missing integration permissions; delivery stays blocked",
          ),
          404: errorResponse("ISSUE_NOT_FOUND or APPROVAL_NOT_FOUND"),
          409: errorResponse("APPROVAL_NOT_APPROVED, APPROVAL_CONSUMED, or IDEMPOTENCY_CONFLICT"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries/{delivery_id}": {
      get: {
        operationId: "getIssueDelivery",
        summary: "Read one delivery operation and its provider evidence",
        description:
          "`state` distinguishes success (`delivered`), an explicit partial " +
          "outcome (`partial`: branch pushed, PR creation failed or unconfirmed), " +
          "and an unknown provider outcome (`unknown`: reconcile before any " +
          "further write — never auto-retried). `delivered` is not a merge and " +
          "never claims production recovery.",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "delivery_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Delivery", ...jsonRef("#/components/schemas/Delivery") },
          404: errorResponse("DELIVERY_NOT_FOUND"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries/{delivery_id}/reconcile": {
      post: {
        operationId: "reconcileIssueDelivery",
        summary: "Reconcile an ambiguous delivery outcome against provider evidence",
        description:
          "The only path out of `unknown` (and a supported retry out of " +
          "`partial`): the service re-reads branch and provider operation " +
          "evidence for this operation and records the reconciled state before " +
          "any further write, so retries never duplicate a PR. Reconciliation " +
          "is an `unknown`-outcome remedy, not a bounded retry: the request is " +
          "never automatically retried. A delivery with nothing to reconcile is " +
          "409 DELIVERY_STATE_CONFLICT.",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          { name: "delivery_id", in: "path", required: true, schema: { type: "string" } },
          IDEMPOTENCY_KEY_PARAMETER,
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { note: { type: ["string", "null"] } },
              },
            },
          },
        },
        responses: {
          202: {
            description: "Reconciliation recorded",
            ...jsonRef("#/components/schemas/Delivery"),
          },
          404: errorResponse("DELIVERY_NOT_FOUND"),
          409: errorResponse("DELIVERY_STATE_CONFLICT or IDEMPOTENCY_CONFLICT"),
          502: errorResponse("PROVIDER_ERROR — retryable; no write was performed"),
        },
      },
    },
    "/api/v1/workspaces/{workspace_id}/issues/{issue_id}/stream": {
      get: {
        operationId: "streamIssueEvents",
        summary:
          "SSE stream of issue events; replays by Last-Event-ID from the durable " +
          "projection in sequence order, with replay-stable event ids",
        description:
          "Reconnecting clients send the last delivered `event_id` in " +
          "`Last-Event-ID`; the service replays every later event from the " +
          "durable projection — including events written while disconnected and " +
          "across orchestrator restarts — without duplicating or dropping a " +
          "business event. Delivery is at least once and `event_id` is stable " +
          "across replays (the consumer's idempotency key), so a client " +
          "deduplicates on `event_id` and orders on `sequence`. An unknown id " +
          "replays from the start of the retained log. The stream closes after " +
          "`issue.terminal`, including when the anchor is already terminal.",
        parameters: [
          WORKSPACE_ID_PARAMETER,
          ISSUE_ID_PARAMETER,
          {
            name: "Last-Event-ID",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Replay events after this event_id; unknown ids replay from the start.",
          },
        ],
        responses: {
          200: {
            description:
              "text/event-stream. Each frame carries id (event_id), the event " +
              "type, and data: the IssueEvent envelope. The stream ends after " +
              "issue.terminal.",
            content: {
              "text/event-stream": {
                schema: { $ref: "#/components/schemas/IssueEvent" },
              },
            },
          },
          404: errorResponse("ISSUE_NOT_FOUND"),
        },
      },
    },
  };

  // Stamp the security requirement and 401 response onto every operation so
  // auth coverage cannot silently miss an endpoint.
  stampAuth(paths);

  return {
    openapi: "3.1.0",
    info: {
      title: "ForgePilot orchestrator API",
      version: "0.9.0",
      description:
        "forgepilot-api/v1: the Node-to-UI contract of the ForgePilot pilot, the " +
        "enterprise identity surface (DAT-202, ADR-0006), and the workspace, " +
        "team, member, and invitation surface (DAT-205). The UI calls Node only; " +
        "it never sees dsh sockets, boot tokens, Pi credentials, raw tool output, " +
        "or provider credentials. Pi text is displayed only through the " +
        "fail-closed pi_summary contract (DAT-191), whose classification " +
        "boundary is DAT-192, whose trusted-source display boundary is DAT-193, " +
        "and whose verifiable provenance record and read-side gate are DAT-194. " +
        "Every error uses the shared versioned envelope (DAT-226 alignment, " +
        "docs/contracts/error-envelope-v1.md vocabulary); authentication " +
        "failures and cross-scope reads are non-enumerating; session " +
        "invalidation terminates SSE subscriptions; and enterprise/workspace " +
        "scope is always resolved server-side from authenticated membership — " +
        "client-supplied identifiers never grant access. The collaboration " +
        "surface (DAT-221, ADR-0007) defines durable issues, child tasks, bounded " +
        "runs, immutable candidates, candidate-bound human pre-PR approvals, " +
        "and broker-controlled deliveries; this contract is merged ahead of its " +
        "serving implementation so dependent web work never invents fields, and " +
        "it claims no running control until that implementation lands. Product " +
        "stages and harness run " +
        "states are separate vocabularies, and its outcome semantics are " +
        "explicit: a `stopped` run or `needs_human` stop is a `stop` category — " +
        "not retryable, requiring human disposition and a fresh run/grant; an " +
        "`unknown` provider/delivery outcome is the `unknown` category — never " +
        "auto-retried and requiring reconciliation before further writes; only " +
        "service-decided bounded retries are `retry`, with `retryable` and " +
        "`retry_after_seconds` on the shared envelope. Mutating collaboration " +
        "commands are replay-safe by `Idempotency-Key`, and the issue SSE " +
        "stream replays by `Last-Event-ID` with replay-stable event ids. " +
        "Generated from the " +
        "orchestrator implementation; shapes are defined by " +
        "docs/contracts/forgepilot-api-v1.md.",
    },
    servers: [{ url: "http://127.0.0.1", description: "Ephemeral loopback bind" }],
    security: BEARER_SECURITY,
    paths,
    components: {
      schemas: {
        Task: taskSchema,
        TaskEvent: taskEventSchema,
        PiSummary: piSummarySchema,
        PiSummarySource: piSummarySourceSchema,
        TurnReport: turnReportSchema,
        RunSummary: runSummarySchema,
        ArtifactMetadata: artifactMetadataSchema,
        User: userSchema,
        UserRef: userRefSchema,
        UserIdentity: userIdentitySchema,
        EnterpriseRef: enterpriseRefSchema,
        Workspace: workspaceSchema,
        WorkspaceRef: workspaceRefSchema,
        WorkspaceRepository: workspaceRepositorySchema,
        Membership: membershipSchema,
        MemberAuthority: memberAuthoritySchema,
        MemberCandidate: memberCandidateSchema,
        Team: teamSchema,
        Invitation: invitationSchema,
        CreatedInvitation: createdInvitationSchema,
        InvitationPreview: invitationPreviewSchema,
        InvitationRedemption: invitationRedemptionSchema,
        WorkspaceScope: workspaceScopeSchema,
        IssueRepository: issueRepositorySchema,
        Digest: digestSchema,
        ArtifactReference: artifactReferenceSchema,
        Issue: issueSchema,
        IssueStage: issueStageSchema,
        IssueTask: issueTaskSchema,
        RunWorktree: runWorktreeSchema,
        RunScope: runScopeSchema,
        RunLimits: runLimitsSchema,
        RunLease: runLeaseSchema,
        RunGrant: runGrantSchema,
        IssueRun: issueRunSchema,
        ValidationResult: validationResultSchema,
        ChangeRisk: changeRiskSchema,
        Candidate: candidateSchema,
        ApprovalBinding: approvalBindingSchema,
        ApprovalDecision: approvalDecisionSchema,
        Approval: approvalSchema,
        Delivery: deliverySchema,
        IssueEvent: issueEventSchema,
        SessionInfo: sessionInfoSchema,
        LoginProvider: loginProviderSchema,
        ProviderInstance: providerInstanceSchema,
        DesktopFlow: desktopFlowSchema,
        AuthAuditRecord: authAuditRecordSchema,
        Error: errorSchema,
      },
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Authorization: Bearer <token>. Either the per-process API token, " +
            "minted at orchestrator start and written 0600 to the API token " +
            "file (possession authorizes acting as the local operator, " +
            "approvals included), or a desktop session token issued by the " +
            "single-use desktop exchange. Web clients use the session cookie " +
            "instead.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "fp_session",
          description:
            "Server-side web session in an HttpOnly, SameSite=Lax cookie. " +
            "Cookie-authenticated mutating requests must echo the session's " +
            "CSRF token in the X-CSRF-Token header. Logout, suspension, and " +
            "membership revocation invalidate it immediately.",
        },
        bootstrapToken: {
          type: "apiKey",
          in: "header",
          name: "X-Bootstrap-Token",
          description:
            "Deployment-owned bootstrap secret (FORGEPILOT_BOOTSTRAP_TOKEN). " +
            "The only authority for the first provider-instance approval and " +
            "the one-time first-enterprise-administrator grant; every use is " +
            "audited and the token never appears in logs or audit details.",
        },
      },
    },
  };
}
