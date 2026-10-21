package harness

import (
	"strings"
	"testing"
	"time"
)

func testEvent(runID string) ExecutionEvent {
	return ExecutionEvent{
		ContractVersion:     ContractVersion,
		EventType:           EventTypeStateTransition,
		RunID:               runID,
		TaskID:              "task-1",
		IssueID:             "issue-1",
		ActorIdentity:       "human:owner-1",
		ExecutionIdentity:   "agent:runner-1",
		OccurredAt:          time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC),
		PriorState:          StateRequested,
		ResultingState:      StateRequested,
		RiskClass:           RiskLow,
		PolicyVersion:       DefaultPolicyVersion,
		RepositoryURL:       "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:             "abc123",
		PathScope:           []string{},
		NetworkScope:        []string{},
		ArtifactDigests:     []Digest{},
		ApprovalSnapshotRef: "evidence://approvals/" + runID + "/no-pr",
		DigestAlgorithm:     DigestAlgorithmSHA256,
	}
}

func TestAppendAssignsSequenceAndChain(t *testing.T) {
	store := NewEventStore()

	e1 := testEvent("run-1")
	got1, err := store.Append(e1)
	if err != nil {
		t.Fatalf("Append #1: %v", err)
	}
	if got1.Sequence != 1 {
		t.Errorf("Sequence = %d, want 1", got1.Sequence)
	}
	if got1.PreviousEventDigest != nil {
		t.Errorf("PreviousEventDigest = %v, want nil for sequence 1", *got1.PreviousEventDigest)
	}
	if got1.EventDigest == "" {
		t.Error("EventDigest must be set")
	}
	if got1.EventID == "" {
		t.Error("EventID must be set")
	}
	if got1.DigestAlgorithm != DigestAlgorithmSHA256 {
		t.Errorf("DigestAlgorithm = %q, want %q", got1.DigestAlgorithm, DigestAlgorithmSHA256)
	}

	e2 := testEvent("run-1")
	e2.PriorState = StateRequested
	e2.ResultingState = StateCancelled
	got2, err := store.Append(e2)
	if err != nil {
		t.Fatalf("Append #2: %v", err)
	}
	if got2.Sequence != 2 {
		t.Errorf("Sequence = %d, want 2", got2.Sequence)
	}
	if got2.PreviousEventDigest == nil {
		t.Fatal("PreviousEventDigest = nil, want digest of event 1")
	}
	if *got2.PreviousEventDigest != got1.EventDigest {
		t.Errorf("PreviousEventDigest = %q, want %q", *got2.PreviousEventDigest, got1.EventDigest)
	}
}

func TestAppendStartsNewChainPerRun(t *testing.T) {
	store := NewEventStore()
	e := testEvent("run-b")
	got, err := store.Append(e)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if got.Sequence != 1 || got.PreviousEventDigest != nil {
		t.Errorf("new run must start at sequence 1 with nil previous digest, got seq=%d prev=%v", got.Sequence, got.PreviousEventDigest)
	}
}

func TestVerifyChainAcceptsIntactLogAndDetectsTampering(t *testing.T) {
	store := NewEventStore()
	for i := 0; i < 3; i++ {
		e := testEvent("run-1")
		if i > 0 {
			e.PriorState = StateApproved
			e.ResultingState = StateRunning
		}
		if _, err := store.Append(e); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Fatalf("VerifyChain intact: %v", err)
	}

	// tamper with recorded content
	store.events[1].DecisionOrStopCode = strptr("injected_code")
	if err := store.VerifyChain("run-1"); err == nil {
		t.Error("VerifyChain after content tamper: err = nil, want error")
	}
}

