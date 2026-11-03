# Shared error envelope v1

**Contract version:** `1.0.0`

**Status:** implementation contract
**Normative source:** `docs/adr/0008-observability-errors-and-model-cost-accounting.md`
**Implementation:** `node/src/errors/` (catalog, envelope, retry, diagnostics, mapping) with tests in
`node/test/error-envelope.test.ts`, `node/test/error-retry.test.ts`, `node/test/error-mapping.test.ts`

This document defines the versioned error envelope every AutoFixer surface
shares (DAT-226): the stable machine vocabulary an agent acts on, and the safe
guidance a human reads. It is documentation of the shipped contract, not a
grant of authority. The words **MUST**, **MUST NOT**, and **MAY** are
normative.

## 1. Envelope

Every actionable failure renders as one envelope:

| Field | Meaning |
| --- | --- |
| `envelope_version` | Envelope schema version; current is `1`. |
| `code` | Stable machine code from the closed catalog. |
| `stage` | Where the failure occurred (`request`, `transport`, `gateway`, `policy`, `tool`, `validation`, `sandbox`, `usage`, `delivery`, `harness`, `service`). |
| `category` | Outcome class: `denial`, `stop`, `retry`, `unknown`. |
| `message` / `message_key` | Safe summary and its stable localization key. |
| `retryable` | Service-decided retry eligibility. |
| `retry_after_ms` | Earliest safe retry delay; `null` when retry is not eligible. |
| `trace_ref` | `{ trace_id, case_ref }` correlation; never the only guidance. |
| `next_action` | The single authorized next action (closed vocabulary). |
| `agent_guidance` / `agent_guidance_key` | Safe instruction for the agent. |
| `human_guidance` / `human_guidance_key` | Safe instruction for humans. |
| `denied_capability` | Denied capability category (`tool`, `arguments`, `path_scope`, `network`, `grant`, `run_state`, `policy`) or `null`. It names the refused capability, never the policy behind the refusal. |

The envelope carries no free-form detail field. Raw failure detail is sealed
diagnostics (§4) and never appears in an envelope, a task event, a model
result, or a metric label.

## 2. Closed code vocabulary and outcome classes

Codes are catalog-owned (`node/src/errors/catalog.ts`). A code outside the
catalog is refused loudly (`ErrorEnvelopeContractError`); surfaces map their
own vocabulary in first (§3). The seven ADR-0008 example codes, with the
agent/service action and human guidance this contract guarantees:

| Code | Category | Agent/service action (`next_action`) | Human guidance |
| --- | --- | --- | --- |
| `MODEL_RATE_LIMITED` | retry | `wait_and_retry` — bounded retry within grant, policy and budget; policy re-checked per invocation | Retry timing and provider status |
| `MODEL_USAGE_UNKNOWN` | unknown | `reconcile_usage` — estimates stay distinct from billed amounts; never assume zero | Missing metering and provisional totals |
| `TOOL_SCOPE_DENIED` | denial | `request_review` — stop; no argument-guessing loop to evade policy | Denied capability category and a review path |
| `VALIDATION_FAILED` | stop | `stop_run` — stop the current run; preserve test evidence | Failing checks and disposition options |
| `SANDBOX_UNAVAILABLE` | retry (guarded) | `block_execution` — bounded infrastructure retry only when no uncertain mutation exists | Environment identity and operator action |
| `SENSITIVE_DATA_UNCERTAIN` | denial | `enter_security_case` — no automatic retry or bypass (ADR-0005) | Authenticated security-case entry |
| `DELIVERY_OUTCOME_UNKNOWN` | unknown | `reconcile_delivery` — reconcile before any further write | Known side effects and reconciliation state |

Supporting codes distinguish the rest of the execution vocabulary:
`TRANSPORT_ERROR` (recoverable transport failure, category `retry`) is a
different code and a different category from `HARNESS_STOP_CONDITION` (category
`stop`); `MODEL_EGRESS_DENIED` keeps gateway policy denials as denials;
`MODEL_DISPATCH_FAILED` covers dispatch failures; `RISK_PROHIBITED`,
`APPROVAL_REQUIRED`, `INVALID_REQUEST`, `FORBIDDEN`, `STATE_CONFLICT`,
`RATE_LIMITED`, and `INTERNAL_ERROR` cover the request and policy refusals
surfaces actually map into.

Category semantics:

- `denial` — refused on policy/authorization grounds. Never retried with the
  same intent, never bypassed, never widened. A policy denial MUST NOT be
  rewritten as a generic server error.
- `stop` — the current run cannot continue as-is; stop and preserve evidence.
- `retry` — a bounded retry is authorized under service-enforced limits.
- `unknown` — outcome or side effects unknown; reconcile before further
  writes. Never auto-retried.

## 3. Mapping surface vocabulary in

`node/src/errors/map.ts` translates surface codes into the shared vocabulary:

