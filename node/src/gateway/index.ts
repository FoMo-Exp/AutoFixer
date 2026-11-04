export { piAiProviderAdapter, buildAdapterOptions } from "./adapter.js";
export type { ProviderAdapter } from "./adapter.js";
export {
  createStaticCredentialStore,
  readCredentialFile,
  providerCredentialEnvVars,
  PROVIDER_CREDENTIAL_ENV_VARS,
} from "./credentials.js";
export type { GatewayCredentialStore } from "./credentials.js";
export { createFileEventSink } from "./file-sink.js";
export { ModelGateway, createModelGateway } from "./gateway.js";
export type { ModelGatewayDeps } from "./gateway.js";
export {
  createPatternSecretScanner,
  defaultSecretDetectors,
  PATTERN_SCANNER_RULE_VERSION,
} from "./pattern-scanner.js";
export type { SecretDetector } from "./pattern-scanner.js";
export {
  createScopeBackedPolicyResolver,
  denyAllPolicyResolver,
  loadGatewayPolicyFile,
  matchEndpoint,
  matchFallback,
  parseScopedPolicies,
  validateGatewayPolicy,
} from "./policy.js";
export type { EndpointMatch, GatewayPolicyResolver, ScopedPolicyBinding } from "./policy.js";
export { scrubSecrets } from "./redact.js";
export {
  authorizeRequestDataClasses,
  collectRequestSegments,
  joinClassification,
  runRequestScanGate,
  segmentId,
  tagDerivedSummary,
} from "./scan.js";
export type {
  CollectedRequest,
  DerivedClassificationPolicy,
  DerivedProvenance,
  DeterministicPolicyRef,
  MinimizationPolicy,
  ScanDenyReason,
  ScanGateDeps,
  ScanGateResult,
  ScannableSegment,
  SecretFinding,
  SecretScanPolicy,
  SecretScanReport,
  SecretScanRequest,
  SecretScanner,
} from "./scan.js";
export {
  DATA_CLASSES,
  MODEL_EGRESS_DENIED,
  PROVIDER_USAGE_DIAGNOSTIC,
  ModelDispatchError,
  ModelEgressDeniedError,
  SECURITY_REVIEW_REQUIRED,
  SENSITIVE_DATA_UNCERTAIN,
} from "./types.js";
export type {
  ApprovedEndpoint,
  DataClass,
  DependentWorkHold,
  GatewayAttemptDestination,
  GatewayAttemptEvent,
  GatewayBindingIdentity,
  GatewayCaseIntake,
  GatewayDenyReason,
  GatewayEventSink,
  GatewayFallback,
  GatewayPolicy,
  GatewayRequestIdentity,
  GatewayScope,
  GatewayScopeAuthority,
  GatewayScopeBinding,
  RequestScanEvidence,
  SecretClassification,
} from "./types.js";
