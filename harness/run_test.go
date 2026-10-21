package harness

import (
	"errors"
	"testing"
	"time"
)

func mustRun(t *testing.T, store *EventStore, taskID, runID string, class RiskClass) *Run {
	t.Helper()
	var assessment RiskAssessment
	var err error
	in := RiskAssessmentInput{
		TaskID: taskID, RunID: runID,
		AssessedAt:         time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/" + taskID,
	}
	switch class {
	case RiskProhibited:
		assessment, err = NewRiskAssessment(in, RiskProhibited, DecisionProhibitedSecretAccess, nil)
	default:
		assessment, err = NewRiskAssessment(in, RiskLow, DecisionRiskLowApproved, nil)
	}
	if err != nil {
		t.Fatalf("assessment: %v", err)
	}
	run, err := NewRun(RunConfig{
		TaskID: taskID, RunID: runID, IssueID: "issue-1",
		ActorIdentity: "human:owner-1", ExecutionIdentity: "agent:runner-1",
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
	}, assessment, store)
	if err != nil {
		t.Fatalf("NewRun: %v", err)
	}
	// Freeze the clock inside the synthetic grant window (09:00..10:00Z).
	run.now = func() time.Time { return time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC) }
	return run
}

func approveRun(t *testing.T, run *Run, issuedAt time.Time) {
	t.Helper()
	err := run.Approve(GrantParams{
		TaskID: run.TaskID, RunID: run.RunID,
		IssuedAt: issuedAt, ExpiresAt: issuedAt.Add(time.Hour),
		CapabilityGrantVersion: "grant-1",
		RepositoryURL:          "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:                "abc123",
		PermittedPaths:         []string{"harness"},
		PermittedTools:         []PermittedTool{{Identity: "go-test", AllowedArguments: []string{"./harness/"}}},
		NetworkDestinations:    []string{},
		MaxWallClockSeconds:    600,
	})
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
}

func runningRun(t *testing.T, store *EventStore) (*Run, time.Time) {
	t.Helper()
	issuedAt := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	run := mustRun(t, store, "task-1", "run-1", RiskLow)
	approveRun(t, run, issuedAt)
	if err := run.Transition(StateRunning, ""); err != nil {
		t.Fatalf("Transition(running): %v", err)
	}
	return run, issuedAt
}

func TestNewRunStartsRequestedWithoutEvents(t *testing.T) {
	store := NewEventStore()
	run := mustRun(t, store, "task-1", "run-1", RiskLow)
	if run.State != StateRequested {
		t.Errorf("State = %q, want %q", run.State, StateRequested)
	}
	if got := store.All(); len(got) != 0 {
		t.Errorf("events before first transition = %d, want 0", len(got))
	}
}

