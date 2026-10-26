package dsh

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func createRun(t *testing.T, env *testEnv, body createRequest) createRunResponse {
	t.Helper()
	status, raw := env.do("POST", "/v1/runs", body)
	wantStatus(t, status, raw, http.StatusCreated)
	return decodeInto[createRunResponse](t, raw)
}

func getRun(t *testing.T, env *testEnv, runID string) runResponse {
	t.Helper()
	status, raw := env.do("GET", "/v1/runs/"+runID, nil)
	wantStatus(t, status, raw, http.StatusOK)
	return decodeInto[runResponse](t, raw)
}

func getBundle(t *testing.T, env *testEnv, runID string) bundleResponse {
	t.Helper()
	status, raw := env.do("GET", "/v1/runs/"+runID+"/evidence-bundle", nil)
	wantStatus(t, status, raw, http.StatusOK)
	return decodeInto[bundleResponse](t, raw)
}

func getEvents(t *testing.T, env *testEnv, runID, query string) eventsResponse {
	t.Helper()
	path := "/v1/runs/" + runID + "/events"
	if query != "" {
		path += "?" + query
	}
	status, raw := env.do("GET", path, nil)
	wantStatus(t, status, raw, http.StatusOK)
	return decodeInto[eventsResponse](t, raw)
}

func cancelRun(t *testing.T, env *testEnv, runID, identity string) (int, []byte) {
	t.Helper()
	return env.do("POST", "/v1/runs/"+runID+"/cancel", cancelBody(identity))
}

func TestLowRiskRunIsGrantedWithoutApproval(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_low"))

	if created.State != "approved" {
		t.Fatalf("state = %q, want approved", created.State)
	}
	if created.Grant == nil {
		t.Fatalf("low-risk run must return a grant summary")
	}
	if created.RequiredAction != nil {
		t.Fatalf("low-risk run must not require approval, got %+v", created.RequiredAction)
	}
	if created.RiskAssessment.RiskClass != "low" {
		t.Fatalf("risk class = %q, want low", created.RiskAssessment.RiskClass)
	}
	if created.RiskAssessment.ElevatedApprovalReference != nil {
		t.Fatalf("low-risk assessment must carry a null elevated approval reference")
	}
	if created.Grant.ScopeDigest == "" || created.Grant.MaxWallClockSeconds != 60 {
		t.Fatalf("unexpected grant summary: %+v", created.Grant)
	}

	run := getRun(t, env, created.RunID)
	if run.State != "approved" || run.GrantStatus.State != "active" {
		t.Fatalf("run read-back unexpected: state=%q grant=%q", run.State, run.GrantStatus.State)
	}
	if run.BundleAvailable {
		t.Fatalf("a non-terminal run must not offer a bundle")
	}
	if run.GrantStatus.ScopeDigest != created.Grant.ScopeDigest {
		t.Fatalf("scope digest mismatch between create and read")
	}
}

func TestElevatedRunNeedsScopedApprovalBeforeExecution(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, elevatedCreate("tsk_elevated"))

	if created.State != "requested" {
		t.Fatalf("state = %q, want requested", created.State)
	}
	if created.Grant != nil {
		t.Fatalf("elevated run must not be granted at creation")
	}
	if created.RequiredAction == nil || created.RequiredAction.Type != "approval" {
		t.Fatalf("elevated run must carry required_action, got %+v", created.RequiredAction)
	}
	if created.RiskAssessment.RiskClass != "elevated" {
		t.Fatalf("risk class = %q, want elevated", created.RiskAssessment.RiskClass)
	}
	if created.RiskAssessment.ElevatedApprovalReference != nil {
		t.Fatalf("pre-approval assessment must not claim an approval reference")
	}

	// Actions are refused until the approval issues a grant.
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_too_early"))
	wantError(t, status, raw, http.StatusPreconditionRequired, CodeApprovalRequired)

	// Scope digest binds the approval to the requested scope.
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/approvals",
		approvalBody("apr_wrong_scope", "approve", "sha256:deadbeef"))
	wantError(t, status, raw, http.StatusConflict, CodeApprovalScopeMismatch)

	unauthorized := approvalBody("apr_bad_actor", "approve", created.RequiredAction.ScopeDigest)
	unauthorized["approved_by"] = map[string]any{"actor_id": "usr_evil", "identity": "github:mallory"}
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/approvals", unauthorized)
	wantError(t, status, raw, http.StatusForbidden, CodeApproverNotAuthorized)

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/approvals",
		approvalBody("apr_ok", "approve", created.RequiredAction.ScopeDigest))
	wantStatus(t, status, raw, http.StatusOK)
	approved := decodeInto[approvalResponse](t, raw)
	if approved.State != "approved" || approved.Grant == nil || approved.AuditEventReference == "" {
		t.Fatalf("unexpected approval response: %+v", approved)
	}

	run := getRun(t, env, created.RunID)
	if run.RiskAssessment.ElevatedApprovalReference == nil {
		t.Fatalf("approved elevated run must carry its approval reference")
	}
	if run.RiskAssessment.ElevatedApprovalReference.ApproverIdentity != "github:aphrodite" {
		t.Fatalf("unexpected approver: %+v", run.RiskAssessment.ElevatedApprovalReference)
	}

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/approvals",
		approvalBody("apr_again", "approve", created.RequiredAction.ScopeDigest))
	wantError(t, status, raw, http.StatusConflict, CodeApprovalAlreadyRecorded)

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_elevated"))
	wantStatus(t, status, raw, http.StatusAccepted)

	status, raw = cancelRun(t, env, created.RunID, "github:aphrodite")
	wantStatus(t, status, raw, http.StatusAccepted)
	bundle := getBundle(t, env, created.RunID)
	if bundle.State != "cancelled" || bundle.Bundle.ContractVersion != "1.0.0" {
		t.Fatalf("unexpected bundle: state=%q contract=%q", bundle.State, bundle.Bundle.ContractVersion)
	}
}

