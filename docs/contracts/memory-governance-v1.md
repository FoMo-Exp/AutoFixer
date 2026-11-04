# Workspace memory governance v1 (DAT-251)

Contract for the named-human governance surface of ADR-0009
(`docs/adr/0009-workspace-memory-lessons-and-rsi.md`). It fills the gap between
the retrieval/browse surface (`docs/contracts/memory-retrieval-v1.md`, DAT-236)
and the lifecycle/RSI slices: ADR-0009 lists `promote`, `deprecate`, and
`quarantine` as HTTP operations, but neither slice defined them. This document
is the single source of truth for those endpoints, the version history and
audit timeline the governance UI reads, and the redaction rules around
quarantine.

The generated document at `web/src/api/contracts/openapi.json` (and
`schema.d.ts`) is exported from the implementation (`npm run export:openapi`),
never hand-edited. The per-endpoint tables below mirror what that export
contains.

This is not a new write layer over storage. It composes the existing
repositories and tables — `memory_items`, `memory_item_versions`,
`memory_events`, `memory_promotion_decisions`, and `memory_consolidation_ops` —
and adds no migration. Every transition is one named human act on one exact
version, audited append-only.

## 1. Authentication, scoping, and authority

Every route requires a **user session** (web `fp_session` cookie with the CSRF
echo, or a desktop session bearer token) and is resolved from the caller's live
workspace membership. `workspace_id` in the path is a locator, never authority;
a request body carrying `workspace_id` or `enterprise_id` is rejected with
`400 INVALID_REQUEST`.

An item outside the caller's workspace, an unknown id, and an id above the
caller's sensitivity ceiling are the **same** answer: `404 NOT_FOUND`. The
surface never distinguishes "does not exist" from "not yours".

### Permission matrix

Authority is resolved from live membership and the workspace's `team` rows on
every request. It is never taken from the request body, a header, or a stored
claim in the memory item.

| Caller | Read (detail, versions, events) | Govern (promote, deprecate, quarantine, restore) |
| --- | --- | --- |
| workspace `owner` / `admin` | every item in the workspace within their ceiling | every item in the workspace within their ceiling |
| team leader (`team.leader_user_id` = caller) | every item in the workspace within their ceiling | only items whose `applicability.team_id` is a team they lead in this workspace |
| `member` | every item within their ceiling | `403 FORBIDDEN` |
| `viewer` | every item within their ceiling | `403 FORBIDDEN` |
| agent / operator bearer credential | not authenticated on this surface | `403 FORBIDDEN` (credential valid, standing absent) |
| any caller, item in another workspace | `404 NOT_FOUND` | `404 NOT_FOUND` |

Details that matter for tests:

- Team leadership is not a workspace role. A `member` who leads a team may
  govern that team's items; the same member may not govern another team's items
  or workspace-wide items (no `team_id`), which is `403 FORBIDDEN`, not 404 —
  the item is visible, the actor lacks standing.
- An `owner`/`admin` is never limited to a team.
- `restricted` sensitivity items are **not manageable through this surface**.
  The ceiling hides them from every role, so they answer `404` for reads and
  transitions (ADR-0009: quarantine and evidence access require separate
  authorization; v1 exposes no such grant).
- The agent/operator token is refused with `403` **before** session
  resolution, so it never degrades into the `401` a missing session produces.

Sensitivity ceilings are those of DAT-236: `viewer`/`member` → `internal`;
`owner`/`admin` → `confidential`; `restricted` → never.

## 2. State machine

`retired` is terminal. The transitions this surface performs:

| Action | Accepted from | Result | Notes |
| --- | --- | --- | --- |
| `promote` | `candidate` | `active` | Named human approval of the exact version. `lesson`, `playbook`, `anti_pattern`, and `policy` require the review stamp; `policy` must also be human-authored. The item must have at least one evidence citation. |
| `deprecate` | `active`, `candidate` | `deprecated` | Requires a fixed `reason_code`. |
| `quarantine` | `proposed`, `candidate`, `active`, `deprecated` | `quarantined` | Security response; removes the item from retrieval immediately and redacts content (see §5). |
| `restore` | `quarantined` | `proposed`, `candidate`, or `deprecated` | `active` is **not** an accepted target: returning to active must go through `promote`, so approval cannot be bypassed. |

Illegal moves answer `409 INVALID_TRANSITION` with `details.from_status` and
`details.action`. `quarantine` on an already-quarantined or retired item is
illegal, as is `restore` on anything that is not quarantined.

`promote` writes the approver's `review` stamp on the exact version when one is
not already present, records a promotion decision with reason
`human_approved`, and appends the audited `status_changed` event with
`reason_code: human_approved`.

## 3. Concurrency and audit

Every transition body carries both:

- `version` — the exact immutable content version the human acted on; it must
  equal the item's current version;
- `expected_version` — the optimistic concurrency token; it must also equal the
  current version.

Either mismatch is `409 VERSION_CONFLICT`. Writes only append: no version row,
event row, promotion decision, or consolidation op is rewritten, so a
concurrent change is detected rather than silently clobbered.