func TestNewRunRejectsLinkageMismatch(t *testing.T) {
	store := NewEventStore()
	assessment, err := NewRiskAssessment(RiskAssessmentInput{
		TaskID: "task-1", RunID: "run-1",
		AssessedAt:         time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/task-1",
	}, RiskLow, DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = NewRun(RunConfig{
		TaskID: "task-1", RunID: "run-other", IssueID: "issue-1",
		ActorIdentity: "a", ExecutionIdentity: "e",
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git", BaseSHA: "abc123",
	}, assessment, store)
	if err == nil {
		t.Error("mismatched assessment linkage: err = nil, want error")
	}
}

func TestFullHappyPathToMerged(t *testing.T) {
	store := NewEventStore()
	issuedAt := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	run := mustRun(t, store, "task-1", "run-1", RiskLow)

	approveRun(t, run, issuedAt)
	if run.State != StateApproved {
		t.Fatalf("after Approve state = %q, want %q", run.State, StateApproved)
	}
	if run.Grant == nil {
		t.Fatal("Approve must record the capability grant")
	}

	if err := run.Transition(StateRunning, ""); err != nil {
		t.Fatalf("Transition(running): %v", err)
	}
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatalf("SetPR: %v", err)
	}

	req := ActionRequest{
		Tool: "go-test", Arguments: []string{"./harness/"},
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
		Branch:        "autofixer/task-1",
		Paths:         []string{"harness/state.go"},
	}
	d := run.EvaluateAndRecordAction(req)
	if !d.Allowed {
		t.Fatalf("action denied: %+v", d)
	}

	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatalf("Transition(awaiting_review): %v", err)
	}

	snap := baseSnapshot("head222")
	snap.TaskID = run.TaskID
	snap.RunID = run.RunID
	res := run.RecordMergeEligibility(&snap)
	if !res.Eligible {
		t.Fatalf("merge eligibility = %+v, want eligible", res)
	}
	if err := run.Transition(StateApprovedForMerge, ""); err != nil {
		t.Fatalf("Transition(approved_for_merge): %v", err)
	}
	if err := run.Transition(StateMerged, ""); err != nil {
		t.Fatalf("Transition(merged): %v", err)
	}

	if run.State != StateMerged {
		t.Errorf("final state = %q, want %q", run.State, StateMerged)
	}
	events := store.Events("run-1")
	if len(events) != 7 {
		t.Fatalf("event count = %d, want 7", len(events))
	}
	// chain of prior/resulting states must be continuous
	for i := 1; i < len(events); i++ {
		if events[i].PriorState != events[i-1].ResultingState {
			t.Errorf("event %d prior %q != previous resulting %q", i+1, events[i].PriorState, events[i-1].ResultingState)
		}
	}
	wantStates := []State{StateApproved, StateRunning, StateRunning, StateAwaitingReview, StateAwaitingReview, StateApprovedForMerge, StateMerged}
	for i, ev := range events {
		if ev.ResultingState != wantStates[i] {
			t.Errorf("event %d resulting = %q, want %q", i+1, ev.ResultingState, wantStates[i])
		}
		if ev.RiskClass != RiskLow {
			t.Errorf("event %d risk = %q, want low", i+1, ev.RiskClass)
		}
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}

func TestProhibitedRunRejectedWithQueryableEvidence(t *testing.T) {
	store := NewEventStore()
	run := mustRun(t, store, "task-1", "run-1", RiskProhibited)

	issuedAt := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	err := run.Approve(GrantParams{
		TaskID: "task-1", RunID: "run-1",
		IssuedAt: issuedAt, ExpiresAt: issuedAt.Add(time.Hour),
		CapabilityGrantVersion: "grant-1",
		RepositoryURL:          "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:                "abc123",
		MaxWallClockSeconds:    600,
	})
	if !errors.Is(err, ErrProhibitedRisk) {
		t.Fatalf("Approve on prohibited = %v, want ErrProhibitedRisk", err)
	}

	if err := run.Transition(StateRejected, run.Assessment.DecisionCode); err != nil {
		t.Fatalf("Transition(rejected): %v", err)
	}
	if run.State != StateRejected || !IsTerminal(run.State) {
		t.Errorf("state = %q, want terminal %q", run.State, StateRejected)
	}

	events := store.Events("run-1")
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	code := ""
	if events[0].DecisionOrStopCode != nil {
		code = *events[0].DecisionOrStopCode
	}
	if code != DecisionProhibitedSecretAccess {
		t.Errorf("decision code = %q, want %q", code, DecisionProhibitedSecretAccess)
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}

	// terminal: no further transitions, including a retry of Approve
	if err := run.Approve(GrantParams{
		TaskID: "task-1", RunID: "run-1",
		IssuedAt: issuedAt, ExpiresAt: issuedAt.Add(time.Hour),
		CapabilityGrantVersion: "grant-2",
		RepositoryURL:          "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:                "abc123",
		MaxWallClockSeconds:    600,
	}); err == nil {
		t.Error("Approve after rejected: err = nil, want error")
	}
}

func TestIllegalTransitionDeniedAndLogged(t *testing.T) {
	store := NewEventStore()
	run := mustRun(t, store, "task-1", "run-1", RiskLow)

	err := run.Transition(StateRunning, "")
	if err == nil {
		t.Fatal("requested -> running must be denied")
	}
	if run.State != StateRequested {
		t.Errorf("state changed to %q, want %q", run.State, StateRequested)
	}
	events := store.Events("run-1")
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1 denial record", len(events))
	}
	code := ""
	if events[0].DecisionOrStopCode != nil {
		code = *events[0].DecisionOrStopCode
	}
	if code != DenyStateTransitionForbidden {
		t.Errorf("code = %q, want %q", code, DenyStateTransitionForbidden)
	}
	if events[0].PriorState != StateRequested || events[0].ResultingState != StateRequested {
		t.Errorf("denied attempt states = %q->%q, want %q->%q",
			events[0].PriorState, events[0].ResultingState, StateRequested, StateRequested)
	}
}

