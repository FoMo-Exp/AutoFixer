# pr-governance/v1 — current-head pull-request governance observation

The HTTP contract for observing one delivered pull request's merge boundary
(DAT-261, ADR-0007). It is generated into
`web/src/api/contracts/openapi.json` from `node/src/api/openapi.ts`; the
observation types live in `node/src/collab/pr-governance.ts` and the GitHub
reader in `node/src/collab/github-pr-governance.ts`. The deployed reader uses
the repository integration's **source (read-only)** credential — never the
delivery write credential.

## 1. Endpoint

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/workspaces/{workspace_id}/issues/{issue_id}/deliveries/{delivery_id}/governance` | Read the PR's current-head checks, approvals, and review discussions |

- Workspace-scoped, authenticated with a session cookie or bearer token. The
  path workspace is resolved against the caller's live membership, so another
  workspace's issue/delivery is an indistinguishable `404`.
- `200 PullRequestGovernanceObservation` — the observation, including the
  `blocked` / `unknown` outcomes described below.
- `404 ISSUE_NOT_FOUND | DELIVERY_NOT_FOUND`.
- `409 GOVERNANCE_NOT_OBSERVABLE` when the delivery has no pull request (for
  example a `pending`, `failed`, or branch-only operation).
- The route is `GET`-only. There is no `POST`, `PATCH`, `PUT`, or `DELETE`, and
  no approve, merge, dismiss, check-waiver, or rerun operation exists in the
  observation module or the GitHub reader.

## 2. One observation, one head

Every observation names the exact `head_sha` and the `observed_at` instant it
describes:

- `delivery_head_sha` is the head the delivery published (the approved
  candidate commit).
- `head_sha` is the pull request's current head at observation time, read from
  the provider. It is `null` when it could not be read; it is never assumed
  equal to `delivery_head_sha`.
- `checks.items[]` carry the commit their result belongs to; only results for
  `head_sha` are included.
- `approvals.items[]` carry `head_sha` from the review's `commit_id`; only
  reviews against `head_sha` are included, and each reviewer's newest decisive
  review (`approved` / `changes_requested`) wins.
- `review_discussions.unresolved` is read for the same head; `null` means the
  answer was incomplete or unavailable, never "zero".

`validity` summarizes the binding:

| Value | Meaning |
| --- | --- |
| `current` | The observed head equals `delivery_head_sha` and every dimension was observed. |
| `superseded` | The pull request moved to another head. The record describes that new head; the previous head's approvals and checks are absent, and the replaced record is reported in `supersedes`. |
| `blocked` | A definite refusal: no integration/credential, permission denied, or the pull request is absent. |
| `unknown` | The provider answer was unreadable: timeout, rate limit, 5xx, truncated page, or malformed body. |

A new head never inherits the old QA/check/discussion/approval observations.
The service holds no governance facts of its own, and the observation route
does not persist a snapshot, so a later read cannot resurrect an earlier
head's facts. `observations_valid` is true only for a `current` observation
with every dimension observed.

## 3. Observed conditions — not a merge-queue claim

`conditions_satisfied` is true only when every condition **this read-only
observation can verify** holds, and `unmet_condition` names the first one that
does not:

| `unmet_condition` | Condition |
| --- | --- |
| `head_unavailable` | `head_sha` could not be read. |
| `head_changed` | The PR head no longer equals the delivered head (`superseded`). |
| `governance_blocked` | Configuration, credential, permission, or PR absence blocked the read. |
| `governance_unknown` | The provider answer was unreadable or incomplete. |
| `pull_request_not_open` | The PR is `closed` or `merged`. |
| `checks_missing` | No check run is bound to this head. |
| `checks_not_passed` | A check is `failed` or `pending` (a neutral/skipped/stale conclusion is not passing). |
| `review_discussions_unresolved` | At least one review conversation is unresolved. |
| `approvals_incomplete` | Not every required approver's newest decisive review on this head is an approval. |

The record deliberately makes **no merge or merge-queue eligibility claim**.
`not_evaluated` lists the gates this reader cannot observe and which therefore
must never be inferred as satisfied:

- `qa_verdict` — the QA result is a collaboration-domain fact, not a GitHub one.
- `branch_protection_required_checks` — the branch's required check/status set
  needs branch-protection administration, which this read-only reader does not
  read. A non-required check passing is not evidence that the required set
  exists or passed.
- `merge_queue_availability` — merge-queue configuration and mergeability /
  conflict state are not observed.

The service never approves, dismisses a review, waives a check, or merges; a
merge remains a provider-side, human-governed action.

## 4. Failure and completeness classification

| Failure | `validity` / dimension | `reason` |
| --- | --- | --- |
| No active repository integration | `blocked` | `integration_not_configured` |
| Credential reference not resolvable | `blocked` | `credential_unavailable` |
| Provider `401`/`403` | `blocked` | `permission_denied` |
| PR `404` | `blocked` | `pull_request_not_found` |
| Timeout, rate limit, `5xx`, network | `unknown` | `provider_unavailable` |
| Malformed/truncated container, thread page, or review-thread answer | `unknown` | `invalid_provider_response` |

A blocked or unknown observation has `head_sha: null`, empty check/approval
items, `review_discussions.unresolved: null`, `conditions_satisfied: false`,
and the reason repeated on every dimension. Nothing from a previous
observation is copied into it.

A malformed **row** is narrower than a malformed container:

- A review row that cannot be interpreted (non-object, missing state, or a
  decisive `APPROVED`/`CHANGES_REQUESTED` row missing its reviewer, `commit_id`,
  or submit time) makes the **approval** dimension `unknown` with
  `invalid_provider_response` and **empty items**. The old approval is never
  kept, because it may have been superseded by the unreadable rejection.
  Documented non-decisive states (`COMMENTED`, `PENDING`, `DISMISSED`) are
  skipped; an unrecognised state makes the set `unknown`.
- A check row that cannot be bound to a name/commit/status, or a truncated
  check page, makes the **checks** dimension `unknown` with empty items.
- In both cases the other dimensions remain as observed, `validity` is
  `unknown`, and `conditions_satisfied` is false.

## 5. Fixtures

`docs/fixtures/collab-api-v1/governance-observation*.json` are contract
exemplars validated against the generated OpenAPI schemas with closed objects
(no invented fields) by `node/test/collab-fixtures.test.ts`.