Reasons are a **fixed vocabulary**, never free text:

```
duplicate_content, past_valid_to, stale_fact, unused_decay,
retirement_proposal, security_report,                       # DAT-235 codes
human_decision, contradiction, incorrect_content,
policy_violation, secret_leak, poisoning_suspected,
restore_after_review, false_positive                        # DAT-251 codes
```

The `memory_events.detail` invariant — "fixed enums, counts, and opaque ids;
never free text and never memory content" — is not relaxed by this contract.
`reason_code` is validated against the vocabulary, then stored as a token in
`status_changed.detail`; the timeline reader additionally drops any detail
entry that is not a finite number, a boolean, or a whitespace-free token of at
most 200 characters. If a product ever needs a free-text note, it is a separate
issue and a separate contract.

## 4. Endpoints

All paths are under `/api/v1`; `{workspace_id}` is required and session-scoped.

### 4.1 `GET /workspaces/{workspace_id}/memory/items` (extended from DAT-236)

The DAT-236 browse endpoint gains optional query parameters and optional
response fields. With no parameters, behaviour is unchanged.

New query parameters (all optional):

| Parameter | Match rule |
| --- | --- |
| `team_id` | item `applicability.team_id` equals the value; broadly applicable items (no team) are included; another team excludes the item |
| `path_prefix` | item path prefix is a segment prefix of the value (segment-boundary match); broadly applicable items included |
| `language` | exact applicability match |
| `task_family` | exact applicability match |
| `trust` | exact match on the current version's trust class: `human`, `agent`, `enterprise_template`, `system` |
| `sensitivity` | exact match on the current version's data class; it narrows the browse and never widens the role ceiling |

New response fields on each item (`MemoryItemView`), all additive:

| Field | Type | Meaning |
| --- | --- | --- |
| `statement_redacted` | boolean, optional | true when `statement` is withheld (quarantine) |
| `provenance` | `MemoryProvenance`, optional | author type, agent model, config digest, prompt-template version |
| `review` | `MemoryReview \| null`, optional | approver id and timestamp on this exact version |

`statement` becomes nullable in the schema (`string | null`) so a quarantined
item can serve `null`. Existing clients that always received a string keep
receiving one for every non-quarantined item.

`MemoryProvenance` = `{author_type: "human" | "agent" | "system", agent_model?, config_digest?, prompt_template_version?}`;
`MemoryReview` = `{approver_id, approved_at}`.

### 4.2 `GET /workspaces/{workspace_id}/memory/items/{item_id}`

Same view, same ceiling, and same redaction as the list, for deep links.
Returns `200 MemoryItemView`. Unknown, foreign, or above-ceiling: `404`.

### 4.3 `GET /workspaces/{workspace_id}/memory/items/{item_id}/versions`

Per-version content, ascending by version, for a content diff.

```
200 MemoryItemVersions {
  schema_version: 1,
  item_id,
  status,                 // current lifecycle status
  current_version,
  versions: MemoryItemVersion[]
}
```

`MemoryItemVersion`:

| Field | Type |
| --- | --- |
| `version` | integer ≥ 1 |
| `kind` | `fact \| lesson \| playbook \| anti_pattern \| episode \| policy` |
| `tier` | `L1 \| L2 \| L3 \| L4` |
| `statement` | `string \| null` (null when redacted) |
| `statement_redacted` | boolean |
| `preconditions` | string[] |
| `applicability` | `MemoryApplicability` |
| `trust` | `human \| agent \| enterprise_template \| system` |
| `sensitivity` | `internal \| confidential \| restricted` |
| `valid_from`, `valid_to` | date-time, nullable `valid_to` |
| `content_hash` | string |
| `provenance` | `MemoryProvenance` |
| `review` | `MemoryReview \| null` |
| `created_at`, `created_by` | date-time, user id |

**Per-version ceiling.** Each historical version is filtered by *its own*
sensitivity, not the current version's. A confidential v1 in an item whose v2
is internal is absent entirely for a `member` — not blanked in place, and not
enumerable by version number. The item itself is visible only if the current
version is within the ceiling.

### 4.4 `GET /workspaces/{workspace_id}/memory/items/{item_id}/events`

The item's audit timeline, ascending by `at`, merged from three stored sources
and normalized into one shape:

```
200 MemoryItemEvents { item_id, events: MemoryItemEvent[] }

MemoryItemEvent {
  at,                                  // date-time
  source: "memory_event" | "promotion_decision" | "consolidation_op",
  action,                              // event type, "promotion_decision", or the consolidation op
  actor: { type: "user" | "system", id },
  item_version: integer | null,
  from_status?, to_status?,            // lifecycle statuses, when the row records a change
  reason_code?,                        // fixed machine code
  detail?                              // enums, counts, opaque ids only
}
```

- `memory_event` rows carry their own `event_type` as `action`; a
  `status_changed` row exposes `from_status`, `to_status`, and (for a governance
  transition) `reason_code`.
