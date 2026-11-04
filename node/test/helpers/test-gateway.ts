import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import {
  createModelGateway,
  createStaticCredentialStore,
  createStaticPolicyResolver,
} from "../../src/gateway/index.js";
import type {
  GatewayAttemptEvent,
  GatewayEventSink,
  GatewayPolicy,
  ModelGateway,
  SecretScanPolicy,
  SecretScanner,
  SecretScanReport,
} from "../../src/gateway/index.js";
import type { UsageLedgerSink } from "../../src/ledger/index.js";
import { DATA_CLASSES } from "../../src/gateway/index.js";

/** Scope the test policies resolve for; matches the test configs' identity. */
export const TEST_SCOPE = { enterpriseId: "ent_test", workspaceId: "ws_test" };

/**
 * Scanner stub for suites that are not about secret scanning: it reports a
 * clean request so unrelated flows exercise the gateway checks unchanged.
 * The scan-gate suites use the real `createPatternSecretScanner`.
 */
export const cleanTestScanner: SecretScanner = {
  id: "clean-test-scanner",
  ruleVersion: "test",
  scan(): SecretScanReport {
    return {
      scanner: "clean-test-scanner",
      ruleVersion: "test",
      classification: "clean",
      findings: [],
    };
  },
};

/** In-memory sink so test gateways satisfy the required audit sink. */
export function memorySink(): { sink: GatewayEventSink; events: GatewayAttemptEvent[] } {
  const events: GatewayAttemptEvent[] = [];
  return {
    sink: {
      record(event: GatewayAttemptEvent) {
        events.push(event);
      },
    },
    events,
  };
}

/** Fixed run identity for direct gateway tests. */
export const TEST_BINDING = {
  ...TEST_SCOPE,
  issueId: "issue_test",
  runId: "run_test",
  traceId: "trace_test",
};

export const TEST_ENDPOINT_BASE_URL = "https://gateway.test/v1";
export const TEST_CREDENTIAL_REF = "test-credential";
export const TEST_CREDENTIAL = "test-secret";

/** Policy approving one model at one registered test endpoint. */
export function testPolicyFor(
  model: Model<Api>,
  overrides: Partial<GatewayPolicy> = {},
): GatewayPolicy {
  return {
    revision: "test-policy-1",
    endpoints: [
      {
        endpointId: "ep_test",
        provider: model.provider,
        api: model.api,
        baseUrl: TEST_ENDPOINT_BASE_URL,
        internal: false,
        credentialRef: TEST_CREDENTIAL_REF,
        models: [model.id],
        permittedDataClasses: [...DATA_CLASSES],
      },
    ],
    retry: { maxAttempts: 1 },
    ...overrides,
  };
}

/**
 * A real ModelGateway whose transport is a scripted stream: the scripted
 * turns stand in for the model, but policy resolution, endpoint matching,
 * credential resolution, identity, and audit recording are the real gateway.
 */
export function scriptedGateway(
  model: Model<Api>,
  stream: StreamFn,
  extras: {
    policy?: GatewayPolicy;
    credentials?: Record<string, string>;
    sink?: GatewayEventSink;
    scanner?: SecretScanner;
    scanPolicy?: SecretScanPolicy;
    usageLedger?: UsageLedgerSink;
  } = {},
): ModelGateway {
  return createModelGateway({
    policyResolver: createStaticPolicyResolver(extras.policy ?? testPolicyFor(model), TEST_SCOPE),
    credentials: createStaticCredentialStore(
      extras.credentials ?? { [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL },
    ),
    adapter: { stream },
    scanner: extras.scanner ?? cleanTestScanner,
    ...(extras.scanPolicy ? { scanPolicy: extras.scanPolicy } : {}),
    // Every dispatch needs its required audit sink; default an in-memory one.
    sink: extras.sink ?? memorySink().sink,
    ...(extras.usageLedger ? { usageLedger: extras.usageLedger } : {}),
  });
}