- dsh-control/v1 codes map explicitly (`DSH_SCOPE_DENIED`/`DSH_POLICY_DENIED`/
  `DSH_TOOL_NOT_ALLOWLISTED`/`TOOL_NOT_REGISTERED` → `TOOL_SCOPE_DENIED`;
  `DSH_GRANT_EXPIRED`/`DSH_GRANT_REVOKED` → `HARNESS_STOP_CONDITION`;
  `DSH_UNAVAILABLE`/`DSH_EVIDENCE_STORE_UNAVAILABLE` → `TRANSPORT_ERROR`;
  `DSH_SANDBOX_UNAVAILABLE` → `SANDBOX_UNAVAILABLE`; and the rest of the
  contract's list).
- Codes without an explicit mapping fall back to the HTTP status class. Every
  authorization/policy refusal class (401/403/410/422/428) lands on a denial
  or human-decision outcome, so a denial is never laundered into
  `INTERNAL_ERROR` by being new. Only a genuine 5xx or unclassifiable failure
  becomes `INTERNAL_ERROR`.
- Trace-model codes map onto the same semantics
  (`TRACE_VALIDATION_FAILED` → `VALIDATION_FAILED`, and so on). Gateway codes
  (`MODEL_EGRESS_DENIED`, `MODEL_DISPATCH_FAILED`) are already shared codes.

The origin code and raw detail survive as sealed diagnostics and correlation
(`error_code` on `tool.denied` events stays the origin code); they never leak
into envelope texts.

## 4. Sensitive diagnostics behind a trusted authorizer

Raw failure detail is sealed at capture time (`sealDiagnostics`, which also
redacts secret-shaped material) and released only with a `DiagnosticGrant`
that a `DiagnosticsAuthorizer` minted after its server-side
`DiagnosticAccessPolicy` check:

- The caller names an authenticated **subject**, never a permission. The
  policy — injected at service bootstrap, fail-closed by default (`DENY_ALL_DIAGNOSTICS`) — decides; there is no caller-asserted boolean anywhere in
  the read path (`TaskService.readDiagnostics(subject, caseRef)` delegates to
  the authorizer).
- A grant is capability-shaped: only authorizer-minted instances are
  accepted. A caller-constructed `DiagnosticGrant`, a plain object, or
  another authorizer's grant is refused — before the record lookup, so an
  unauthorized caller cannot probe which cases exist either.
- Grants are bound to the authorizer that minted them; a vault only accepts
  its own authorizer's grants.

Reading a task, a timeline, or an envelope never implies diagnostics access.

## 5. Retry and stop semantics: the service decides

`RetryGovernor` is the retry authority. It derives eligibility from the
catalog (category and retry policy) plus verified service facts:

- A model hint (`RetryHint`) is recorded as ignored — `hint_ignored: true` —
  and cannot make a denial retryable, extend attempt or time limits, or widen
  a grant. No `NextAction` in the vocabulary widens or escalates a grant.
- Facts can only narrow eligibility: `uncertainMutation` gates
  `SANDBOX_UNAVAILABLE` retries (only an explicit "no uncertain mutation"
  permits one), and `serviceRetryAllowed: false` vetoes a bounded retry.
- Attempt limits are per case; the `deadlineMs` time budget is enforced, and a
  `retry_after_ms` that would fall past the deadline refuses as `deadline`
  instead of compressing the delay. Concurrent callers cannot exceed the
  attempt budget.
- Unknown outcomes (`MODEL_USAGE_UNKNOWN`, `DELIVERY_OUTCOME_UNKNOWN`) refuse
  with `unknown_requires_reconciliation`; harness stop conditions refuse with
  `stop_condition`; denials refuse with `denied`.

The governor is wired into the controlled retry entry — the
`dsh_request_action` tool (`node/src/pi/dsh-request-action-tool.ts`), the one
path where an agent can re-issue a failed intent:

- Every failure is adjudicated before the model sees it, and the envelope
  reflects the actual service decision: while the governor authorizes a
  bounded retry, `retryable` is true and `retry_after_ms` carries the
  service-imposed delay; once it refuses (exhausted, deadline, guard,
  denial), `retryable` drops and `next_action` falls back to the code's
  exhausted action.
- A re-invocation of an identical failed intent (same tool, arguments and
  scope — one case) is gated **before dispatch**: it runs only if the
  service authorized that retry, its `retry_after_ms` delay has passed, and
  the run deadline has not. Anything else is refused without a dsh call, so
  attempt counting, the deadline, and `retry_after_ms` are enforced at the
  entry, not merely described.
- A denied intent is final: an identical re-issue is blocked. A different
  intent is a different case and dispatches normally. A success closes the
  case and refunds its attempt budget.

## 6. Localization

Display text (`message`, `agent_guidance`, `human_guidance`) is localizable
through its stable `*_key`. `localizeError` swaps display strings only: the
machine code, stage, category, retry decision, and `next_action` never change
with a translation.

## 7. Schema versioning and migration

- Writers emit `ERROR_ENVELOPE_VERSION`.
- `migrateErrorEnvelope` upgrades an unversioned (v0) legacy `{ code }` record
  by rebuilding it from the catalog with neutral correlation fields. A record
  that already claims the current version is validated strictly — missing
  fields are rejected, never defaulted into existence.
- A newer envelope version is refused loudly instead of misread.

Migrations are additive; a shipped migration is never modified in place.

## 8. Surfaces

- **Agent:** the `dsh_request_action` tool renders every refusal (and every
  unexpected failure) as envelope text — safe message, the service-decided
  `next_action`, and agent guidance — with the origin code for correlation.
  Raw dsh detail never reaches the model, and no retry of a failed intent
  dispatches unless the governor authorized it (§5).
- **Humans:** `tool.denied` task events carry `error_envelope` (with the safe
  `message` and the origin `error_code`); the timeline shows actionable,
  non-secret guidance for every example error.
