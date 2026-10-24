package events

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

func testInput(taskID string) TaskInput {
	return TaskInput{
		TaskID:          taskID,
		IssueID:         "DAT-181",
		RunID:           "run-" + taskID,
		RequestedAt:     time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC),
		RepositoryURL:   "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:         "base-sha",
		Summary:         "repair the reported issue",
		SourceReference: "issue://DAT-181",
	}
}

func TestStoreAssignsSequenceAndKeepsReturnedEventsImmutable(t *testing.T) {
	store := NewEventStore()
	input := testInput("task-sequence")
	first, err := store.Append(NewTaskInputEvent(input))
	if err != nil {
		t.Fatalf("append input: %v", err)
	}
	if first.Sequence != 1 || first.EventID == "" {
		t.Fatalf("first event = %+v, want sequence and event ID", first)
	}

	plan := Plan{Summary: "run the approved tool", Steps: []PlanStep{{ID: "step-1", Tool: "go-test", Arguments: []string{"./..."}}}}
	second, err := store.Append(NewPlanEvent(input.TaskID, plan, input.RequestedAt.Add(time.Second)))
	if err != nil {
		t.Fatalf("append plan: %v", err)
	}
	if second.Sequence != 2 {
		t.Fatalf("second sequence = %d, want 2", second.Sequence)
	}

	second.Plan.Steps[0].Arguments[0] = "mutated"
	got := store.Events(input.TaskID)
	if got[1].Plan.Steps[0].Arguments[0] != "./..." {
		t.Fatal("mutating returned event changed the retained timeline")
	}
	if got[0].Input.TaskID != input.TaskID {
		t.Fatalf("input task ID = %q, want %q", got[0].Input.TaskID, input.TaskID)
	}
}

func TestStateTransitionsRejectIllegalChanges(t *testing.T) {
	store := NewStore()
	input := testInput("task-state")
	if _, err := store.Append(NewTaskInputEvent(input)); err != nil {
		t.Fatal(err)
	}
	when := input.RequestedAt.Add(time.Second)
	if _, err := store.Append(NewStateTransitionEvent(input.TaskID, StateRequested, StateApproved, when)); err != nil {
		t.Fatalf("requested -> approved: %v", err)
	}
	if _, err := store.Append(NewStateTransitionEvent(input.TaskID, StateRequested, StateRejected, when.Add(time.Second))); err == nil {
		t.Fatal("stale prior state must be rejected")
	}
	if _, err := store.Append(NewStateTransitionEvent(input.TaskID, StateApproved, StateMerged, when.Add(time.Second))); err == nil {
		t.Fatal("illegal approved -> merged transition must be rejected")
	}
	if _, err := store.Append(NewStateTransitionEvent(input.TaskID, StateApproved, StateCancelled, when.Add(time.Second))); err != nil {
		t.Fatalf("approved -> cancelled: %v", err)
	}
}

func TestHarnessReferenceRetainsIdentityWithoutCopyingAuditEvent(t *testing.T) {
	harnessEvent := harness.ExecutionEvent{
		RunID:           "run-audit",
		EventID:         "evt-run-audit-1",
		Sequence:        4,
		EventDigest:     "digest-4",
		DigestAlgorithm: harness.DigestAlgorithmSHA256,
	}
	ref, err := NewHarnessEvidenceReference(harnessEvent)
	if err != nil {
		t.Fatalf("NewHarnessEvidenceReference: %v", err)
	}
	if ref.Reference != "evidence://events/run-audit/4" || ref.EventID != harnessEvent.EventID {
		t.Fatalf("reference = %+v, want existing harness identity", ref)
	}
	if ref.Digest == nil || ref.Digest.Value != harnessEvent.EventDigest {
		t.Fatalf("digest = %+v, want harness digest", ref.Digest)
	}
}

func TestExportIncludesOrderedEventsAndDeduplicatedEvidence(t *testing.T) {
	store := NewStore()
	input := testInput("task-export")
	if _, err := store.Append(NewTaskInputEvent(input)); err != nil {
		t.Fatal(err)
	}
	ref, err := NewEvidenceReference("evidence://events/run/1", "audit_event", "harness", &Digest{Algorithm: "sha256", Value: "abc"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := store.Append(NewEvidenceEvent(input.TaskID, []EvidenceReference{ref}, input.RequestedAt.Add(time.Duration(i+1)*time.Second))); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Append(NewStateTransitionEvent(input.TaskID, StateRequested, StateRejected, input.RequestedAt.Add(3*time.Second), ref)); err != nil {
		t.Fatal(err)
	}

	timeline, err := store.Timeline(input.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if timeline.TaskID != input.TaskID || timeline.State != StateRejected {
		t.Fatalf("timeline identity/state = %q/%q", timeline.TaskID, timeline.State)
	}
	if len(timeline.Events) != 4 || len(timeline.EvidenceReferences) != 1 {
		t.Fatalf("timeline events/evidence = %d/%d, want 4/1", len(timeline.Events), len(timeline.EvidenceReferences))
	}
	for i, event := range timeline.Events {
		if event.Sequence != i+1 {
			t.Errorf("event %d sequence = %d, want %d", i, event.Sequence, i+1)
		}
	}
	raw, err := store.Export(input.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Timeline
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("export is not JSON: %v", err)
	}
	if decoded.TaskID != input.TaskID || len(decoded.Events) != 4 {
		t.Fatalf("decoded timeline = %+v", decoded)
	}
}

func TestToolArgumentsAreRedactedAndTerminalOutcomesAreRepresentable(t *testing.T) {
	store := NewStore()
	input := testInput("task-terminal")
	if _, err := store.Append(NewTaskInputEvent(input)); err != nil {
		t.Fatal(err)
	}
	tool, err := store.Append(NewToolInvocationEvent(input.TaskID, ToolInvocation{RequestedTool: "go-test", ActualTool: "go-test", Arguments: []string{"token=secret"}}, input.RequestedAt.Add(time.Second)))
	if err != nil {
		t.Fatal(err)
	}
	if tool.Tool.Arguments[0] != "token=[REDACTED]" {
		t.Fatalf("tool arguments = %q, want redacted", tool.Tool.Arguments[0])
	}

	for name, path := range map[string][]State{
		"success": {StateRequested, StateApproved, StateRunning, StateAwaitingReview, StateApprovedForMerge, StateMerged},
		"reject":  {StateRequested, StateRejected},
		"cancel":  {StateRequested, StateApproved, StateCancelled},
		"timeout": {StateRequested, StateApproved, StateRunning, StateTimedOut},
	} {
		t.Run(name, func(t *testing.T) {
			local := NewStore()
			localInput := input
			localInput.TaskID = "task-" + name
			if _, err := local.Append(NewTaskInputEvent(localInput)); err != nil {
				t.Fatal(err)
			}
			for i := 1; i < len(path); i++ {
				if _, err := local.Append(NewStateTransitionEvent(localInput.TaskID, path[i-1], path[i], localInput.RequestedAt.Add(time.Duration(i)*time.Second))); err != nil {
					t.Fatalf("transition %d: %v", i, err)
				}
			}
			got, err := local.Timeline(localInput.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != path[len(path)-1] {
				t.Fatalf("final state = %q, want %q", got.State, path[len(path)-1])
			}
		})
	}
}
