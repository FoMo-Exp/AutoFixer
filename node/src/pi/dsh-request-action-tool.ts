import { createHash, randomUUID } from "node:crypto";

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { DshClient } from "../dsh/client.js";
import { DshError } from "../dsh/client.js";
import type { DshState } from "../dsh/types.js";
import type {
  DeniedCapability,
  DiagnosticsVault,
  ErrorEnvelope,
  RetryDecision,
} from "../errors/index.js";
import {
  RetryGovernor,
  buildErrorEnvelope,
  mapDshError,
  mapForeignError,
  renderAgentError,
  sealDiagnostics,
} from "../errors/index.js";

export const dshRequestActionSchema = Type.Object({
  tool_id: Type.String({
    description:
      'Registered dsh tool identity to request, for example "echo" or "sleep". Never a shell or command name.',
  }),
  arguments: Type.Record(Type.String(), Type.Unknown(), {
    description:
      "Structured arguments for the requested tool; each value must be an allowed enum member.",
  }),
  path_scope: Type.Array(Type.String(), {
    minItems: 1,
    description: "Repository-relative paths this action touches. Missing scope means denied.",
  }),
  network_destinations: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Network destinations this action needs. Normally empty; anything outside the grant is denied.",
    }),
  ),
  rationale: Type.String({
    description: "Why this action is needed for the task.",
  }),
});

export type DshRequestActionParams = Static<typeof dshRequestActionSchema>;

export interface DshRequestActionDetails {
  action_id: string;
  state?: DshState;
  audit_event_reference?: string;
}

/** One observed dsh decision for a requested action, forwarded to the task timeline. */
export interface ActionObservation {
  toolCallId: string;
  toolId: string;
  pathScope: string[];
  outcome: "accepted" | "denied";
  actionId: string;
  state?: DshState;
  /** dsh audit event reference for an accepted action (drives evidence.appended). */
  auditEventReference?: string;
  /** Origin (dsh) error code of a denial, kept for correlation. */
  errorCode?: string;
  /** Safe message from the shared error envelope; never raw diagnostics. */
  errorMessage?: string;
  /** The shared error envelope rendered for this denial. */
  errorEnvelope?: ErrorEnvelope;
}

export type ActionObserver = (observation: ActionObservation) => void;

export interface DshRequestActionToolOptions {
  client: DshClient;
  runId: string;
  /** Pi session identifier recorded on every submitted intent. */
  sessionId: string;
  /** Turn identifier recorded on every submitted intent. */
  getTurnId: () => string;
  /** Sink for accepted/denied observations; DI boundary for the task event log. */
  observe: ActionObserver;
  /**
   * Optional holder for sealed sensitive diagnostics (DAT-226). Raw failure
   * detail lands here — behind its own access check — instead of the task
   * timeline or the model-facing error text.
   */
  diagnostics?: DiagnosticsVault;
  /**
   * Service-side retry authority (DAT-226). Defaults to a per-run
   * {@link RetryGovernor}: it — not the model — decides retry eligibility and
   * enforces the attempt and time limits at this retry entry.
   */
  retryGovernor?: RetryGovernor;
  /** Deadline (ms epoch) after which no retry is authorized for this run. */
  deadlineMs?: number;
  /**
   * Service-imposed delay (ms) before an authorized retry may run. The
   * resulting `retry_after_ms` is enforced: a re-invocation before it is
   * blocked and told how long to wait.
   */
  retryDelayMs?: number;
  /**
   * Verified fact passed by the service: an uncertain mutation exists for
   * this run's sandbox work. Only an explicit `false` permits a guarded
   * (SANDBOX_UNAVAILABLE) retry; absent means the conservative answer.
   */
  uncertainMutation?: boolean;
}

