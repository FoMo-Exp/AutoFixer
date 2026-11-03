/**
 * Service credential boundary for repository integrations (DAT-203).
 *
 * The separately installed, repository-scoped service integration holds three
 * distinct capabilities with three distinct credentials:
 *
 * - **source** — read-only identity of the installation itself;
 * - **checkout** — read capability for code checkout;
 * - **delivery** — narrowly scoped, expiring write capability for delivery.
 *
 * Secrets live only behind this boundary. Control-plane rows, audit events,
 * provider events, and capability grants carry credential *references*; the
 * values are resolved here and never cross into Pi, the renderer, ordinary
 * application logs, or a task workspace. The boundary deliberately has no
 * environment-variable store: an env lookup is exactly the bypass it exists
 * to prevent.
 */

import fs from "node:fs";
import path from "node:path";

import { redactSensitiveText } from "../errors/redact.js";
import type { CapabilityKind, ServiceIntegration } from "../control-plane/provider-access-types.js";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ServiceCredentialStore {
  /** Resolve a credential reference to its secret. Reference only in, value only out. */
  get(credentialRef: string): string | undefined;
}

/** In-memory store for tests and programmatic service-side injection. */
export function createStaticServiceCredentialStore(
  entries: Readonly<Record<string, string>>,
): ServiceCredentialStore {
  const byRef = new Map(Object.entries(entries));
  return {
    get(credentialRef: string): string | undefined {
      return byRef.get(credentialRef);
    },
  };
}

/**
 * Load service credentials from a protected JSON file mapping
 * `credentialRef -> secret`. Same protections as the gateway credential file:
 * a regular file with owner-only permissions, opened without following
 * symlinks so a planted link cannot swap in between check and use.
 */
export function readServiceCredentialFile(file: string): ServiceCredentialStore {
  const flags =
    fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`refusing to read service credentials from non-regular file ${file}`);
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error(
        `service credentials file ${path.basename(file)} must have owner-only permissions (0600)`,
      );
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("service credentials file must be a JSON object of credentialRef -> secret");
    }
    const entries: Record<string, string> = {};
    for (const [ref, secret] of Object.entries(parsed)) {
      if (ref.trim() === "" || typeof secret !== "string" || secret === "") {
        throw new Error("service credentials file entries must map a non-empty ref to a secret");
      }
      entries[ref] = secret;
    }
    return createStaticServiceCredentialStore(entries);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Capability materialization
// ---------------------------------------------------------------------------

/**
 * A capability handle is what checkout/delivery code carries around: the
 * reference and expiry, never the secret. Materialization happens through
 * {@link withServiceCredential} at the single point of use.
 */
export interface CapabilityHandle {
  integration_id: string;
  capability: CapabilityKind;
  credential_ref: string;
  expires_at: string;
}

/**
 * Materialize the checkout (read) capability of one integration inside a
 * broker callback. The secret exists only for the duration of `fn`; the
 * return value of `fn` must not include it (callers return handles, never
 * credentials).
 */
export function withServiceCredential<T>(
  store: ServiceCredentialStore,
  credentialRef: string,
  fn: (secret: string) => T,
): T {
  const secret = store.get(credentialRef);
  if (secret === undefined) {
    throw new Error(
      `service credential ${credentialRef} is not available in the credential boundary`,
    );
  }
  return fn(secret);
}

/**
 * Build the checkout capability handle for an integration. Only the
 * reference travels with the handle; `withServiceCredential` resolves it at
 * the point of use. Delivery write requires its own, separately scoped and
 * expiring grant — it is never handed out here.
 */
export function issueCheckoutCapability(
  integration: ServiceIntegration,
  expiresAt: string,
): CapabilityHandle {
  if (!integration.checkout_credential_ref) {
    throw new Error(`integration ${integration.id} has no checkout credential`);
  }
  return {
    integration_id: integration.id,
    capability: "checkout_read",
    credential_ref: integration.checkout_credential_ref,
    expires_at: expiresAt,
  };
}

/** Build the delivery (write) capability handle; always expiring, branch-scoped. */
export function issueDeliveryCapability(
  integration: ServiceIntegration,
  branchScope: string,
  expiresAt: string,
): CapabilityHandle & { branch_scope: string } {
  if (!integration.delivery_credential_ref) {
    throw new Error(`integration ${integration.id} has no delivery credential`);
  }
  return {
    integration_id: integration.id,
    capability: "delivery_write",
    credential_ref: integration.delivery_credential_ref,
    branch_scope: branchScope,
    expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Leak-proof surfaces
// ---------------------------------------------------------------------------

/** Keys whose values are credential material wherever they appear. */
const SECRET_KEY_PATTERN = /(credential|secret|token|password|passwd|authorization|api[_-]?key)/i;

const REDACTED = "[redacted]";

function scrubDeep(value: unknown, literals: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value, literals);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, literals));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : scrubDeep(item, literals);
    }
    return out;
  }
  return value;
}

/**
 * Scrub credential material out of anything about to be written to ordinary
 * application logs. Text goes through the shared redactor plus the literal
 * secrets this boundary resolved.
 */
export function scrubForLog(text: string, secrets: readonly (string | undefined)[] = []): string {
  return redactSensitiveText(
    text,
    secrets.filter((s): s is string => typeof s === "string"),
  );
}

/** Scrub anything about to cross to the renderer. */
export function scrubForRenderer<T>(
  value: T,
  secrets: readonly (string | undefined)[] = [],
): unknown {
  return scrubDeep(
    value,
    secrets.filter((s): s is string => typeof s === "string"),
  );
}

/**
 * Scrub anything entering Pi — prompts, tool results, summaries, context
 * blocks. Pi must never observe service credentials.
 */
export function scrubForPiContext<T>(
  value: T,
  secrets: readonly (string | undefined)[] = [],
): unknown {
  return scrubDeep(
    value,
    secrets.filter((s): s is string => typeof s === "string"),
  );
}

/**
 * Environment for a task workspace. Deliberately contains no credential
 * values and no credential references — a task workspace is not the server
 * credential boundary, and checkout/delivery run through the broker instead.
 */
export function taskWorkspaceEnv(integration: ServiceIntegration): Record<string, string> {
  return {
    AUTOFIXER_INTEGRATION_ID: integration.id,
    AUTOFIXER_REPOSITORY_ID: integration.repository_id,
    AUTOFIXER_REPOSITORY_NAME: integration.repository_name,
    // Explicit marker so leaks are diagnosable instead of silent.
    AUTOFIXER_CREDENTIALS: "brokered",
  };
}