func TestAwaitingReviewRequiresPR(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	err := run.Transition(StateAwaitingReview, "")
	if err == nil {
		t.Fatal("awaiting_review without a PR must be denied")
	}
	if run.State != StateRunning {
		t.Errorf("state = %q, want %q", run.State, StateRunning)
	}
}

func TestOutOfWorkingScopeDispatchStopsRunAndLogs(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	req := ActionRequest{
		Tool: "rm-rf", Arguments: []string{"-rf", "/"},
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
	}
	d := run.EvaluateAndRecordAction(req)
	if d.Allowed || d.Code != DenyToolNotPermitted || d.StopCode != StopCodeOutOfGrant {
		t.Fatalf("decision = %+v, want deny %q + stop %q", d, DenyToolNotPermitted, StopCodeOutOfGrant)
	}
	if run.State != StateStopped {
		t.Errorf("state = %q, want %q after out-of-grant attempt", run.State, StateStopped)
	}
	if !run.Revoked {
		t.Error("stop must revoke the grant")
	}

	events := store.Events("run-1")
	// approve, running, denied tool, stopped
	if len(events) != 4 {
		t.Fatalf("events = %d, want 4", len(events))
	}
	toolEv := events[2]
	toolCode := ""
	if toolEv.DecisionOrStopCode != nil {
		toolCode = *toolEv.DecisionOrStopCode
	}
	if toolEv.EventType != EventTypeToolInvocation || toolCode != DenyToolNotPermitted {
		t.Errorf("tool event = type %q code %q, want %q/%q", toolEv.EventType, toolCode, EventTypeToolInvocation, DenyToolNotPermitted)
	}
	stopCode := ""
	if events[3].DecisionOrStopCode != nil {
		stopCode = *events[3].DecisionOrStopCode
	}
	if events[3].ResultingState != StateStopped || stopCode != StopCodeOutOfGrant {
		t.Errorf("stop event = %q/%q, want %q/%q", events[3].ResultingState, stopCode, StateStopped, StopCodeOutOfGrant)
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}

	// further dispatch stays denied after revocation
	d = run.EvaluateAndRecordAction(req)
	if d.Allowed || d.Code != DenyGrantRevoked {
		t.Errorf("post-stop decision = %+v, want deny %q", d, DenyGrantRevoked)
	}
}