func TestElevatedRunWithoutApprovalHasNoFinalBundle(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, elevatedCreate("tsk_elevated_cancel"))

	status, raw := cancelRun(t, env, created.RunID, "github:aphrodite")
	wantStatus(t, status, raw, http.StatusAccepted)

	status, raw = env.do("GET", "/v1/runs/"+created.RunID+"/evidence-bundle", nil)
	body := wantError(t, status, raw, http.StatusConflict, CodeEvidenceBundleNotFinalized)
	if body.Error.Details["reason"] != "approval_reference_missing" {
		t.Fatalf("unexpected detail: %+v", body.Error.Details)
	}
}

func TestProhibitedRiskIsRejectedWithTerminalEvidence(t *testing.T) {
	env := startEnv(t)
	status, raw := env.do("POST", "/v1/runs", prohibitedCreate("tsk_prohibited"))
	body := wantError(t, status, raw, http.StatusUnprocessableEntity, CodeRiskProhibited)
	runID, _ := body.Error.Details["run_id"].(string)
	if runID == "" {
		t.Fatalf("prohibited rejection must expose the evidenced run id: %+v", body.Error.Details)
	}
	if body.Error.Details["state"] != "rejected" {
		t.Fatalf("unexpected state detail: %+v", body.Error.Details)
	}

	run := getRun(t, env, runID)
	if run.State != "rejected" || run.RiskAssessment.RiskClass != "prohibited" {
		t.Fatalf("unexpected run: state=%q risk=%q", run.State, run.RiskAssessment.RiskClass)
	}
	if !run.BundleAvailable {
		t.Fatalf("rejected prohibited run must expose a terminal bundle")
	}

	bundle := getBundle(t, env, runID)
	if bundle.Bundle.RiskAssessment.ElevatedApprovalReference != nil {
		t.Fatalf("prohibited assessment must keep a null approval reference")
	}
	if len(bundle.Bundle.ExecutionEvents) == 0 {
		t.Fatalf("prohibited run must retain its evidence chain")
	}
}

