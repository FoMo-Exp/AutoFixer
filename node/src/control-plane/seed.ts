/**
 * Control-plane initialization and seeding.
 *
 * The first enterprise administrator is established through a deployment-owned,
 * audited bootstrap process — not whichever account signs in first. This module
 * provides the minimal bootstrap path for a private single-enterprise
 * deployment.
 */

import type { ControlPlaneDb } from "./db.js";
import { createRepositories } from "./repositories.js";
import type { Enterprise, EnterpriseScope, ProviderInstance, Workspace } from "./types.js";
import type { ProviderType } from "./types.js";

export interface SeedEnterpriseInput {
  enterprise_name: string;
  enterprise_slug: string;
  /** The bootstrap administrator's user ID. */
  admin_user_id: string;
}

export interface SeedProviderInput {
  provider_type: ProviderType;
  origin_url: string;
}

export interface SeedWorkspaceInput {
  name: string;
  repository_id: string;
  provider_instance_id: string;
}

export interface SeedResult {
  enterprise: Enterprise;
  admin_scope: EnterpriseScope;
}

/**
 * Bootstrap the first enterprise with its administrator.
 *
 * Idempotent: if an enterprise with the given slug already exists, returns the
 * existing enterprise and its scope without creating a duplicate. This makes
 * the seed safe to run on every deployment start.
 */
export function seedEnterprise(db: ControlPlaneDb, input: SeedEnterpriseInput): SeedResult {
  const repos = createRepositories(db);
  const existing = repos.enterprises.getBySlug(input.enterprise_slug);
  if (existing) {
    return {
      enterprise: existing,
      admin_scope: { enterprise_id: existing.id, actor_id: input.admin_user_id },
    };
  }
  const enterprise = repos.enterprises.create({
    name: input.enterprise_name,
    slug: input.enterprise_slug,
    actor_id: input.admin_user_id,
  });
  return {
    enterprise,
    admin_scope: { enterprise_id: enterprise.id, actor_id: input.admin_user_id },
  };
}

/**
 * Create a provider instance within the scope's enterprise.
 * Returns the created instance.
 */
export function seedProviderInstance(
  db: ControlPlaneDb,
  scope: EnterpriseScope,
  input: SeedProviderInput,
): ProviderInstance {
  const repos = createRepositories(db);
  return repos.providerInstances.create(scope, {
    provider_type: input.provider_type,
    origin_url: input.origin_url,
  });
}

/**
 * Create a workspace within the scope's enterprise.
 * Returns the created workspace.
 */
export function seedWorkspace(
  db: ControlPlaneDb,
  scope: EnterpriseScope,
  input: SeedWorkspaceInput,
): Workspace {
  const repos = createRepositories(db);
  return repos.workspaces.create(scope, {
    name: input.name,
    repository_id: input.repository_id,
    provider_instance_id: input.provider_instance_id,
  });
}
