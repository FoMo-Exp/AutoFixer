# Enterprise templates v1 (DAT-237)

Enterprise templates let one workspace's scrubbed memory be reused by other
workspaces in the same enterprise without exposing the source workspace. This
document is the contract for `node/src/memory/templates/`.

## Surface

This slice is a service-layer contract; it adds **no HTTP routes and no
OpenAPI fields**. The v1 memory HTTP surface is defined by DAT-236. Callers use
`createEnterpriseTemplateService(db)`.

```ts
publish(scope, input)        // enterprise admin; from one source item version
listTemplates(scope)         // enterprise/workspace member
getTemplate(scope, id)
listVersions(scope, id)
listPublications(scope, id)  // enterprise admin only
adopt(scope, input)          // workspace owner/admin
revoke(scope, input)         // enterprise admin
listAdoptions(scope)         // workspace member
listTemplateAdoptions(scope, id) // enterprise admin only
listEnterpriseEvents(scope)  // enterprise admin only
listWorkspaceEvents(scope)
```

`scope` is always a `WorkspaceScope` derived from authenticated membership.
Enterprise/workspace ids never come from the request body.

## Publication

`publish` copies **one exact source memory version** (`source_item_version`
pins it optimistically) and requires:

1. the caller holds the enterprise `admin` role;
2. the source workspace belongs to that enterprise;
3. the source item is `active` and its current version equals the pinned one;
4. at least one evidence reference exists;
5. the kind is `fact`, `lesson`, `playbook`, or `anti_pattern` — `episode`
   (run-scoped) and `policy` (L4) are rejected;
6. scrubbing and policy lint pass;
7. procedural kinds (`lesson`, `playbook`, `anti_pattern`) carry a named
   security review by a **different** enterprise administrator.

Publication is idempotent per source `(workspace, item, version)`. Revisions
append a new immutable template version; publishing unchanged publishable
content records a publication but does not duplicate the version. Revoked
templates cannot be revised.

### What a template carries

A template version contains only: `kind`, scrubbed `scope` (`team_id` removed),
scrubbed `statement` and `preconditions`, `sensitivity`, the **classes** of
source evidence (strongest first), the security review, and a canonical content
hash. It carries no source run, issue, PR, commit, test, or reviewer reference,
and no source workspace identifier.

An admin-only **publication record** stores `source_workspace_id`,
`source_item_id`, `source_item_version`, an evidence count, and a counts-only
scrub report. It is never returned by `getTemplate`/`listVersions` and never
copied into an adoption.

### Scrubbing (fail closed)

Before persistence, the statement, preconditions, and scope values are
scrubbed and then re-scanned. Publication aborts if any detector still
matches. Categories (reported as counts only):

- credentials: GitHub/GitLab/AWS/OpenAI/Slack token shapes, bearer tokens,
  private-key blocks, `password|secret|token|api_key = …` values;
- links and references: every `http(s)` URL, `owner/repo#123`, issue keys such
  as `DAT-237` (excluding public `ADR-…` document numbers);
- personal data: e-mail addresses, phone-shaped numbers, labelled
  customer/employee/contact values;
- locations: `/Users/…`, `/home/…`, `C:\Users\…`, IP addresses;
- logs: timestamped log records, level-padded records, stack frames, tracebacks
  (whole lines are removed);
- high-entropy digests (long hex/base64 tokens);
- control tokens such as `<|…|>`;
- identity terms: enterprise id/name/slug, every workspace id/name/repository
  id, service-integration repository display names, and team ids/names in the
  enterprise.

A scope value that required redaction is **dropped**, not published with a
placeholder. A statement that is empty after scrubbing is rejected. Caps:
2,000 characters per scrubbed statement, 8 preconditions of 500 characters.

Limitation stated honestly: personal **names** are not an enumerable directory
field in the control plane. Name-level PII protection therefore relies on
pattern detectors plus the publishing administrator's explicit action; the
report proves which automated categories ran and cleaned.

