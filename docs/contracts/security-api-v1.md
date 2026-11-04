# security-api/v1 — model egress, disposal cases, rule corrections, recovery, audit

The HTTP contract for ADR-0005. It is generated into
`web/src/api/contracts/openapi.json` from
`node/src/api/openapi-security.ts` and is the only contract the web client may
build against. `node/test/openapi.test.ts` fails when the committed document
drifts, and `node/test/security-api-fixtures.test.ts` validates every fixture
under `docs/fixtures/security-api-v1/` against the generated schemas with
closed objects.

All operations are workspace-scoped at
`/api/v1/workspaces/{workspace_id}/security`, authenticated with a session
cookie or bearer token, and mutating operations document `X-CSRF-Token`.
`workspace_id` is a path scope, never a body field: the server resolves it
against the caller's authenticated membership.

## 1. Case surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cases` | List redacted cases (newest first; filter by `state`, `run_id`, cursor). |
| `GET` | `/cases/{case_id}` | One redacted case with state, allowed transitions, and correlated block facts. |
| `POST` | `/cases/{case_id}/transitions` | Requested→handling→awaiting_review→resolved, with append-only history. |
| `POST` | `/cases/{case_id}/termination-requests` | Request termination (administrator-reviewed; never silent). |
| `POST` | `/cases/{case_id}/reassignment-requests` | Hand a case to another handler without granting review authority. |
| `POST` | `/cases/{case_id}/quarantine-grants` | Grant temporary, audited access to quarantined content. |
| `POST` | `/quarantine/{quarantine_id}/views` | View quarantined content under a live grant; every attempt is audited. |

States are `pending`, `handling`, `awaiting_review`, `resolved`, `terminated`;
the contract narrows `allowed_transitions` to the same enum. Ownership alone
never dispositions a case: a resolved case requires an independent reviewer
who differs from the handler and the author. Case records never carry
quarantined content, secret values, or detector patterns.

## 2. Rule-correction surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/rules` | List revisions by lineage with lifecycle state. |
| `POST` | `/rules/proposals` | Propose a bounded constraint revision (detector id, constraints, reason, `expires_at`, `review_at`). |
| `POST` | `/rules/{lineage}/revisions/{version}/reviews` | Independent review (approve/reject); the reviewer must differ from the author and every handling principal. |
| `POST` | `/rules/{lineage}/revisions/{version}/activation` | Administrator activation after a completed independent review and re-verified regression evidence. |
| `POST` | `/rules/{lineage}/rollbacks` | Roll back the active revision; the prior version stays reachable and audited. |

`lineage` is the URL-encoded `detector_id|enterprise_id|workspace_id`.
Corrections are versioned and never mutate an active revision in place. A
proposal body cannot assert its own regression evidence or its own scope, and
no operation accepts a client-supplied `enterprise_id` or `workspace_id`.
Revisions expire at `expires_at` and are re-reviewed at `review_at`.

## 3. One-time recovery surface

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/cases/{case_id}/recovery-approvals` | Bind a recovery approval to a destination and short TTL (`ttl_seconds`), after handling and independent review. |
| `GET` | `/recovery-approvals/{authorization_id}` | Read the bound facts and state. |
| `DELETE` | `/recovery-approvals/{authorization_id}` | Revoke an unconsumed approval. |
| `POST` | `/recovery-approvals/{authorization_id}/dispatch` | Recheck the complete rebuilt request and dispatch once. |

Approval state is `approved`, `consumed`, `invalidated`, `revoked`, or
`expired`. Exactly one dispatch can consume an approval; a concurrent or
repeated dispatch is refused rather than replayed. Dispatch re-runs the
complete-request scan under the current rules and policy, persists required
pre-dispatch audit evidence before any byte leaves, and records an unknown
provider outcome as unknown — never as success and never as a retry. Any
change to destination or context invalidates the approval with
`RECOVERY_APPROVAL_INVALID`.

## 4. Audit surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/audit` | Read the tamper-evident non-secret trail; `purpose` is required. |
| `POST` | `/audit/exports` | Export a filtered trail; the export itself is recorded before the payload is returned. |

Reads require a security duty (handler, independent reviewer, or enterprise
security administrator); exports are restricted to the enterprise security
administrator. A denied attempt records `audit.access_denied` and returns
`FORBIDDEN` without revealing whether the queried case exists.

Each entry is `{ seq, hash, event }`. `hash` is the chain value for that
sequence, so a client can verify continuity without trusting the server's
ordering claim. Events cover, at minimum, detection/block, assignment and
escalation, sensitive-context access, handling and review, rule proposal /
review / activation / rollback, approval, recheck, authorization invalidation,
dispatch, and termination. Entries carry only keyed identifiers for protected
content (`protected_refs`), scan evidence counts and versions, and stable
action/reason codes. There is no update or delete operation on the audit
surface; the trail is append-only.

## 5. Errors

Every failure uses the shared envelope from `error-envelope-v1.md` with
`case_ref` and `trace_ref` populated when the handles exist. ADR-0005 adds four
stable, non-retryable codes:

| Code | Status | `next_action` |
| --- | --- | --- |
| `MODEL_EGRESS_DENIED` | 403 | `request_review` |
| `SENSITIVE_DATA_UNCERTAIN` | 422 | `enter_security_case` |
| `SECURITY_REVIEW_REQUIRED` | 428 | `request_review` |
| `RECOVERY_APPROVAL_INVALID` | 409 | `request_review` |

The envelope never contains a policy identifier, threshold, detector pattern,
or matched fragment. `case_ref` and `trace_ref` authorize nothing and never
open quarantined content.

## 6. Fixtures

`docs/fixtures/security-api-v1/` contains contract exemplars for the case,
rule, recovery, audit, and error shapes, including the two request envelopes
(`SecurityRuleProposalRequest`, `SecurityAuditExportRequest`). They are
authored from the contract rather than captured from a live service; when the
HTTP layer lands (a later milestone) they must be re-verified against real
responses before the web client treats them as captured snapshots.

## 7. Verification

- `node/test/security-api-fixtures.test.ts` — every fixture validates against
  its generated schema with closed objects; enums reuse the domain constants;
  no request body offers a bypass or a client-supplied scope; the case fixture
  only advertises transitions the service permits.
- `node/test/openapi.test.ts` — every security operation is documented, the
  committed contract matches a fresh generation, and security state-changing
  operations carry `X-CSRF-Token`.
- `node/test/security-audit.test.ts`, `security-leak.test.ts`,
  `security-error-contract.test.ts` — audit chain integrity, non-secret
  surfaces, and stable error semantics.