func TestVerifyChainDetectsBrokenLink(t *testing.T) {
	store := NewEventStore()
	for i := 0; i < 2; i++ {
		if _, err := store.Append(testEvent("run-1")); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	forged := "0000000000000000000000000000000000000000000000000000000000000000"
	store.events[1].PreviousEventDigest = &forged
	if err := store.VerifyChain("run-1"); err == nil {
		t.Error("VerifyChain after link forgery: err = nil, want error")
	}
}

func TestAppendRedactsSensitiveArguments(t *testing.T) {
	store := NewEventStore()
	e := testEvent("run-1")
	e.EventType = EventTypeToolInvocation
	e.RequestedTool = &ToolRecord{Identity: "go-test", Arguments: []string{"token=abc123", "plain-arg"}}
	e.ActualTool = &ToolRecord{Identity: "go-test", Arguments: []string{"PASSWORD: hunter2", "Bearer eyJhbGciOi.payload"}}
	got, err := store.Append(e)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	joined := strings.Join(got.RequestedTool.Arguments, " ") + " " + strings.Join(got.ActualTool.Arguments, " ")
	for _, secret := range []string{"abc123", "hunter2", "eyJhbGciOi.payload"} {
		if strings.Contains(joined, secret) {
			t.Errorf("stored arguments leak %q: %q", secret, joined)
		}
	}
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("VerifyChain on redacted event: %v", err)
	}
}

func TestEventsAreQueryableByRun(t *testing.T) {
	store := NewEventStore()
	if _, err := store.Append(testEvent("run-a")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(testEvent("run-b")); err != nil {
		t.Fatal(err)
	}
	e := testEvent("run-a")
	e.ResultingState = StateCancelled
	if _, err := store.Append(e); err != nil {
		t.Fatal(err)
	}

	got := store.Events("run-a")
	if len(got) != 2 {
		t.Fatalf("Events(run-a) len = %d, want 2", len(got))
	}
	for _, ev := range got {
		if ev.RunID != "run-a" {
			t.Errorf("Events(run-a) returned run %q", ev.RunID)
		}
	}
	if got[0].Sequence != 1 || got[1].Sequence != 2 {
		t.Errorf("sequences = %d,%d, want 1,2", got[0].Sequence, got[1].Sequence)
	}
	if len(store.All()) != 3 {
		t.Errorf("All() len = %d, want 3", len(store.All()))
	}
}

func TestAppendRejectsMalformedEvents(t *testing.T) {
	store := NewEventStore()

	e := testEvent("run-1")
	e.EventType = "side_effect"
	if _, err := store.Append(e); err == nil {
		t.Error("unknown event_type: err = nil, want error")
	}

	e = testEvent("")
	if _, err := store.Append(e); err == nil {
		t.Error("empty run_id: err = nil, want error")
	}

	e = testEvent("run-1")
	e.ResultingState = State("succeeded")
	if _, err := store.Append(e); err == nil {
		t.Error("invented state: err = nil, want error")
	}

	e = testEvent("run-1")
	e.RiskClass = RiskClass("unknown")
	if _, err := store.Append(e); err == nil {
		t.Error("unknown risk class: err = nil, want error")
	}
}

func TestReturnedEventIsACopy(t *testing.T) {
	store := NewEventStore()
	got, err := store.Append(testEvent("run-1"))
	if err != nil {
		t.Fatal(err)
	}
	got.TaskID = "mutated"
	if err := store.VerifyChain("run-1"); err != nil {
		t.Errorf("mutating returned copy must not affect stored log: %v", err)
	}
}

func TestAppendRejectsMissingContractFields(t *testing.T) {
	store := NewEventStore()
	cases := []struct {
		name   string
		mutate func(*ExecutionEvent)
	}{
		{"zero occurred_at", func(e *ExecutionEvent) { e.OccurredAt = time.Time{} }},
		{"empty actor_identity", func(e *ExecutionEvent) { e.ActorIdentity = "" }},
		{"empty execution_identity", func(e *ExecutionEvent) { e.ExecutionIdentity = "" }},
		{"empty approval_snapshot_ref", func(e *ExecutionEvent) { e.ApprovalSnapshotRef = "" }},
		{"empty issue_id", func(e *ExecutionEvent) { e.IssueID = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := testEvent("run-1")
			tc.mutate(&e)
			if _, err := store.Append(e); err == nil {
				t.Error("err = nil, want error")
			}
		})
	}
}