/** Stable identity of the intent being retried: same tool, arguments and scope. */
function intentCaseId(runId: string, params: DshRequestActionParams): string {
  const identity = JSON.stringify({
    run_id: runId,
    tool_id: params.tool_id,
    arguments: canonicalize(params.arguments),
    path_scope: [...params.path_scope].sort(),
    network_destinations: [...(params.network_destinations ?? [])].sort(),
  });
  return `case_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

/** Key-sorted JSON so semantically identical arguments share one case. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** What the retry entry remembers about one failed intent. */
interface FailedCase {
  code: string;
  originCode: string | null;
  deniedCapability: DeniedCapability | null;
  uncertainMutation: boolean | undefined;
  decision: RetryDecision;
}

/**
 * The single Pi tool: an intent forwarder to dsh-control/v1.
 *
 * Pi holds no executor with this tool — no shell, no file edits, no network.
 * Every call becomes a structured action intent that dsh re-checks against the
 * run's allow-list and capability grant before anything runs. A dsh refusal is
 * returned to the model as an error result and observed by the task timeline,
 * so refusals surface in Node task state instead of silently disappearing.
 *
 * This tool is also the controlled retry entry for failed intents (DAT-226):
 * the {@link RetryGovernor} decides retry eligibility and enforces attempt
 * counting, the deadline, and `retry_after_ms` here. The gate is atomic per
 * case: a duplicate of an in-flight identical action is refused, a
 * re-invocation of an identical failed intent is blocked before dispatch
 * unless the service authorized that retry and its time has come, and every
 * dispatch (the first included) reserves one of the case's `maxAttempts`
 * total dispatch attempts before it goes out. Every envelope the model sees
 * reflects the actual service decision (`retryable` and `next_action`
 * included), never a model claim.
 */
export function createDshRequestActionTool(
  options: DshRequestActionToolOptions,
): AgentTool<typeof dshRequestActionSchema, DshRequestActionDetails> {
  const governor = options.retryGovernor ?? new RetryGovernor();
  const failedCases = new Map<string, FailedCase>();
  /** Cases with one dispatch currently in the air. Claimed and released
   * synchronously, so concurrent duplicates cannot double-dispatch. */
  const inFlight = new Set<string>();

  function blockedError(
    envelope: ErrorEnvelope,
    originCode: string | null,
    caseId: string,
    detail: string,
    toolCallId: string,
    params: DshRequestActionParams,
    actionId: string,
  ): Error {
    options.diagnostics?.record(sealDiagnostics({ caseRef: actionId, originCode, detail }));
    options.observe({
      toolCallId,
      toolId: params.tool_id,
      pathScope: params.path_scope,
      outcome: "denied",
      actionId,
      errorCode: originCode ?? envelope.code,
      errorMessage: envelope.message,
      errorEnvelope: envelope,
    });
    return new Error(renderAgentError(envelope, originCode));
  }

  function blockedByService(
    prior: FailedCase,
    caseId: string,
    toolCallId: string,
    params: DshRequestActionParams,
    actionId: string,
  ): Error {
    const nowMs = governor.now();
    const withinDeadline = options.deadlineMs === undefined || nowMs < options.deadlineMs;
    const authorizedAtMs = prior.decision.retry ? prior.decision.authorized_at_ms : null;
    const authorizedNow = authorizedAtMs !== null && withinDeadline;
    // Authorized, but not yet: keep the authorization visible and say how
    // long to wait. Anything else is not retryable any more.
    const tooEarly = authorizedNow && nowMs < authorizedAtMs;
    const retryAfterMs = tooEarly ? Math.max(0, authorizedAtMs - nowMs) : null;
    const envelope = buildErrorEnvelope({
      code: prior.code,
      caseRef: actionId,
      deniedCapability: prior.deniedCapability,
      retryAfterMs,
      facts: {
        serviceRetryAllowed: authorizedNow,
        ...(prior.uncertainMutation === undefined
          ? {}
          : { uncertainMutation: prior.uncertainMutation }),
      },
    });
    return blockedError(
      envelope,
      prior.originCode,
      caseId,
      `retry of ${caseId} blocked before dispatch by the retry authority`,
      toolCallId,
      params,
      actionId,
    );
  }

  /** The case spent its total dispatch budget: nothing is retryable any more. */
  function blockedExhausted(
    prior: FailedCase | null,
    caseId: string,
    toolCallId: string,
    params: DshRequestActionParams,
    actionId: string,
  ): Error {
    const envelope = buildErrorEnvelope({
      // Without a recorded failure the budget was spent by an interrupted
      // dispatch; the state conflict guidance is the honest fallback.
      code: prior?.code ?? "STATE_CONFLICT",
      caseRef: actionId,
      deniedCapability: prior?.deniedCapability ?? "run_state",
      facts: {
        serviceRetryAllowed: false,
        ...(prior?.uncertainMutation === undefined
          ? {}
          : { uncertainMutation: prior.uncertainMutation }),
      },
    });
    return blockedError(
      envelope,
      prior?.originCode ?? null,
      caseId,
      `dispatch of ${caseId} refused: the case's dispatch budget is exhausted`,
      toolCallId,
      params,
      actionId,
    );
  }

  /** A duplicate of an identical action that is still in the air. */
  function blockedDuplicate(
    caseId: string,
    toolCallId: string,
    params: DshRequestActionParams,
    actionId: string,
  ): Error {
    const envelope = buildErrorEnvelope({ code: "ACTION_IN_FLIGHT", caseRef: actionId });
    return blockedError(
      envelope,
      null,
      caseId,
      `duplicate dispatch of ${caseId} refused while the identical action is in flight`,
      toolCallId,
      params,
      actionId,
    );
  }

  return {
    name: "dsh_request_action",
    label: "Request a dsh action",
    description:
      "Request one allow-listed remediation action through the dsh control plane. " +
      "This is your only action capability: you cannot run commands, edit files, or " +
      "reach the network directly. dsh independently checks the run's allow-list and " +
      "capability grant, then executes the action in an isolated sandbox. A denied " +
      "request is final for that intent; adapt and continue or stop. Retries of a " +
      "failed intent are authorized by the service, not by you: an unauthorized or " +
      "early re-issue is refused without dispatch, and a duplicate of an action " +
      "that is still running is refused outright.",
    parameters: dshRequestActionSchema,
    execute: async (
      toolCallId: string,
      params: DshRequestActionParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<DshRequestActionDetails>> => {
      const actionId = `act_${randomUUID().replace(/-/g, "")}`;
      const caseId = intentCaseId(options.runId, params);
      const networkDestinations = params.network_destinations ?? [];

      // Controlled retry entry (DAT-226). The gate is synchronous — claim
      // and reservation are atomic within the process — so no interleaving
      // of callers can slip past it:
      // 1. an identical action still in the air is refused as a duplicate;
      // 2. an identical failed intent is only re-dispatched when the service
      //    authorized that retry and its time has come;
      // 3. every dispatch (the first included) reserves one of the case's
      //    maxAttempts total dispatch attempts before it goes out.
      if (inFlight.has(caseId)) {
        throw blockedDuplicate(caseId, toolCallId, params, actionId);
      }
      const prior = failedCases.get(caseId);
      if (prior !== undefined) {
        const nowMs = governor.now();
        const withinDeadline = options.deadlineMs === undefined || nowMs < options.deadlineMs;
        const authorizedNow =
          prior.decision.retry && withinDeadline && nowMs >= prior.decision.authorized_at_ms;
        if (!authorizedNow) {
          throw blockedByService(prior, caseId, toolCallId, params, actionId);
        }
      }
      const reservedAttempt = governor.reserveAttempt(caseId);
      if (reservedAttempt === null) {
        throw blockedExhausted(prior ?? null, caseId, toolCallId, params, actionId);
      }
      inFlight.add(caseId);

      try {
        const response = await options.client.submitAction(
          options.runId,
          {
            action_id: actionId,
            agent: {
              runtime: "pi",
              session_id: options.sessionId,
              turn_id: options.getTurnId(),
            },
            intent: {
              tool_id: params.tool_id,
              arguments: params.arguments,
              path_scope: params.path_scope,
              network_destinations: networkDestinations,
              rationale: params.rationale,
            },
          },
          actionId,
        );
        // Success closes the case: a later failure of the same intent starts
        // a fresh retry budget.
        failedCases.delete(caseId);
        governor.release(caseId);
        options.observe({
          toolCallId,
          toolId: params.tool_id,
          pathScope: params.path_scope,
          outcome: "accepted",
          actionId,
          state: response.state,
          auditEventReference: response.audit_event_reference,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `dsh accepted action ${actionId} for tool "${params.tool_id}" (run state: ${response.state}). ` +
                `Execution evidence: ${response.audit_event_reference}.`,
            },
          ],
          details: {
            action_id: response.action_id,
            state: response.state,
            audit_event_reference: response.audit_event_reference,
          },
        };
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        // Every failure the model sees is rendered from the shared error
        // envelope (DAT-226): safe catalog text, the service-decided next
        // action, and the origin code for correlation — never raw dsh
        // diagnostics, and never a model-chosen retry or widened grant.
        const originCode =
          error instanceof DshError
            ? error.code
            : error !== null &&
                typeof error === "object" &&
                typeof (error as { code?: unknown }).code === "string"
              ? String((error as { code: unknown }).code)
              : null;
        const mapped =
          error instanceof DshError
            ? mapDshError(error, { caseRef: actionId })
            : mapForeignError(error, { caseRef: actionId });
        // The producing service's own retry verdict is a fact; a model hint
        // is not, and none is consulted here.
        const serviceRetryAllowed =
          error !== null &&
          typeof error === "object" &&
          (error as { retryable?: unknown }).retryable === false
            ? false
            : undefined;
        const nowMs = governor.now();
        const decision = governor.decide({
          caseId,
          code: mapped.envelope.code,
          uncertainMutation: options.uncertainMutation,
          serviceRetryAllowed,
          notBeforeMs:
            options.retryDelayMs === undefined ? undefined : nowMs + options.retryDelayMs,
          deadlineMs: options.deadlineMs,
        });
        const retryAfterMs = decision.retry ? Math.max(0, decision.authorized_at_ms - nowMs) : null;
        // The envelope reflects the actual service decision: once the
        // governor refuses, `retryable` drops and `next_action` falls back to
        // the code's exhausted action.
        const envelope = buildErrorEnvelope({
          code: mapped.envelope.code,
          traceId: mapped.envelope.trace_ref.trace_id,
          caseRef: actionId,
          retryAfterMs: retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : null,
          deniedCapability: mapped.envelope.denied_capability,
          facts: {
            serviceRetryAllowed: decision.retry,
            ...(options.uncertainMutation === undefined
              ? {}
              : { uncertainMutation: options.uncertainMutation }),
          },
        });
        failedCases.set(caseId, {
          code: envelope.code,
          originCode,
          deniedCapability: envelope.denied_capability,
          uncertainMutation: options.uncertainMutation,
          decision,
        });
        options.diagnostics?.record(mapped.diagnostics);
        options.observe({
          toolCallId,
          toolId: params.tool_id,
          pathScope: params.path_scope,
          outcome: "denied",
          actionId,
          errorCode: originCode ?? envelope.code,
          errorMessage: envelope.message,
          errorEnvelope: envelope,
        });
        // Denied intents are thrown so the agent loop records an error tool
        // result: the model must see the refusal, and the task timeline has
        // already recorded it through observe().
        throw new Error(
          renderAgentError(envelope, originCode),
          error instanceof Error ? { cause: error } : undefined,
        );
      } finally {
        // The in-flight claim lasts exactly as long as the dispatch: a
        // duplicate arriving before this line never reaches dsh.
        inFlight.delete(caseId);
      }
    },
  };
}