func TestCancelledRunRetainsQueryableEvidence(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	if err := run.Transition(StateCancelled, "run_cancelled"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if run.State != StateCancelled || !run.Revoked {
		t.Errorf("state/revoked = %q/%v, want cancelled/true", run.State, run.Revoked)
	}

	events := store.Events("run-1")
	last := events[len(events)-1]
	code := ""
	if last.DecisionOrStopCode != nil {
		code = *last.DecisionOrStopCode
	}
	if last.ResultingState != StateCancelled || code != "run_cancelled" {
		t.Errorf("cancel event = %q/%q, want %q/run_cancelled", last.ResultingState, code, StateCancelled)
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}

	// dispatch after cancellation is denied
	d := run.EvaluateAndRecordAction(ActionRequest{
		Tool: "go-test", Arguments: []string{"./harness/"},
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git", BaseSHA: "abc123",
	})
	if d.Allowed {
		t.Error("dispatch after cancel must be denied")
	}
}

func TestExpiredGrantDispatchDeniedAndStops(t *testing.T) {
	store := NewEventStore()
	run, issuedAt := runningRun(t, store)
	run.now = func() time.Time { return issuedAt.Add(2 * time.Hour) }

	d := run.EvaluateAndRecordAction(ActionRequest{
		Tool: "go-test", Arguments: []string{"./harness/"},
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git", BaseSHA: "abc123",
	})
	if d.Allowed || d.Code != DenyGrantExpired || d.StopCode != StopCodeGrantExpired {
		t.Fatalf("decision = %+v, want deny %q + stop %q", d, DenyGrantExpired, StopCodeGrantExpired)
	}
	if run.State != StateStopped {
		t.Errorf("state = %q, want %q", run.State, StateStopped)
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}

func TestMergeEligibilityDeniedForExpiredApprovals(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}

	// both approvals bound to the previous head: expired / stale
	snap := baseSnapshot("head222")
	snap.TaskID = run.TaskID
	snap.RunID = run.RunID
	for i := range snap.ApprovalQuorum.Approvals {
		snap.ApprovalQuorum.Approvals[i].HeadSHA = strptr("oldhead")
	}
	res := run.RecordMergeEligibility(&snap)
	if res.Eligible || res.Code != DenyApprovalQuorumStaleHead {
		t.Fatalf("result = %+v, want ineligible %q", res, DenyApprovalQuorumStaleHead)
	}
	if run.State != StateAwaitingReview {
		t.Errorf("state = %q, must stay awaiting_review on denied eligibility", run.State)
	}

	events := store.Events("run-1")
	last := events[len(events)-1]
	code := ""
	if last.DecisionOrStopCode != nil {
		code = *last.DecisionOrStopCode
	}
	if code != DenyApprovalQuorumStaleHead {
		t.Errorf("last event code = %q, want %q", code, DenyApprovalQuorumStaleHead)
	}
	if last.ResultingState != StateAwaitingReview {
		t.Errorf("last event resulting = %q, want %q", last.ResultingState, StateAwaitingReview)
	}
	if snap.MergeQueueEligible {
		t.Error("snapshot must record ineligibility")
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}

func TestSetPRRejectsNonAutofixerBranch(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	for _, branch := range []string{"main", "feature/x", ""} {
		if err := run.SetPR(branch, "head222", "pr-42"); err == nil {
			t.Errorf("SetPR(%q): err = nil, want error", branch)
		}
	}
}

func TestRecordMergeEligibilityRejectsMismatchedRun(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}
	snap := baseSnapshot("head222")
	snap.RunID = "run-other"
	res := run.RecordMergeEligibility(&snap)
	if res.Eligible || res.Code != DenySnapshotRunMismatch {
		t.Errorf("result = %+v, want deny %q", res, DenySnapshotRunMismatch)
	}
}

// sabotageAudit makes the next Append fail: the store rejects the run's
// unknown risk class, simulating an audit-write control failure.
func sabotageAudit(run *Run) {
	run.Assessment.RiskClass = RiskClass("bogus")
}

func TestAuditWriteFailureFailsClosedOnTransition(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	before := len(store.Events("run-1"))

	sabotageAudit(run)
	if err := run.Transition(StateCancelled, "run_cancelled"); err == nil {
		t.Error("transition with failing audit write: err = nil, want error")
	}
	if run.State != StateRunning {
		t.Errorf("state = %q, must not advance without evidence", run.State)
	}
	if got := len(store.Events("run-1")); got != before {
		t.Errorf("events = %d, want %d (append must fail)", got, before)
	}
}

func TestAuditWriteFailureFailsClosedOnDispatch(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	sabotageAudit(run)
	d := run.EvaluateAndRecordAction(ActionRequest{
		Tool: "go-test", Arguments: []string{"./harness/"},
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git", BaseSHA: "abc123",
	})
	if d.Allowed || d.Code != DenyAuditFailure || d.StopCode != StopCodeAuditFailure {
		t.Errorf("decision = %+v, want deny %q + stop %q", d, DenyAuditFailure, StopCodeAuditFailure)
	}
	if !run.Revoked {
		t.Error("audit failure must revoke further dispatch")
	}
}

func TestAuditWriteFailureFailsClosedOnMergeEvaluation(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}

	sabotageAudit(run)
	snap := baseSnapshot("head222")
	snap.TaskID = run.TaskID
	snap.RunID = run.RunID
	res := run.RecordMergeEligibility(&snap)
	if res.Eligible || res.Code != DenyAuditFailure {
		t.Errorf("result = %+v, want deny %q", res, DenyAuditFailure)
	}
}

