package harness

import (
	"testing"
)

func TestRecordExecutionOutcomeAppendsCompletionEvidence(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	req := ActionRequest{
		Tool:          "go-test",
		Arguments:     []string{"./harness/"},
		RepositoryURL: run.RepositoryURL,
		BaseSHA:       run.BaseSHA,
	}
	if d := run.EvaluateAndRecordAction(req); !d.Allowed {
		t.Fatalf("dispatch denied: %+v", d)
	}

	status := 7
	err := run.RecordExecutionOutcome(req, ExecutionOutcome{
		ExitStatus:   &status,
		OutputDigest: &Digest{Algorithm: DigestAlgorithmSHA256, Value: "abc123"},
	})
	if err != nil {
		t.Fatalf("RecordExecutionOutcome: %v", err)
	}

	events := store.Events(run.RunID)
	if len(events) != 4 {
		t.Fatalf("events = %d, want 4 (grant, running, dispatch, outcome)", len(events))
	}
	completion := events[3]
	if completion.EventType != EventTypeToolInvocation {
		t.Errorf("event_type = %q, want %q", completion.EventType, EventTypeToolInvocation)
	}
	if completion.ExitStatus == nil || *completion.ExitStatus != 7 {
		t.Errorf("exit_status = %v, want 7", completion.ExitStatus)
	}
	if completion.OutputDigest == nil ||
		completion.OutputDigest.Algorithm != DigestAlgorithmSHA256 ||
		completion.OutputDigest.Value != "abc123" {
		t.Errorf("output_digest = %+v, want sha256 abc123", completion.OutputDigest)
	}
	if completion.DecisionOrStopCode == nil || *completion.DecisionOrStopCode != AllowWithinGrant {
		t.Errorf("decision code = %v, want %q", completion.DecisionOrStopCode, AllowWithinGrant)
	}
	if completion.RequestedTool == nil || completion.RequestedTool.Identity != "go-test" {
		t.Errorf("requested_tool = %+v, want identity go-test", completion.RequestedTool)
	}
	if run.Revoked {
		t.Error("successful outcome must not revoke the grant")
	}
	if err := store.VerifyChain(run.RunID); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}

func TestRecordExecutionOutcomeCarriesTerminationCode(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	req := ActionRequest{
		Tool:          "go-test",
		Arguments:     []string{"./harness/"},
		RepositoryURL: run.RepositoryURL,
		BaseSHA:       run.BaseSHA,
	}
	if d := run.EvaluateAndRecordAction(req); !d.Allowed {
		t.Fatalf("dispatch denied: %+v", d)
	}
	status := -1
	err := run.RecordExecutionOutcome(req, ExecutionOutcome{
		ExitStatus:   &status,
		OutputDigest: &Digest{Algorithm: DigestAlgorithmSHA256, Value: "empty"},
		Code:         "execution_timed_out",
	})
	if err != nil {
		t.Fatalf("RecordExecutionOutcome: %v", err)
	}
	events := store.Events(run.RunID)
	completion := events[len(events)-1]
	if completion.DecisionOrStopCode == nil || *completion.DecisionOrStopCode != "execution_timed_out" {
		t.Errorf("decision code = %v, want execution_timed_out", completion.DecisionOrStopCode)
	}
}

func TestRecordExecutionOutcomeRequiresOutputDigest(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	req := ActionRequest{
		Tool:          "go-test",
		Arguments:     []string{"./harness/"},
		RepositoryURL: run.RepositoryURL,
		BaseSHA:       run.BaseSHA,
	}
	if d := run.EvaluateAndRecordAction(req); !d.Allowed {
		t.Fatalf("dispatch denied: %+v", d)
	}
	before := len(store.Events(run.RunID))

	for name, out := range map[string]ExecutionOutcome{
		"nil digest":    {},
		"empty value":   {OutputDigest: &Digest{Algorithm: DigestAlgorithmSHA256}},
		"empty algorit": {OutputDigest: &Digest{Value: "abc123"}},
	} {
		if err := run.RecordExecutionOutcome(req, out); err == nil {
			t.Errorf("%s: err = nil, want error", name)
		}
	}
	if got := len(store.Events(run.RunID)); got != before {
		t.Errorf("events = %d, want %d: invalid outcomes must not be appended", got, before)
	}
	if run.Revoked {
		t.Error("validation failure must not revoke the grant: no audit write was attempted")
	}
}

func TestRecordExecutionOutcomeAuditFailureRevokesDispatch(t *testing.T) {
	store := NewEventStore()
	run, _ := runningRun(t, store)

	req := ActionRequest{
		Tool:          "go-test",
		Arguments:     []string{"./harness/"},
		RepositoryURL: run.RepositoryURL,
		BaseSHA:       run.BaseSHA,
	}
	if d := run.EvaluateAndRecordAction(req); !d.Allowed {
		t.Fatalf("dispatch denied: %+v", d)
	}

	// The next append is the outcome write; make it fail.
	store.failAt = store.appendAttempts + 1
	err := run.RecordExecutionOutcome(req, ExecutionOutcome{
		OutputDigest: &Digest{Algorithm: DigestAlgorithmSHA256, Value: "abc123"},
	})
	if err == nil {
		t.Fatal("audit-write failure: err = nil, want error")
	}
	if !run.Revoked {
		t.Error("audit-write failure must revoke the grant (fail closed)")
	}

	// Further dispatch is blocked and the refusal itself is evidenced.
	d := run.EvaluateAndRecordAction(req)
	if d.Allowed {
		t.Fatal("dispatch after audit failure must be denied")
	}
	if d.Code != DenyGrantRevoked {
		t.Errorf("deny code = %q, want %q", d.Code, DenyGrantRevoked)
	}
	if err := store.VerifyChain(run.RunID); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}
