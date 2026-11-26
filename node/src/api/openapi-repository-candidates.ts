/**
 * OpenAPI contract for approved-repository discovery (DAT-289, ADR-0011).
 *
 * One read operation: the candidate repositories an authorized repository
 * manager may select for this workspace, each with the exact provider instance,
 * the repository-scoped active service integration (`installation_ref`) and the
 * immutable repository id a DAT-286 proposal needs.
 *
 * Three boundaries the contract states rather than leaving to prose:
 *
 * - **Selection is not authority.** `proposable` means "may be submitted to the
 *   preview"; the preview, confirmation and commit re-verify the actor, the
 *   installation, every member's evidence and the observed set version.
 * - **Never a complete list.** `coverage.completeness` is always `bounded` and
 *   `coverage.limits` names why; an unknown repository is never reported as
 *   approved and a missing one is never reported as absent from the provider.
 * - **Restrictions are named.** A discovered repository whose installation
 *   cannot serve as evidence is returned with its restriction codes rather than
 *   dropped, so an empty page and a restricted page never look the same.
 */

import type { JsonObject } from "./openapi-types.js";
import type { ProviderType } from "../control-plane/types.js";
import {
  REPOSITORY_CANDIDATE_FRESHNESS,
  REPOSITORY_CANDIDATE_RESTRICTIONS,
  REPOSITORY_DISCOVERY_COMPLETENESS,
  REPOSITORY_DISCOVERY_LIMITS,
  REPOSITORY_DISCOVERY_SOURCES,
  REPOSITORY_DISCOVERY_UNSUPPORTED_SOURCES,
} from "./repository-candidate-types.js";

const errorRef = { $ref: "#/components/schemas/Error" } as const;

function errorResponse(description: string): JsonObject {
  return { description, content: { "application/json": { schema: errorRef } } };
}

const PROVIDER_TYPES: readonly ProviderType[] = ["github", "gitlab"];

const CURSOR_PARAMETER: JsonObject = {
  name: "cursor",
  in: "query",
  required: false,
  schema: { type: ["string", "null"] },
  description:
    "Opaque cursor returned as `next_cursor` by the previous page. An unknown " +
    "cursor is 400 INVALID_CURSOR, never a silently restarted page.",
};

const RESTRICTION_SCHEMA: JsonObject = {
  type: "string",
  enum: [...REPOSITORY_CANDIDATE_RESTRICTIONS],
  description:
    "Why this installation cannot be proposed as it stands: `installation_inactive` " +
    "(suspended/uninstalled), `provider_instance_unapproved`, " +
    "`permission_visibility_none` / `_partial` (the provider cannot prove effective " +
    "access), `provider_unavailable` (last reconciliation could not reach the " +
    "provider) or `roster_incomplete` (last roster fetch was truncated). Each one " +
    "describes the installation, never a confirmed member downgrade.",
};