func TestStoppedRunRequiresNewGrantToReapprove(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.Transition(StateStopped, "stop_for_triage"); err != nil {
		t.Fatalf("stop: %v", err)
	}

	// a direct transition cannot reuse the revoked grant
	if err := run.Transition(StateApproved, "stale_grant"); err == nil {
		t.Error("stopped -> approved with the stale grant: err = nil, want error")
	}
	if run.State != StateStopped {
		t.Errorf("state = %q, want %q", run.State, StateStopped)
	}

	// Approve issues a fresh grant, which reapproves legally
	approveRun(t, run, time.Date(2026, 10, 21, 11, 0, 0, 0, time.UTC))
	if run.State != StateApproved {
		t.Errorf("state after Approve = %q, want %q", run.State, StateApproved)
	}
	if run.Grant == nil || !run.Grant.IssuedAt.Equal(time.Date(2026, 10, 21, 11, 0, 0, 0, time.UTC)) {
		t.Errorf("Approve must record the new grant, got %+v", run.Grant)
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}

func TestApprovedForMergeRequiresEligibleSnapshot(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}

	// no approval evidence of any kind: the merge boundary must hold
	if err := run.Transition(StateApprovedForMerge, ""); err == nil {
		t.Error("approved_for_merge without an eligible snapshot: err = nil, want error")
	}
	if run.State != StateAwaitingReview {
		t.Errorf("state = %q, want %q", run.State, StateAwaitingReview)
	}
	events := store.Events("run-1")
	last := events[len(events)-1]
	if last.DecisionOrStopCode == nil {
		t.Error("denied merge transition must be logged with a decision code")
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}

func TestRecordMergeEligibilityRejectsSnapshotHeadMismatch(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}

	// a fully-green snapshot for a DIFFERENT head must not count
	snap := baseSnapshot("oldhead")
	snap.TaskID = run.TaskID
	snap.RunID = run.RunID
	res := run.RecordMergeEligibility(&snap)
	if res.Eligible || res.Code != DenySnapshotHeadMismatch {
		t.Fatalf("result = %+v, want deny %q", res, DenySnapshotHeadMismatch)
	}
	if run.State != StateAwaitingReview {
		t.Errorf("state = %q, want %q", run.State, StateAwaitingReview)
	}
	if err := run.Transition(StateApprovedForMerge, ""); err == nil {
		t.Error("mismatched snapshot must not authorize approved_for_merge")
	}
}

func TestSetPRHeadChangeInvalidatesEligibility(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}

	snap := baseSnapshot("head222")
	snap.TaskID = run.TaskID
	snap.RunID = run.RunID
	if res := run.RecordMergeEligibility(&snap); !res.Eligible {
		t.Fatalf("initial eligibility = %+v, want eligible", res)
	}

	// a new commit invalidates the recorded eligibility
	if err := run.SetPR("autofixer/task-1", "head333", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateApprovedForMerge, ""); err == nil {
		t.Error("approved_for_merge after head change: err = nil, want error (eligibility invalidated)")
	}

	// the old snapshot no longer matches the bound head
	stale := baseSnapshot("head222")
	stale.TaskID = run.TaskID
	stale.RunID = run.RunID
	if res := run.RecordMergeEligibility(&stale); res.Code != DenySnapshotHeadMismatch {
		t.Errorf("stale snapshot result = %+v, want %q", res, DenySnapshotHeadMismatch)
	}

	// a renewed snapshot for the new head restores eligibility
	fresh := baseSnapshot("head333")
	fresh.TaskID = run.TaskID
	fresh.RunID = run.RunID
	if res := run.RecordMergeEligibility(&fresh); !res.Eligible {
		t.Fatalf("renewed eligibility = %+v, want eligible", res)
	}
	if err := run.Transition(StateApprovedForMerge, ""); err != nil {
		t.Fatalf("approved_for_merge after renewal: %v", err)
	}
	if run.State != StateApprovedForMerge {
		t.Errorf("state = %q, want %q", run.State, StateApprovedForMerge)
	}
}

func TestIneligibleSnapshotClearsRecordedEligibility(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}

	good := baseSnapshot("head222")
	good.TaskID = run.TaskID
	good.RunID = run.RunID
	if res := run.RecordMergeEligibility(&good); !res.Eligible {
		t.Fatalf("eligibility = %+v, want eligible", res)
	}

	// a later ineligible observation for the same head must fail closed
	bad := baseSnapshot("head222")
	bad.TaskID = run.TaskID
	bad.RunID = run.RunID
	bad.QA.Status = "pending"
	if res := run.RecordMergeEligibility(&bad); res.Eligible {
		t.Fatalf("ineligible snapshot accepted: %+v", res)
	}
	if err := run.Transition(StateApprovedForMerge, ""); err == nil {
		t.Error("approved_for_merge after gates regressed: err = nil, want error")
	}
}

