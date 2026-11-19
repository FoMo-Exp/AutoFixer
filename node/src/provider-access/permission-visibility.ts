/**
 * Effective-permission visibility per provider adapter.
 *
 * One source for two consumers that must never disagree: each real adapter
 * declares what it can prove about repository permissions, and the
 * administrator initialization surface records exactly that value. An
 * operator therefore cannot install an integration claiming broader
 * visibility than its adapter can verify (DAT-267); `rosterVisibility` still
 * takes the more restrictive of this value and the adapter's runtime claim.
 */

import type { PermissionVisibility } from "../control-plane/provider-access-types.js";
import type { ProviderType } from "../control-plane/types.js";

export const PROVIDER_PERMISSION_VISIBILITY: Readonly<Record<ProviderType, PermissionVisibility>> =
  Object.freeze({
    // The collaborator list plus organization owners covers every access path
    // GitHub exposes; absence from a complete roster is a removal.
    github: "full",
    // Shared groups are enumerated, but members of nested shared groups and
    // share-link expiry are not observable, so absence is never a removal.
    gitlab: "partial",
  });

/** What an integration for this provider type can be recorded as proving. */
export function permissionVisibilityForProvider(provider: ProviderType): PermissionVisibility {
  return PROVIDER_PERMISSION_VISIBILITY[provider];
}
