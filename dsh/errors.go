package dsh

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Error codes from docs/contracts/dsh-control-v1.md. Every error response
// uses the contract's envelope; codes outside this list are not invented for
// protocol failures either — boot-token failures reuse DSH_SCOPE_DENIED with
// a `reason` detail.
const (
	CodeInvalidRequest             = "INVALID_REQUEST"
	CodeInvalidRepositoryIdentity  = "INVALID_REPOSITORY_IDENTITY"
	CodeInvalidBaseSHA             = "INVALID_BASE_SHA"
	CodeInvalidActionIntent        = "INVALID_ACTION_INTENT"
	CodeInvalidToolArguments       = "INVALID_TOOL_ARGUMENTS"
	CodeInvalidEventCursor         = "INVALID_EVENT_CURSOR"
	CodeInvalidLimit               = "INVALID_LIMIT"
	CodeProtocolUnsupported        = "PROTOCOL_VERSION_UNSUPPORTED"
	CodeScopeDenied                = "DSH_SCOPE_DENIED"
	CodePolicyDenied               = "DSH_POLICY_DENIED"
	CodeToolNotAllowlisted         = "DSH_TOOL_NOT_ALLOWLISTED"
	CodeApproverNotAuthorized      = "DSH_APPROVER_NOT_AUTHORIZED"
	CodeCancellerNotAuthorized     = "DSH_CANCELLER_NOT_AUTHORIZED"
	CodeApprovalRequired           = "DSH_APPROVAL_REQUIRED"
	CodeGrantExpired               = "DSH_GRANT_EXPIRED"
	CodeGrantRevoked               = "DSH_GRANT_REVOKED"
	CodeRunBusy                    = "DSH_RUN_BUSY"
	CodeIdempotencyConflict        = "IDEMPOTENCY_CONFLICT"
	CodeTaskAlreadyHasActiveRun    = "TASK_ALREADY_HAS_ACTIVE_RUN"
	CodeTaskStateConflict          = "TASK_STATE_CONFLICT"
	CodeApprovalAlreadyRecorded    = "APPROVAL_ALREADY_RECORDED"
	CodeActionAlreadySubmitted     = "ACTION_ALREADY_SUBMITTED"
	CodeApprovalScopeMismatch      = "DSH_APPROVAL_SCOPE_MISMATCH"
	CodeApprovalWindowExpired      = "DSH_APPROVAL_WINDOW_EXPIRED"
	CodeRunNotFound                = "RUN_NOT_FOUND"
	CodeToolNotRegistered          = "TOOL_NOT_REGISTERED"
	CodeArtifactNotFound           = "ARTIFACT_NOT_FOUND"
	CodeArtifactNotFinalized       = "ARTIFACT_NOT_FINALIZED"
	CodeEvidenceBundleNotFinalized = "EVIDENCE_BUNDLE_NOT_FINALIZED"
	CodeRiskProhibited             = "DSH_RISK_PROHIBITED"
	CodeUnavailable                = "DSH_UNAVAILABLE"
	CodeEvidenceStoreUnavailable   = "DSH_EVIDENCE_STORE_UNAVAILABLE"
	CodeSandboxUnavailable         = "DSH_SANDBOX_UNAVAILABLE"
	CodeCancellationControlFailure = "DSH_CANCELLATION_CONTROL_FAILURE"
	CodeEvidenceRetentionExpired   = "EVIDENCE_RETENTION_EXPIRED"
	CodeEvidenceRetained           = "EVIDENCE_RETAINED"
)

type errorEnvelope struct {
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	RequestID string         `json:"request_id"`
	Retryable bool           `json:"retryable"`
	Details   map[string]any `json:"details"`
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	payload := errorEnvelope{Error: errorPayload{
		Code:      code,
		Message:   message,
		RequestID: requestIDOf(r),
		Retryable: status == http.StatusServiceUnavailable || status == http.StatusTooManyRequests,
		Details:   details,
	}}
	writeJSON(w, status, payload)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	raw, err := json.Marshal(body)
	if err != nil {
		// The envelope itself is built from plain values, so a failure here
		// is a programming error rather than a client problem.
		http.Error(w, `{"error":{"code":"DSH_UNAVAILABLE","message":"response could not be encoded","request_id":"","retryable":true,"details":{}}}`,
			http.StatusServiceUnavailable)
		return
	}
	w.Header().Set(HeaderContentType, contentTypeJSON)
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func requestIDOf(r *http.Request) string {
	if r == nil {
		return ""
	}
	return r.Header.Get(HeaderRequestID)
}

// apiErrorf builds a handler-level failure with an HTTP status and contract
// code.
func apiErrorf(status int, code, format string, args ...any) *requestError {
	return &requestError{
		status:  status,
		code:    code,
		message: fmt.Sprintf(format, args...),
	}
}
