import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

import {
  createModelGateway,
  createScopeBackedPolicyResolver,
  createStaticCredentialStore,
} from "../../src/gateway/index.js";
import type {
  DependentWorkHold,
  GatewayAttemptEvent,
  GatewayCaseIntake,
  GatewayEventSink,
  GatewayPolicy,
  GatewayScope,
  GatewayScopeBinding,
  ModelGateway,
  SecretScanPolicy,
  SecretScanner,
  SecretScanReport,
} from "../../src/gateway/index.js";
import type { AuthenticatedPrincipal } from "../../src/control-plane/request-scope.js";
import type { UsageLedgerSink } from "../../src/ledger/index.js";
import { DATA_CLASSES } from "../../src/gateway/index.js";

/** Scope the test policies resolve for; matches the test configs' identity. */
export const TEST_SCOPE = { enterpriseId: "ent_test", workspaceId: "ws_test" };

/**
 * A fixed scope binding: the test-seam stand-in for the DAT-241 helper's
 * authenticated resolution. Tests that exercise the authoritative pipeline
 * itself (isolation, revocation) build bindings from `resolveRequestScope`
 * instead.
 */
export function fixedScopeBinding(scope: GatewayScope): GatewayScopeBinding {
  return { ...scope, scopeAuthority: { resolve: () => scope } };
}

/** Fixed run-scope seam for orchestrator tests (behind real gateway checks). */
export function testRunScope(): (principal: AuthenticatedPrincipal | null) => GatewayScopeBinding {
  return () => fixedScopeBinding(TEST_SCOPE);
}

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
  ...fixedScopeBinding(TEST_SCOPE),
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
 * Benign disposal-case and hold stubs for suites that exercise other gateway
 * behavior: a block "opens" a stub case and no run is ever held. Suites that
 * exercise the security machinery wire the real `SecurityCaseService` for
 * both seams instead.
 */
export function securityStubs(): {
  caseIntake: GatewayCaseIntake;
  dependentWorkHold: DependentWorkHold;
} {
  let counter = 0;
  return {
    caseIntake: {
      recordGatewayBlock: () => {
        counter += 1;
        return Promise.resolve({
          caseId: `case_stub_${counter}`,
          caseReference: `cr1.stub_${counter}`,
        });
      },
    },
    dependentWorkHold: { heldCaseFor: () => undefined },
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
    policyResolver: createScopeBackedPolicyResolver([
      { scope: TEST_SCOPE, policy: extras.policy ?? testPolicyFor(model) },
    ]),
    credentials: createStaticCredentialStore(
      extras.credentials ?? { [TEST_CREDENTIAL_REF]: TEST_CREDENTIAL },
    ),
    adapter: { stream },
    scanner: extras.scanner ?? cleanTestScanner,
    ...(extras.scanPolicy ? { scanPolicy: extras.scanPolicy } : {}),
    // Every dispatch needs its required audit sink; default an in-memory one.
    sink: extras.sink ?? memorySink().sink,
    ...securityStubs(),
    ...(extras.usageLedger ? { usageLedger: extras.usageLedger } : {}),
  });
}
