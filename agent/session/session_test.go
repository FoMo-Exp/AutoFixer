package session

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/agent/events"
)

func sessionInput(taskID string) TaskInput {
	return TaskInput{
		TaskID:          taskID,
		IssueID:         "DAT-181",
		RunID:           "run-" + taskID,
		RequestedAt:     time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC),
		RepositoryURL:   "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:         "base-sha",
		Summary:         "capture the Agent task",
		SourceReference: "issue://DAT-181",
	}
}

func TestStoreCreatesAndQueriesByTaskID(t *testing.T) {
	store := NewSessionStore()
	input := sessionInput("task-session")
	sess, err := store.Create(input)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sess.TaskID() != input.TaskID {
		t.Fatalf("TaskID = %q, want %q", sess.TaskID(), input.TaskID)
	}
	byID, err := store.GetByTaskID(input.TaskID)
	if err != nil {
		t.Fatalf("GetByTaskID: %v", err)
	}
	if byID.TaskID() != sess.TaskID() {
		t.Fatalf("lookup TaskID = %q, want %q", byID.TaskID(), sess.TaskID())
	}
	snapshot, err := byID.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.State != StateRequested || snapshot.Input.TaskID != input.TaskID {
		t.Fatalf("snapshot = %+v, want requested task", snapshot)
	}
	if _, err := store.Create(input); err == nil {
		t.Fatal("duplicate task ID must be rejected")
	}
}

func TestSessionRecordsPlanToolsStateAndAuditEvidence(t *testing.T) {
	store := NewStore()
	input := sessionInput("task-timeline")
	sess, err := store.Create(input)
	if err != nil {
		t.Fatal(err)
	}
	when := input.RequestedAt.Add(time.Second)
	if _, err := sess.Record(events.NewPlanEvent(input.TaskID, events.Plan{
		Summary: "run one approved tool",
		Steps:   []events.PlanStep{{ID: "step-1", Tool: "go-test", Arguments: []string{"./..."}}},
	}, when)); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Record(events.NewToolInvocationEvent(input.TaskID, events.ToolInvocation{
		RequestedTool: "go-test",
		ActualTool:    "go-test",
		Arguments:     []string{"./..."},
	}, when.Add(time.Second))); err != nil {
		t.Fatal(err)
	}
	ref, err := events.NewEvidenceReference("evidence://events/run/2", "audit_event", "harness", &events.Digest{Algorithm: "sha256", Value: "digest"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Transition(StateApproved, when.Add(2*time.Second), ref); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Transition(StateRunning, when.Add(3*time.Second), ref); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Transition(StateTimedOut, when.Add(4*time.Second), ref); err != nil {
		t.Fatal(err)
	}

	timeline, err := sess.Timeline()
	if err != nil {
		t.Fatal(err)
	}
	if timeline.TaskID != input.TaskID || timeline.State != StateTimedOut {
		t.Fatalf("timeline identity/state = %q/%q", timeline.TaskID, timeline.State)
	}
	if len(timeline.Events) != 6 || len(timeline.EvidenceReferences) != 1 {
		t.Fatalf("timeline event/evidence count = %d/%d, want 6/1", len(timeline.Events), len(timeline.EvidenceReferences))
	}

	raw, err := sess.Export()
	if err != nil {
		t.Fatal(err)
	}
	var decoded events.Timeline
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("export JSON: %v", err)
	}
	if decoded.TaskID != input.TaskID || decoded.State != StateTimedOut {
		t.Fatalf("decoded timeline = %+v", decoded)
	}
}

func TestSessionRejectsIllegalStateChangeAndDoesNotOverwriteHistory(t *testing.T) {
	store := NewStore()
	sess, err := store.Create(sessionInput("task-immutable"))
	if err != nil {
		t.Fatal(err)
	}
	when := time.Date(2026, 10, 23, 12, 0, 1, 0, time.UTC)
	if _, err := sess.Transition(StateApproved, when); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Transition(StateMerged, when.Add(time.Second)); err == nil {
		t.Fatal("illegal approved -> merged transition must be rejected")
	}
	snapshot, err := sess.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.State != StateApproved {
		t.Fatalf("state after rejected transition = %q, want %q", snapshot.State, StateApproved)
	}
	timeline, err := sess.Timeline()
	if err != nil {
		t.Fatal(err)
	}
	if len(timeline.Events) != 2 {
		t.Fatalf("event count after rejected transition = %d, want 2", len(timeline.Events))
	}
}