### Policy lint

Publication and adoption both reject (codes, no echoed content):

| Code | Meaning |
|---|---|
| `capability_expansion` | grants, escalations, or widened permissions/access/roles |
| `approval_bypass` | skip/bypass/ignore approval or human review |
| `test_or_policy_bypass` | skip tests, test gates, policy, sandbox, audit, dsh |
| `approval_claim` | auto-/self-/pre-approved, approval not required, approval by an agent/model/system |
| `evaluator_instruction` | instructions addressed to an evaluator/grader/rubric/holdout |
| `instruction_injection` | "ignore previous instructions", system-prompt references, control tokens |

Negated guidance ("never skip the test gate") is allowed. A template never has
a field for capability grants, approval state, or evaluator definitions, so it
cannot carry them structurally.

## Adoption

`adopt` requires a workspace `owner` or `admin`, a `published` template, and an
explicit `template_version` (adoption pins a version; it never floats).

The adoption row is inserted with a single conditional statement that requires
the template to still be `published` at insert time. A revocation therefore
either commits first (the insert writes nothing and the call fails with a
conflict) or commits after (its scan sees the new adoption). A read-then-insert
cannot leave an active adoption created after revocation completed.

Adoption creates a **new local memory item** in the adopting workspace:

- `status = candidate` — never `active`;
- `trust = enterprise_template`;
- `provenance.author_type = system` with
  `config_digest = enterprise-template:<id>@<version>`;
- one local evidence row whose class is the template's strongest class and
  whose reference is `enterprise-template:<id>@<version>`;
- no `source_run_id`.

Local promotion, validation, and human approval remain the adopting
workspace's job (DAT-234/DAT-235). An administrator's publication can never
make memory active elsewhere. Adoption is idempotent per
`(workspace, template, version)`.

Templates live in their own tables: the memory read path (list/search/export)
never sees them, so a template is not retrievable before adoption and no
enterprise-wide index or similarity search exists.

## Revocation

`revoke` requires an enterprise admin and a non-empty reason; it is terminal.

1. The template header becomes `revoked`: new adoption is rejected.
2. Every active adoption is marked `revoked`; the local copy is reconciled by
   fixed outcome:

| Outcome | Local action |
|---|---|
| `deprecated` | `proposed`/`candidate`/`active` copy moved to `deprecated` |
| `already_deprecated` | left as-is |
| `quarantined_untouched` | left quarantined |
| `retired_untouched` | left retired |
| `item_missing` | deleted copy is not recreated; tombstone already records it |
| `deprecation_failed` | concurrent conflict; reported, template still revoked |

Revocation never deletes or rewrites versions, evidence, statements, or
tombstones. Adoption rows retain the pinned version, timestamps, actor, and
reason for audit. A workspace-level `adoption_deprecated` /
`adoption_revocation_skipped` event is recorded per affected workspace as the
notification hook; this slice adds no separate notification transport.

## Audit

`enterprise_template_events` is append-only and carries metadata only: template
id/version, fixed event type, actor, workspace (for adoption-scoped events), and
counts/enums. It never carries statement text, scrub matches, or free-text
revocation reasons (those live on the revoked template/adoption rows).

Event types: `template_published`, `template_version_published`,
`template_revoked`, `template_adopted`, `adoption_deprecated`,
`adoption_revocation_skipped`.

## Non-goals

- No automatic propagation, background federation, shared index, or
  enterprise-wide similarity search.
- A template is not L4 policy and never binds a workspace that did not adopt it.
- No capability grant, approval, evaluator change, or merge right can be
  expressed by a template.

## Tests

`node/test/memory-enterprise-templates.test.ts` covers: admin-only publication,
source pinning and status, idempotency, immutable revisions, scrub categories,
log removal, policy lint, security review, adoption as candidate-only, isolation
from memory reads, cross-enterprise denial, revocation outcomes and history
preservation, and metadata-only audit.