func TestActionLifecycleKeepsEvidenceAndTerminalBundle(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_action"))

	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_1"))
	wantStatus(t, status, raw, http.StatusAccepted)
	accepted := decodeInto[actionResponse](t, raw)
	if accepted.AcceptedToolID != "echo" || accepted.State != "running" || accepted.AuditEventReference == "" {
		t.Fatalf("unexpected action response: %+v", accepted)
	}

	run := getRun(t, env, created.RunID)
	if run.ExecutionCounts.ActionsTotal != 1 || run.ExecutionCounts.ActionsAllowed != 1 {
		t.Fatalf("unexpected execution counts: %+v", run.ExecutionCounts)
	}

	events := getEvents(t, env, created.RunID, "")
	if len(events.Events) < 2 {
		t.Fatalf("expected transition and tool events, got %d", len(events.Events))
	}
	var sawDispatch, sawOutcome bool
	for _, event := range events.Events {
		if event.EventType != "tool_invocation" || event.DecisionOrStopCode == nil {
			continue
		}
		if *event.DecisionOrStopCode == "allow_within_grant" {
			if event.ExitStatus == nil {
				sawDispatch = true
			} else {
				sawOutcome = true
				if event.OutputDigest == nil || event.OutputDigest.Algorithm != "sha256" {
					t.Fatalf("completion event must carry an output digest: %+v", event)
				}
			}
		}
	}
	if !sawDispatch || !sawOutcome {
		t.Fatalf("dispatch and completion must be distinct evidenced events (dispatch=%v outcome=%v)", sawDispatch, sawOutcome)
	}

	// Duplicate action ids are refused.
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_1"))
	wantError(t, status, raw, http.StatusConflict, CodeActionAlreadySubmitted)

	status, raw = cancelRun(t, env, created.RunID, "github:aphrodite")
	wantStatus(t, status, raw, http.StatusAccepted)

	bundle := getBundle(t, env, created.RunID)
	if bundle.State != "cancelled" {
		t.Fatalf("bundle state = %q, want cancelled", bundle.State)
	}
	if err := bundle.Bundle.Validate(); err != nil {
		t.Fatalf("bundle failed validation: %v", err)
	}
	if len(bundle.Bundle.EvidenceReferences) == 0 {
		t.Fatalf("bundle must carry evidence references")
	}

	// Cancelling a terminal run replays the terminal state.
	status, raw = cancelRun(t, env, created.RunID, "github:aphrodite")
	wantStatus(t, status, raw, http.StatusOK)
	replay := decodeInto[cancelResponse](t, raw)
	if replay.CancellationRequested {
		t.Fatalf("terminal cancel must not claim a new cancellation: %+v", replay)
	}
}

func TestUnregisteredToolIsDeniedWithEvidence(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_unregistered"))

	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_warmup"))
	wantStatus(t, status, raw, http.StatusAccepted)

	shell := echoAction("act_shell")
	shell.Intent.ToolID = "sh"
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions", shell)
	wantError(t, status, raw, http.StatusNotFound, CodeToolNotRegistered)

	run := getRun(t, env, created.RunID)
	if run.State != "stopped" {
		t.Fatalf("an out-of-grant dispatch must stop the run, got %q", run.State)
	}
	events := getEvents(t, env, created.RunID, "")
	var denial string
	for _, event := range events.Events {
		if event.EventType == "tool_invocation" && event.DecisionOrStopCode != nil &&
			strings.HasPrefix(*event.DecisionOrStopCode, "deny_") {
			denial = *event.DecisionOrStopCode
		}
	}
	if denial == "" {
		t.Fatalf("unregistered tool attempt must leave a denial event: %+v", events.Events)
	}

	bundle := getBundle(t, env, created.RunID)
	if bundle.State != "stopped" {
		t.Fatalf("bundle state = %q, want stopped", bundle.State)
	}
}

func TestToolOutsideGrantIsDeniedByPolicy(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_out_of_grant", "echo"))

	sleep := echoAction("act_sleep")
	sleep.Intent.ToolID = "sleep"
	sleep.Intent.Arguments = json.RawMessage(`{"seconds":"5"}`)
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", sleep)
	body := wantError(t, status, raw, http.StatusForbidden, CodeScopeDenied)
	if body.Error.Details["decision"] != "deny_tool_not_permitted" {
		t.Fatalf("unexpected decision detail: %+v", body.Error.Details)
	}

	run := getRun(t, env, created.RunID)
	if run.State != "stopped" {
		t.Fatalf("state = %q, want stopped", run.State)
	}
	if !run.BundleAvailable {
		t.Fatalf("stopped run must expose a bundle")
	}
}

func TestInvalidToolArgumentsAndIntentAreRejected(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_bad_args"))

	badArgs := echoAction("act_bad_args")
	badArgs.Intent.Arguments = json.RawMessage(`{"message":"goodbye"}`)
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", badArgs)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidToolArguments)

	missingTool := echoAction("act_missing_tool")
	missingTool.Intent.ToolID = ""
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions", missingTool)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidActionIntent)

	escapingPath := echoAction("act_escaping_path")
	escapingPath.Intent.PathScope = []string{"../etc/passwd"}
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions", escapingPath)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidActionIntent)

	// None of the refusals may have dispatched anything.
	run := getRun(t, env, created.RunID)
	if run.ExecutionCounts.ActionsTotal != 0 {
		t.Fatalf("refused intents must not reach the policy executor: %+v", run.ExecutionCounts)
	}
}