- `promotion_decision` rows are `source: "promotion_decision"`,
  `action: "promotion_decision"`, and `detail` holds `outcome`, the fixed
  `reasons` list, and `independent_support_runs` (plus `evaluation_delta` when
  one was recorded).
- `consolidation_op` rows are `source: "consolidation_op"`, `action` is the op
  (`merge`, `supersede`, `expire`, `deprecate`, `quarantine`), `reason_code`
  is the DAT-235 op reason, and `detail` holds `applied`, `run_id`, the target
  item id when one exists, and the op's integer counts.

Events about a version above the caller's ceiling are absent, so the timeline
cannot be used to enumerate hidden history. The timeline is append-only; it is
built from rows, never from a mutable summary.

### 4.5 Transitions

All four are `POST`, return `200 MemoryGovernanceResult`, and accept an
`application/json` body with no fields beyond those listed. An unknown field is
`400 INVALID_REQUEST` (for example a `note`: free text is not part of this
contract).

```
MemoryGovernanceResult {
  action: "promote" | "deprecate" | "quarantine" | "restore",
  item_id,
  from_status, to_status,
  item_version,
  reason_code,        // the fixed code, "human_approved", or null (promote default)
  item: MemoryItemView   // post-transition view, same ceiling as browse
}
```

| Endpoint | Request body |
| --- | --- |
| `POST …/items/{item_id}/promote` | `{version, expected_version}` |
| `POST …/items/{item_id}/deprecate` | `{version, expected_version, reason_code}` |
| `POST …/items/{item_id}/quarantine` | `{version, expected_version, reason_code}` |
| `POST …/items/{item_id}/restore` | `{version, expected_version, target_status, reason_code}` |

`target_status` ∈ `proposed | candidate | deprecated`; anything else, including
`active`, is `400 INVALID_REQUEST`.

Common errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | malformed body, unknown field, non-positive version, unknown `reason_code` or `target_status` |
| 401 | `UNAUTHENTICATED` | no valid session (CSRF echo also missing) |
| 403 | `FORBIDDEN` | member/viewer, team leadership outside the item's team, or an agent/operator credential |
| 404 | `NOT_FOUND` | unknown item, another workspace, or above the caller's ceiling (including `restricted`) |
| 409 | `VERSION_CONFLICT` | `expected_version` or `version` is not the current version |
| 409 | `INVALID_TRANSITION` | the item's status does not accept this action |
| 409 | `PRECONDITION_FAILED` | promotion of an item with no evidence citation, or a policy that is not human-authored |

`INVALID_TRANSITION` and `PRECONDITION_FAILED` are stable codes with
`stage: policy`, `category: stop`, `retryable: false`, `next_action: refresh`:
the caller refreshes the item and decides again; a blind retry cannot succeed.

## 5. Quarantine redaction

For an item in `quarantined` status, **no response on this surface** returns the
original `statement`, any `preconditions`, or a raw evidence reference — not in
items, item detail, versions, or events:

| Field | Quarantined value |
| --- | --- |
| `statement` | `null` |
| `statement_redacted` | `true` |
| `preconditions` | `[]` |
| `evidence[]` | `{evidence_type, reference: "sha256:<32 hex>"}` — the evidence class survives, the reference is a stable one-way identifier |

`detail` in the timeline is already restricted to enums, counts, and opaque
ids, so no additional redaction is needed there; the normalizer still refuses
whitespace-bearing strings. v1 provides **no** route that returns quarantine
content. ADR-0009 requires separately authorized access to quarantine and
evidence, and the governance UI's acceptance criteria require not displaying
the original value.

## 6. Backward compatibility with DAT-236 / DAT-238

Relative to the merged retrieval contract, everything here is additive:

- `GET /memory/items` with no query parameters returns the same items and the
  same DAT-236 fields, with the same types and meanings.
- New query parameters default to "no filter".
- New response fields are optional and nullable; `statement` gains `null` as a
  possible value only for quarantined items, which DAT-236 never served as a
  readable string in the first place (quarantined items are excluded from
  retrieval and were only visible in browse with their content).
- Existing paths and schemas are unchanged, so the DAT-239 fixture built
  against `openapi.json` stays valid.

## 7. Storage and implementation map

No migration: all facts already exist.

| Concern | Source |
| --- | --- |
| Item lifecycle state, versions, provenance, review | `memory_items`, `memory_item_versions` |
| Audit timeline (mutations, approvals, deletion) | `memory_events` |
| Promotion assessments | `memory_promotion_decisions` |
| Consolidation operations (merge/supersede/expire/deprecate/quarantine) | `memory_consolidation_ops` |
| Team leadership | `team.leader_user_id` |

Code: `node/src/memory/governance/` (types and service),
`node/src/memory/redact.ts` (shared quarantine redaction),
`node/src/api/memory-http.ts` (routes), `node/src/api/openapi-memory.ts`
(schemas and paths). Tests:
`node/test/memory-governance-api.test.ts` drives the real HTTP surface for the
permission matrix, transitions, concurrency, redaction, per-version ceiling,
cross-workspace 404, and agent-credential 403.
