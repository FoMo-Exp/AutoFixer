import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createStaticServiceCredentialStore,
  issueCheckoutCapability,
  issueDeliveryCapability,
  readServiceCredentialFile,
  scrubForLog,
  scrubForPiContext,
  scrubForRenderer,
  taskWorkspaceEnv,
  withServiceCredential,
} from "../src/provider-access/credentials.js";
import { setupFixture, type Fixture } from "./helpers/provider-access.js";

const SECRET_SOURCE = "ghs_source_secret_value_0123456789abcdef";
const SECRET_CHECKOUT = "ghs_checkout_secret_value_0123456789abcdef";
const SECRET_DELIVERY = "ghs_delivery_secret_value_0123456789abcdef";

function store() {
  return createStaticServiceCredentialStore({
    "svc-source-1": SECRET_SOURCE,
    "svc-checkout-1": SECRET_CHECKOUT,
    "svc-delivery-1": SECRET_DELIVERY,
  });
}

describe("service credential boundary", () => {
  test("secrets resolve only by reference and never leave the callback scope", () => {
    const credentials = store();
    const seen: string[] = [];
    withServiceCredential(credentials, "svc-source-1", (secret) => {
      seen.push(secret);
      return "handle-result";
    });
    expect(seen).toEqual([SECRET_SOURCE]);
    // The store itself only answers by reference.
    expect(credentials.get("unknown-ref")).toBeUndefined();
  });

  test("an unavailable credential is an error, not an empty string", () => {
    expect(() => withServiceCredential(store(), "svc-missing", (secret) => secret)).toThrow(
      /not available in the credential boundary/,
    );
  });

  test("control-plane rows carry credential references, never secrets", () => {
    const fixture: Fixture = setupFixture();
    const dump = JSON.stringify({
      integrations: fixture.access.integrations.listByWorkspace(fixture.scope),
      authority: fixture.access.roster.listAuthority(fixture.scope, fixture.integration.id),
      events: fixture.access.events.list(fixture.adminScope, {}),
      runs: fixture.access.reconcileRuns.list(fixture.scope, fixture.integration.id),
    });
    expect(dump).toContain("svc-source-1");
    expect(dump).not.toContain(SECRET_SOURCE);
    expect(dump).not.toContain(SECRET_CHECKOUT);
    expect(dump).not.toContain(SECRET_DELIVERY);
  });

  test("checkout and delivery capabilities are separate credentials", () => {
    const fixture: Fixture = setupFixture();
    const checkout = issueCheckoutCapability(fixture.integration, "2026-11-03T12:15:00.000Z");
    expect(checkout.capability).toBe("checkout_read");
    expect(checkout.credential_ref).toBe("svc-checkout-1");
    // A checkout handle can never name the delivery credential.
    expect(JSON.stringify(checkout)).not.toContain("svc-delivery-1");
    expect(JSON.stringify(checkout)).not.toContain(SECRET_DELIVERY);

    const delivery = issueDeliveryCapability(
      fixture.integration,
      "main",
      "2026-11-03T12:05:00.000Z",
    );
    expect(delivery.capability).toBe("delivery_write");
    expect(delivery.branch_scope).toBe("main");
    expect(delivery.expires_at).toBe("2026-11-03T12:05:00.000Z");
  });

  test("delivery capability is never handed out when the integration has no delivery credential", () => {
    const fixture: Fixture = setupFixture();
    const integration = { ...fixture.integration, delivery_credential_ref: null };
    expect(() => issueDeliveryCapability(integration, "main", "2026-11-03T12:05:00.000Z")).toThrow(
      /no delivery credential/,
    );
    const checkoutless = { ...fixture.integration, checkout_credential_ref: null };
    expect(() => issueCheckoutCapability(checkoutless, "2026-11-03T12:15:00.000Z")).toThrow(
      /no checkout credential/,
    );
  });
});

describe("credentials never reach Pi, renderer, logs, or task workspaces", () => {
  const secrets = [SECRET_SOURCE, SECRET_CHECKOUT, SECRET_DELIVERY];
  const payload = {
    credential_ref: "svc-source-1",
    source_credential_ref: "svc-source-1",
    repository_id: "github:repo:9001",
    authorization: `Bearer ${SECRET_SOURCE}`,
    note: `key used ${SECRET_DELIVERY}`,
    nested: { api_key: SECRET_CHECKOUT, text: `leak? ${SECRET_CHECKOUT}` },
  };

  test("renderer payloads are scrubbed", () => {
    const scrubbed = JSON.stringify(scrubForRenderer(payload, secrets));
    for (const secret of secrets) {
      expect(scrubbed).not.toContain(secret);
    }
    // Credential-shaped keys are redacted wholesale — references included;
    // plain metadata stays visible for debugging.
    expect(scrubbed).toContain("github:repo:9001");
  });

  test("Pi context is scrubbed", () => {
    const scrubbed = JSON.stringify(scrubForPiContext(payload, secrets));
    for (const secret of secrets) {
      expect(scrubbed).not.toContain(secret);
    }
  });

  test("ordinary logs are scrubbed", () => {
    const line = `checkout failed with token ${SECRET_SOURCE} for ${SECRET_CHECKOUT}`;
    const scrubbed = scrubForLog(line, secrets);
    for (const secret of secrets) {
      expect(scrubbed).not.toContain(secret);
    }
    // Pattern-based scrubbing catches shapes even for secrets the boundary
    // never resolved.
    expect(scrubForLog("Bearer ghp_abcdefghijklmnopqrstuvwx")).not.toContain("ghp_");
  });

  test("task workspace environments carry no credentials at all", () => {
    const fixture: Fixture = setupFixture();
    const env = taskWorkspaceEnv(fixture.integration);
    const dump = JSON.stringify(env);
    for (const secret of secrets) {
      expect(dump).not.toContain(secret);
    }
    // Not even credential references: a task workspace has no lookup path.
    expect(dump).not.toContain("svc-source-1");
    expect(dump).not.toContain("svc-checkout-1");
    expect(dump).not.toContain("svc-delivery-1");
    expect(env.AUTOFIXER_CREDENTIALS).toBe("brokered");
  });
});

describe("protected credential files", () => {
  test("world-readable credential files are refused", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svc-cred-"));
    const file = path.join(dir, "credentials.json");
    writeFileSync(file, JSON.stringify({ "svc-source-1": SECRET_SOURCE }));
    chmodSync(file, 0o644);
    if (process.platform === "win32") {
      // Permission bits are not enforced on Windows.
      expect(() => readServiceCredentialFile(file)).not.toThrow();
      return;
    }
    expect(() => readServiceCredentialFile(file)).toThrow(/owner-only permissions/);
  });

  test("owner-only credential files load; entries map refs to secrets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svc-cred-"));
    const file = path.join(dir, "credentials.json");
    writeFileSync(file, JSON.stringify({ "svc-source-1": SECRET_SOURCE }));
    chmodSync(file, 0o600);
    const credentials = readServiceCredentialFile(file);
    expect(credentials.get("svc-source-1")).toBe(SECRET_SOURCE);
  });

  test("malformed credential files are refused", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svc-cred-"));
    const file = path.join(dir, "credentials.json");
    writeFileSync(file, JSON.stringify({ "svc-source-1": "" }));
    chmodSync(file, 0o600);
    expect(() => readServiceCredentialFile(file)).toThrow(/non-empty ref/);
  });
});