func TestUnknownRunAndMethodPaths(t *testing.T) {
	env := startEnv(t)
	status, raw := env.do("GET", "/v1/runs/run_missing", nil)
	wantError(t, status, raw, http.StatusNotFound, CodeRunNotFound)

	status, raw = env.do("POST", "/v1/runs/run_missing/cancel", cancelBody("github:aphrodite"))
	wantError(t, status, raw, http.StatusNotFound, CodeRunNotFound)

	status, raw = env.do("POST", "/v1/runs/run_missing/approvals",
		approvalBody("apr_1", "approve", "sha256:x"))
	wantError(t, status, raw, http.StatusNotFound, CodeRunNotFound)

	status, raw = env.do("POST", "/v1/runs/run_missing/actions", echoAction("act_1"))
	wantError(t, status, raw, http.StatusNotFound, CodeRunNotFound)
}

func TestCancelRequiresAuthorizedIdentity(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_cancel_auth"))
	status, raw := cancelRun(t, env, created.RunID, "github:mallory")
	wantError(t, status, raw, http.StatusForbidden, CodeCancellerNotAuthorized)

	run := getRun(t, env, created.RunID)
	if run.State != "approved" {
		t.Fatalf("unauthorized cancel must not change state, got %q", run.State)
	}
}

func TestEventsPagination(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_paging"))
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_page"))
	wantStatus(t, status, raw, http.StatusAccepted)

	first := getEvents(t, env, created.RunID, "limit=1")
	if len(first.Events) != 1 || !first.HasMore || first.NextAfterSequence != 1 {
		t.Fatalf("unexpected first page: %+v", first)
	}
	// After one action the chain holds grant, transition, dispatch and
	// completion: sequences 2..4 follow the first page.
	second := getEvents(t, env, created.RunID, "after_sequence=1&limit=100")
	if len(second.Events) != 3 || second.HasMore || second.NextAfterSequence != 4 {
		t.Fatalf("unexpected second page: %+v", second)
	}
	if second.Events[0].Sequence != 2 {
		t.Fatalf("events must be returned in sequence order: %+v", second.Events[0])
	}
}

func TestArtifactsFollowRunLifecycle(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_artifacts"))

	status, raw := env.do("GET", "/v1/runs/"+created.RunID+"/artifacts/patch_report", nil)
	wantError(t, status, raw, http.StatusConflict, CodeArtifactNotFinalized)

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_artifact"))
	wantStatus(t, status, raw, http.StatusAccepted)
	status, raw = cancelRun(t, env, created.RunID, "github:aphrodite")
	wantStatus(t, status, raw, http.StatusAccepted)

	for _, artifactID := range []string{"patch_report", "evidence_bundle", "redacted_execution_log"} {
		status, raw = env.do("GET", "/v1/runs/"+created.RunID+"/artifacts/"+artifactID, nil)
		wantStatus(t, status, raw, http.StatusOK)
		artifact := decodeInto[artifactResponse](t, raw)
		if artifact.ArtifactType != artifactID || artifact.Digest.Algorithm != "sha256" || artifact.Digest.Value == "" {
			t.Fatalf("unexpected artifact %s: %+v", artifactID, artifact)
		}
	}

	status, raw = env.do("GET", "/v1/runs/"+created.RunID+"/artifacts/patch_diff", nil)
	wantError(t, status, raw, http.StatusConflict, CodeArtifactNotFinalized)
}

func TestGrantWallClockTimeoutEndsTheRun(t *testing.T) {
	env := startEnv(t, func(cfg *Config) {
		cfg.Now = time.Now
	})
	body := lowRiskCreate("tsk_timeout", "sleep")
	body.RequestedScope.MaxWallClockSeconds = 1
	created := createRun(t, env, body)

	sleep := echoAction("act_timeout")
	sleep.Intent.ToolID = "sleep"
	sleep.Intent.Arguments = json.RawMessage(`{"seconds":"5"}`)
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", sleep)
	wantStatus(t, status, raw, http.StatusAccepted)
	accepted := decodeInto[actionResponse](t, raw)
	if accepted.State != "timed_out" {
		t.Fatalf("state after wall-clock timeout = %q, want timed_out", accepted.State)
	}

	run := getRun(t, env, created.RunID)
	if run.State != "timed_out" {
		t.Fatalf("run state = %q, want timed_out", run.State)
	}
	bundle := getBundle(t, env, created.RunID)
	if bundle.State != "timed_out" {
		t.Fatalf("bundle state = %q, want timed_out", bundle.State)
	}
}