func TestApproveRejectsMismatchedGrantLinkage(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*GrantParams)
	}{
		{"foreign repository", func(p *GrantParams) { p.RepositoryURL = "https://github.com/evil/attacker.git" }},
		{"foreign base sha", func(p *GrantParams) { p.BaseSHA = "different-base" }},
		{"foreign policy version", func(p *GrantParams) { p.PolicyVersion = "governance-9" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := NewEventStore()
			run := mustRun(t, store, "task-1", "run-1", RiskLow)
			issuedAt := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
			p := GrantParams{
				TaskID: "task-1", RunID: "run-1",
				IssuedAt: issuedAt, ExpiresAt: issuedAt.Add(time.Hour),
				CapabilityGrantVersion: "grant-1",
				RepositoryURL:          "https://github.com/Luthiel/AutoFixer.git",
				BaseSHA:                "abc123",
				MaxWallClockSeconds:    600,
			}
			tc.mutate(&p)

			if err := run.Approve(p); err == nil {
				t.Fatal("Approve with mismatched linkage: err = nil, want error")
			}
			if run.State != StateRequested {
				t.Errorf("state = %q, want %q", run.State, StateRequested)
			}
			events := store.Events("run-1")
			if len(events) != 1 {
				t.Fatalf("events = %d, want 1 refusal record", len(events))
			}
			code := ""
			if events[0].DecisionOrStopCode != nil {
				code = *events[0].DecisionOrStopCode
			}
			if code != DenyGrantLinkageMismatch {
				t.Errorf("code = %q, want %q", code, DenyGrantLinkageMismatch)
			}
			if run.Grant != nil {
				t.Error("refused grant must not be recorded")
			}
		})
	}
}

func TestStopTransitionAuditFailureFailsClosed(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)
	// appends so far: approve, running. The tool-decision append is the 3rd
	// (must succeed); the stop transition append is the 4th (must fail).
	store.failAt = 4

	d := run.EvaluateAndRecordAction(ActionRequest{
		Tool: "rm-rf", Arguments: []string{"-rf"},
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git", BaseSHA: "abc123",
	})
	if d.Allowed || d.Code != DenyAuditFailure || d.StopCode != StopCodeAuditFailure {
		t.Errorf("decision = %+v, want deny %q + stop %q", d, DenyAuditFailure, StopCodeAuditFailure)
	}
	if run.State != StateRunning {
		t.Errorf("state = %q, stop could not be evidenced so the run stays put", run.State)
	}
	if !run.Revoked {
		t.Error("un-evidenced stop must still revoke dispatch")
	}
}

func TestTransitionPreconditionDenialsUseSpecificCode(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	// awaiting_review without a PR binding: precondition, not a table violation
	if err := run.Transition(StateAwaitingReview, ""); err == nil {
		t.Fatal("awaiting_review without PR must be denied")
	}
	events := store.Events("run-1")
	code := ""
	if events[len(events)-1].DecisionOrStopCode != nil {
		code = *events[len(events)-1].DecisionOrStopCode
	}
	if code != DenyTransitionPreconditionMissing {
		t.Errorf("code = %q, want %q", code, DenyTransitionPreconditionMissing)
	}

	// merge transition without eligible snapshot: also precondition
	if err := run.SetPR("autofixer/task-1", "head222", "pr-42"); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateAwaitingReview, ""); err != nil {
		t.Fatal(err)
	}
	if err := run.Transition(StateApprovedForMerge, ""); err == nil {
		t.Fatal("approved_for_merge without eligible snapshot must be denied")
	}
	events = store.Events("run-1")
	if code = ""; events[len(events)-1].DecisionOrStopCode != nil {
		code = *events[len(events)-1].DecisionOrStopCode
	}
	if code != DenyTransitionPreconditionMissing {
		t.Errorf("code = %q, want %q", code, DenyTransitionPreconditionMissing)
	}
}