export const REPOSITORY_CANDIDATE_OPENAPI_SCHEMAS: Record<string, JsonObject> = {
  RepositoryCandidateVerification: {
    type: "object",
    additionalProperties: false,
    required: ["subjects", "latest_verified_at", "freshness", "last_reconcile_at", "last_failure"],
    properties: {
      subjects: {
        type: "integer",
        minimum: 0,
        description: "Subjects this installation holds an authority row for.",
      },
      latest_verified_at: {
        type: ["string", "null"],
        format: "date-time",
        description:
          "Most recent per-subject verification, or null when none was recorded. " +
          "Advisory: the preview decides whether each member's evidence is current.",
      },
      freshness: {
        type: "string",
        enum: [...REPOSITORY_CANDIDATE_FRESHNESS],
        description:
          "`fresh` within the one-day authority bound, `stale` beyond it, " +
          "`never_verified` when no subject was ever verified.",
      },
      last_reconcile_at: {
        type: ["string", "null"],
        format: "date-time",
        description: "Start (or finish) of the last reconciliation attempt, when one ran.",
      },
      last_failure: {
        type: ["string", "null"],
        description: "The failure code of the last reconciliation attempt, when it failed.",
      },
    },
  },
  RepositoryCandidate: {
    type: "object",
    additionalProperties: false,
    required: [
      "provider_instance_id",
      "provider_type",
      "installation_ref",
      "repository_id",
      "repository_name",
      "install_status",
      "permission_visibility",
      "verification",
      "proposable",
      "restriction_reasons",
    ],
    properties: {
      provider_instance_id: {
        type: "string",
        description: "An instance registered for this enterprise; the proposal's provider.",
      },
      provider_type: {
        type: ["string", "null"],
        enum: [...PROVIDER_TYPES, null],
        description:
          "The registered instance's provider type; null while the instance is not " +
          "registered for this enterprise (a restricted candidate is reported, never " +
          "hidden, and its type is never inferred from the repository id).",
      },
      installation_ref: {
        type: "string",
        description:
          "The repository-scoped active service integration (`service_integration.id`) " +
          "that would have to vouch for this repository. This is the `installation_ref` " +
          "a repository-addition proposal carries.",
      },
      repository_id: {
        type: "string",
        description:
          "Immutable provider-assigned repository id; the only authority-bearing identity.",
      },
      repository_name: {
        type: ["string", "null"],
        description:
          "Display metadata from the registered installation. Never stored in a " +
          "confirmation, a binding or an audit row and never used for authorization.",
      },
      install_status: { type: "string", enum: ["active", "suspended", "uninstalled"] },
      permission_visibility: { type: "string", enum: ["full", "partial", "none"] },
      verification: { $ref: "#/components/schemas/RepositoryCandidateVerification" },
      proposable: {
        type: "boolean",
        description:
          "True only when no restriction applies. It means 'selectable for the " +
          "preview', never 'approved', 'granted' or 'will commit'.",
      },
      restriction_reasons: {
        type: "array",
        items: RESTRICTION_SCHEMA,
        description: "Every reason this installation cannot be proposed, in canonical order.",
      },
    },
  },
  RepositoryDiscoveryCoverage: {
    type: "object",
    additionalProperties: false,
    required: ["completeness", "sources", "unsupported_sources", "limits"],
    properties: {
      completeness: {
        type: "string",
        enum: [...REPOSITORY_DISCOVERY_COMPLETENESS],
        description:
          "Always `bounded`. No response ever claims to be the complete set of " +
          "repositories the provider would allow.",
      },
      sources: {
        type: "array",
        items: { type: "string", enum: [...REPOSITORY_DISCOVERY_SOURCES] },
        description: "The stores this list was built from.",
      },
      unsupported_sources: {
        type: "array",
        items: { type: "string", enum: [...REPOSITORY_DISCOVERY_UNSUPPORTED_SOURCES] },
        description:
          "Sources this build cannot enumerate. Reported so a missing repository is " +
          "never mistaken for a repository the provider would refuse.",
      },
      limits: {
        type: "array",
        items: { type: "string", enum: [...REPOSITORY_DISCOVERY_LIMITS] },
        description: "Why the list is bounded, in canonical order.",
      },
    },
  },
  RepositoryDiscoveryTotals: {
    type: "object",
    additionalProperties: false,
    required: ["discovered", "proposable", "restricted", "already_bound"],
    properties: {
      discovered: {
        type: "integer",
        minimum: 0,
        description: "Unbound repositories whose installation was readable.",
      },
      proposable: { type: "integer", minimum: 0 },
      restricted: { type: "integer", minimum: 0 },
      already_bound: {
        type: "integer",
        minimum: 0,
        description:
          "Repositories already bound in this workspace (active or retired) and " +
          "therefore not offered: a proposal only adds. Counted over the whole set so " +
          "an empty page is explainable.",
      },
    },
  },
  RepositoryCandidatePage: {
    type: "object",
    additionalProperties: false,
    required: [
      "enterprise_id",
      "workspace_id",
      "set_version",
      "discovered_at",
      "coverage",
      "items",
      "next_cursor",
      "totals",
    ],
    properties: {
      enterprise_id: { type: "string" },
      workspace_id: { type: "string" },
      set_version: {
        type: "integer",
        minimum: 1,
        description:
          "Current repository-set version; pass it as `expected_set_version` when " +
          "previewing the selected candidates so a set change invalidates the decision.",
      },
      discovered_at: { type: "string", format: "date-time" },
      coverage: { $ref: "#/components/schemas/RepositoryDiscoveryCoverage" },
      items: {
        type: "array",
        items: { $ref: "#/components/schemas/RepositoryCandidate" },
      },
      next_cursor: { type: ["string", "null"] },
      totals: { $ref: "#/components/schemas/RepositoryDiscoveryTotals" },
    },
  },
};

const DESCRIPTION =
  "Lists the repositories an authorized repository manager may select for this " +
  "workspace, each with the provider instance, the repository-scoped active " +
  "service integration (`installation_ref`) and the immutable repository id a " +
  "repository-addition proposal needs. Authority is the same repository-" +
  "administration rule the preview/confirm/commit surface applies: an active " +
  "account with an active enterprise membership, a workspace owner/admin " +
  "assignment and verified `repository_manage` across every current repository. " +
  "A caller who could not decide the change cannot enumerate its candidates. " +
  "The list is built only from installations registered for this workspace in " +
  "this enterprise, so it is always `bounded` and names the source it cannot " +
  "use; a repository that is unknown, uninstalled, unobservable or truncated is " +
  "never reported as approved. Repositories already bound (active or retired) " +
  "are excluded and counted, because an addition never re-binds. Discovery " +
  "writes nothing and grants nothing: submitting a candidate still runs the " +
  "full preview → confirmation → commit chain, which re-verifies the caller, the " +
  "installation, the whole member impact and the observed set version.";

export function repositoryCandidateOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/api/v1/workspaces/{workspace_id}/repository-candidates": {
      get: {
        operationId: "listRepositoryCandidates",
        summary: "Discover repositories that may be added to a workspace",
        description: DESCRIPTION,
        parameters: [
          {
            name: "workspace_id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Workspace locator, resolved against the caller's live membership.",
          },
          CURSOR_PARAMETER,
        ],
        responses: {
          200: {
            description:
              "One page of candidates with the installation state and bounded-coverage " +
              "disclosure. Nothing was written.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RepositoryCandidatePage" },
              },
            },
          },
          400: errorResponse("INVALID_CURSOR — an unknown cursor, never a restarted page"),
          401: errorResponse("UNAUTHENTICATED — no valid session"),
          403: errorResponse(
            "REPOSITORY_SET_CHANGE_ACTOR_UNAUTHORIZED — not an active workspace owner/admin " +
              "with verified repository management across the current set",
          ),
          404: errorResponse("NOT_FOUND — unknown workspace or no live membership"),
          409: errorResponse(
            "REPOSITORY_SET_VERSION_CONFLICT / REPOSITORY_BINDING_* / " +
              "INSTALLATION_NOT_APPROVED / FEATURE_GATE_UNREADABLE — the workspace " +
              "repository set cannot be read, so no candidate is offered",
          ),
        },
      },
    },
  };
}