func TestExpiredGrantIsRefused(t *testing.T) {
	env := startEnv(t, func(cfg *Config) {
		cfg.Now = time.Now
	})
	body := lowRiskCreate("tsk_expired")
	body.RequestedScope.MaxWallClockSeconds = 1
	created := createRun(t, env, body)

	time.Sleep(1100 * time.Millisecond)

	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", echoAction("act_expired"))
	wantError(t, status, raw, http.StatusGone, CodeGrantExpired)

	run := getRun(t, env, created.RunID)
	if run.State != "expired" {
		t.Fatalf("state = %q, want expired", run.State)
	}
	if run.GrantStatus.State != "expired" {
		t.Fatalf("grant status = %q, want expired", run.GrantStatus.State)
	}
	if bundle := getBundle(t, env, created.RunID); bundle.State != "expired" {
		t.Fatalf("bundle state = %q, want expired", bundle.State)
	}
}

func TestConcurrentActionIsBusy(t *testing.T) {
	env := startEnv(t, func(cfg *Config) {
		cfg.Now = time.Now
	})
	body := lowRiskCreate("tsk_busy", "sleep")
	created := createRun(t, env, body)

	sleepAction := func(actionID string) actionRequest {
		req := echoAction(actionID)
		req.Intent.ToolID = "sleep"
		req.Intent.Arguments = json.RawMessage(`{"seconds":"5"}`)
		return req
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", sleepAction("act_slow"))
		if status != http.StatusAccepted {
			t.Errorf("slow action status = %d, body %s", status, raw)
		}
	}()

	// The dispatch slot is held for the whole sleep; once the first action
	// owns it, a second one fails fast instead of queueing.
	time.Sleep(300 * time.Millisecond)
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", sleepAction("act_second"))
	busyBody := wantError(t, status, raw, http.StatusTooManyRequests, CodeRunBusy)
	if !busyBody.Error.Retryable {
		t.Fatalf("busy errors must be retryable: %+v", busyBody.Error)
	}

	status, raw = cancelRun(t, env, created.RunID, "github:aphrodite")
	wantStatus(t, status, raw, http.StatusAccepted)
	<-done
}

func TestRejectDecisionTerminatesElevatedRun(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, elevatedCreate("tsk_reject"))
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/approvals",
		approvalBody("apr_reject", "reject", created.RequiredAction.ScopeDigest))
	wantStatus(t, status, raw, http.StatusOK)
	decision := decodeInto[approvalResponse](t, raw)
	if decision.State != "rejected" || decision.AuditEventReference == "" {
		t.Fatalf("unexpected reject response: %+v", decision)
	}

	run := getRun(t, env, created.RunID)
	if run.State != "rejected" {
		t.Fatalf("state = %q, want rejected", run.State)
	}
	// An elevated run that never received an approval has no contract-complete
	// assessment, so its bundle stays unfinalized while its evidence chain is
	// already continuous.
	events := getEvents(t, env, created.RunID, "")
	if len(events.Events) == 0 {
		t.Fatalf("rejection must be evidenced")
	}
	status, raw = env.do("GET", "/v1/runs/"+created.RunID+"/evidence-bundle", nil)
	wantError(t, status, raw, http.StatusConflict, CodeEvidenceBundleNotFinalized)
}

func TestApprovalOutsideWindowIsExpired(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, elevatedCreate("tsk_window"))
	body := approvalBody("apr_late", "approve", created.RequiredAction.ScopeDigest)
	body["approved_at"] = frozenClock().Add(-time.Hour).Format(time.RFC3339)
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/approvals", body)
	wantError(t, status, raw, http.StatusGone, CodeApprovalWindowExpired)
}

func TestApprovalOnLowRiskRunConflicts(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_low_approval"))
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/approvals",
		approvalBody("apr_low", "approve", "sha256:x"))
	wantError(t, status, raw, http.StatusConflict, CodeApprovalAlreadyRecorded)
}

func TestUnregisteredToolIdentityIsRefused(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_unknown_tool"))
	action := echoAction("act_unregistered")
	action.Intent.ToolID = "git"
	status, raw := env.do("POST", "/v1/runs/"+created.RunID+"/actions", action)
	wantError(t, status, raw, http.StatusNotFound, CodeToolNotRegistered)
}
