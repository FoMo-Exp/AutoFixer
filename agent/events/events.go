// Package events provides the append-only timeline used by an Agent task.
//
// A timeline records the Agent-facing facts (input, plan, tool invocation,
// state changes, evidence, and artifacts) without copying the underlying
// harness audit records. Audit records are retained as typed references to
// their existing run/event/digest identity.
package events

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

const (
	// ContractVersion is the version carried by every exported timeline and
	// event. It is the same evidence contract used by the harness.
	ContractVersion = harness.ContractVersion

	EventTypeTaskInput       EventType = "task_input"
	EventTypePlan            EventType = "plan"
	EventTypeToolInvocation  EventType = "tool_invocation"
	EventTypeStateTransition EventType = "state_transition"
	EventTypeEvidence        EventType = "evidence"
	EventTypeArtifact        EventType = "artifact"
	EventTypeStateChange               = EventTypeStateTransition
	EventTypeToolCall                  = EventTypeToolInvocation
	EventTypeFinalArtifact             = EventTypeArtifact
)

// EventType identifies the kind of Agent fact recorded in a timeline.
type EventType string

// EventStore is the descriptive name used by integrations that treat the
// timeline as an audit-like event log.
type EventStore = Store

// EventRecord and the concise reference aliases keep call sites readable.
type EventRecord = Event
type EvidenceRef = EvidenceReference
type ArtifactRef = ArtifactReference

// State is the governed remediation-run state. Keeping the state type shared
// with harness prevents this package from inventing a second, incompatible
// lifecycle vocabulary.
type State = harness.State

const (
	StateRequested        = harness.StateRequested
	StateApproved         = harness.StateApproved
	StateRunning          = harness.StateRunning
	StateAwaitingReview   = harness.StateAwaitingReview
	StateApprovedForMerge = harness.StateApprovedForMerge
	StateStopped          = harness.StateStopped
	StateTimedOut         = harness.StateTimedOut
	StateExpired          = harness.StateExpired
	StateRejected         = harness.StateRejected
	StateCancelled        = harness.StateCancelled
	StateMerged           = harness.StateMerged
)

// Digest names a retained artifact or output digest without retaining the
// artifact itself in the Agent session.
type Digest struct {
	Algorithm string `json:"algorithm"`
	Value     string `json:"value"`
}

// EvidenceReference points at evidence retained by another subsystem. The
// reference is deliberately small: the full harness.ExecutionEvent remains
// in the harness EventStore and is never duplicated into the session.
type EvidenceReference struct {
	ID        string  `json:"id,omitempty"`
	Reference string  `json:"reference"`
	Kind      string  `json:"kind"`
	Source    string  `json:"source"`
	RunID     string  `json:"run_id,omitempty"`
	EventID   string  `json:"event_id,omitempty"`
	Sequence  int     `json:"sequence,omitempty"`
	Digest    *Digest `json:"digest,omitempty"`
}

// NewEvidenceReference creates a reference to an existing evidence item.
func NewEvidenceReference(reference, kind, source string, digest *Digest) (EvidenceReference, error) {
	if strings.TrimSpace(reference) == "" {
		return EvidenceReference{}, errors.New("events: evidence reference is required")
	}
	if strings.TrimSpace(kind) == "" {
		return EvidenceReference{}, errors.New("events: evidence kind is required")
	}
	if strings.TrimSpace(source) == "" {
		return EvidenceReference{}, errors.New("events: evidence source is required")
	}
	if digest != nil && (strings.TrimSpace(digest.Algorithm) == "" || strings.TrimSpace(digest.Value) == "") {
		return EvidenceReference{}, errors.New("events: evidence digest must name an algorithm and value")
	}
	ref := EvidenceReference{ID: reference, Reference: reference, Kind: kind, Source: source}
	if digest != nil {
		copy := *digest
		ref.Digest = &copy
	}
	return ref, nil
}

// NewHarnessEvidenceReference links an Agent event to one immutable harness
// audit event. Only the existing event's identity and digest are retained.
func NewHarnessEvidenceReference(event harness.ExecutionEvent) (EvidenceReference, error) {
	if event.RunID == "" || event.EventID == "" || event.Sequence <= 0 || event.EventDigest == "" {
		return EvidenceReference{}, errors.New("events: harness event is missing its immutable identity or digest")
	}
	return EvidenceReference{
		ID:        fmt.Sprintf("evidence://events/%s/%d", event.RunID, event.Sequence),
		Reference: fmt.Sprintf("evidence://events/%s/%d", event.RunID, event.Sequence),
		Kind:      "audit_event",
		Source:    "harness",
		RunID:     event.RunID,
		EventID:   event.EventID,
		Sequence:  event.Sequence,
		Digest: &Digest{
			Algorithm: event.DigestAlgorithm,
			Value:     event.EventDigest,
		},
	}, nil
}

// NewHarnessAuditReference is a descriptive alias for callers that use the
// term audit rather than evidence.
func NewHarnessAuditReference(event harness.ExecutionEvent) (EvidenceReference, error) {
	return NewHarnessEvidenceReference(event)
}

// ArtifactReference indexes a produced artifact while leaving its contents
// outside the in-process session.
type ArtifactReference struct {
	Name      string  `json:"name"`
	Reference string  `json:"reference"`
	Digest    *Digest `json:"digest,omitempty"`
}

// ToolInvocation records the redacted request and observed tool identity.
type ToolInvocation struct {
	RequestedTool string   `json:"requested_tool"`
	ActualTool    string   `json:"actual_tool"`
	Arguments     []string `json:"arguments"`
	ExitStatus    *int     `json:"exit_status,omitempty"`
	OutputDigest  *Digest  `json:"output_digest,omitempty"`
}

// PlanStep is one deterministic planner output step.
type PlanStep struct {
	ID        string   `json:"id"`
	Tool      string   `json:"tool"`
	Arguments []string `json:"arguments"`
}

// Plan is intentionally transport-neutral so AFP-03/AFP-05 can attach their
// structured plan without changing the session store.
type Plan struct {
	Summary string     `json:"summary"`
	Steps   []PlanStep `json:"steps"`
}

// TaskInput is the immutable input captured when a session is created.
type TaskInput struct {
	ContractVersion string    `json:"contract_version"`
	TaskID          string    `json:"task_id"`
	IssueID         string    `json:"issue_id"`
	RunID           string    `json:"run_id,omitempty"`
	RequestedAt     time.Time `json:"requested_at"`
	RepositoryURL   string    `json:"repository_url"`
	BaseSHA         string    `json:"base_sha"`
	Summary         string    `json:"summary"`
	SourceReference string    `json:"source_reference"`
}

// Event is one immutable append-only fact in a task timeline. State fields
// are populated only for EventTypeStateTransition. Payload is optional JSON
// for package users that need a small extension without storing secrets.
type Event struct {
	ContractVersion string    `json:"contract_version"`
	EventID         string    `json:"event_id"`
	Sequence        int       `json:"sequence"`
	TaskID          string    `json:"task_id"`
	RunID           string    `json:"run_id,omitempty"`
	Type            EventType `json:"type"`
	// Kind is accepted as an input alias for Type and normalized on append.
	// It is omitted from JSON so exports have one canonical event-type field.
	Kind               EventType           `json:"-"`
	OccurredAt         time.Time           `json:"occurred_at"`
	PriorState         *State              `json:"prior_state,omitempty"`
	ResultingState     *State              `json:"resulting_state,omitempty"`
	Input              *TaskInput          `json:"input,omitempty"`
	Plan               *Plan               `json:"plan,omitempty"`
	Tool               *ToolInvocation     `json:"tool,omitempty"`
	EvidenceReferences []EvidenceReference `json:"evidence_references"`
	ArtifactReferences []ArtifactReference `json:"artifact_references"`
	Payload            json.RawMessage     `json:"payload,omitempty"`
	Summary            string              `json:"summary,omitempty"`
}

// Timeline is the serializable task-level view of the append-only events.
// Events are ordered by Sequence. EvidenceReferences and ArtifactReferences
// are deduplicated indexes over those events.
type Timeline struct {
	ContractVersion    string              `json:"contract_version"`
	TaskID             string              `json:"task_id"`
	Input              *TaskInput          `json:"input,omitempty"`
	State              State               `json:"state"`
	Events             []Event             `json:"events"`
	EvidenceReferences []EvidenceReference `json:"evidence_references"`
	ArtifactReferences []ArtifactReference `json:"artifact_references"`
}

// Exporter is implemented by stores that can serialize a task timeline.
type Exporter interface {
	Export(taskID string) ([]byte, error)
}

// Store is an in-memory append-only event store. It is safe for concurrent
// append/query operations. Returned values are deep copies, so callers cannot
// mutate the retained timeline through a slice, map, or pointer.
type Store struct {
	mu     sync.RWMutex
	events map[string][]Event
	states map[string]State
	now    func() time.Time
}

// NewStore returns an empty event store.
func NewStore() *Store {
	return &Store{
		events: make(map[string][]Event),
		states: make(map[string]State),
		now:    time.Now,
	}
}

// NewEventStore is an alias for NewStore.
func NewEventStore() *Store { return NewStore() }

// Append validates and stores an event, assigning its sequence and ID. A
// state transition is accepted only when it starts at the task's current
// state and exists in the governed harness transition table.
func (s *Store) Append(event Event) (Event, error) {
	if s == nil {
		return Event{}, errors.New("events: nil store")
	}
	if event.Type == "" {
		event.Type = event.Kind
	}
	if event.Kind != "" && event.Kind != event.Type {
		return Event{}, errors.New("events: type and kind do not match")
	}
	if err := validateEventShape(event); err != nil {
		return Event{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.events == nil {
		s.events = make(map[string][]Event)
	}
	if s.states == nil {
		s.states = make(map[string]State)
	}
	if _, exists := s.states[event.TaskID]; !exists {
		s.states[event.TaskID] = StateRequested
	}
	if event.Type == EventTypeTaskInput && len(s.events[event.TaskID]) > 0 {
		return Event{}, errors.New("events: task input is immutable and may only be recorded once")
	}

	current := s.states[event.TaskID]
	if event.Type == EventTypeStateTransition {
		if event.PriorState == nil || event.ResultingState == nil {
			return Event{}, errors.New("events: state transition requires prior and resulting states")
		}
		if *event.PriorState != current {
			return Event{}, fmt.Errorf("events: state transition starts at %q, current state is %q", *event.PriorState, current)
		}
		if !harness.CanTransition(*event.PriorState, *event.ResultingState) {
			return Event{}, fmt.Errorf("events: illegal state transition %q -> %q", *event.PriorState, *event.ResultingState)
		}
	}

	sequence := len(s.events[event.TaskID]) + 1
	event.Sequence = sequence
	if event.EventID == "" {
		event.EventID = fmt.Sprintf("evt-%s-%d", event.TaskID, sequence)
	}
	if event.ContractVersion == "" {
		event.ContractVersion = ContractVersion
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = s.now().UTC()
	} else {
		event.OccurredAt = event.OccurredAt.UTC()
	}
	if event.EvidenceReferences == nil {
		event.EvidenceReferences = []EvidenceReference{}
	}
	if event.ArtifactReferences == nil {
		event.ArtifactReferences = []ArtifactReference{}
	}
	stored := cloneEvent(event)
	redactToolInvocation(stored.Tool)
	stored.Kind = stored.Type
	s.events[event.TaskID] = append(s.events[event.TaskID], stored)
	if event.Type == EventTypeStateTransition {
		s.states[event.TaskID] = *event.ResultingState
	}
	return cloneEvent(stored), nil
}

// AppendEvent is a descriptive alias for Append.
func (s *Store) AppendEvent(event Event) (Event, error) { return s.Append(event) }

// CurrentState returns a task's current state. A task with recorded events
// but no transition is still in the initial requested state.
func (s *Store) CurrentState(taskID string) (State, error) {
	if strings.TrimSpace(taskID) == "" {
		return "", errors.New("events: task ID is required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.events[taskID]; !ok {
		return "", fmt.Errorf("events: task %q not found", taskID)
	}
	return s.states[taskID], nil
}

// Events returns a deep-copied, sequence-ordered event list for taskID.
func (s *Store) Events(taskID string) []Event {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	stored := s.events[taskID]
	if stored == nil {
		return []Event{}
	}
	out := make([]Event, len(stored))
	for i, event := range stored {
		out[i] = cloneEvent(event)
	}
	return out
}

// Timeline builds a deep-copied serializable view for one task.
func (s *Store) Timeline(taskID string) (Timeline, error) {
	if strings.TrimSpace(taskID) == "" {
		return Timeline{}, errors.New("events: task ID is required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	stored, ok := s.events[taskID]
	if !ok || len(stored) == 0 {
		return Timeline{}, fmt.Errorf("events: task %q not found", taskID)
	}

	timeline := Timeline{
		ContractVersion:    ContractVersion,
		TaskID:             taskID,
		State:              s.states[taskID],
		Events:             make([]Event, 0, len(stored)),
		EvidenceReferences: []EvidenceReference{},
		ArtifactReferences: []ArtifactReference{},
	}
	seenEvidence := make(map[string]bool)
	seenArtifacts := make(map[string]bool)
	for _, event := range stored {
		copy := cloneEvent(event)
		timeline.Events = append(timeline.Events, copy)
		if copy.Input != nil && timeline.Input == nil {
			input := cloneTaskInput(copy.Input)
			timeline.Input = &input
		}
		for _, ref := range copy.EvidenceReferences {
			key := ref.Reference + "\x00" + ref.Kind + "\x00" + ref.Source
			if !seenEvidence[key] {
				seenEvidence[key] = true
				timeline.EvidenceReferences = append(timeline.EvidenceReferences, cloneEvidenceReference(ref))
			}
		}
		for _, ref := range copy.ArtifactReferences {
			key := ref.Name + "\x00" + ref.Reference
			if !seenArtifacts[key] {
				seenArtifacts[key] = true
				timeline.ArtifactReferences = append(timeline.ArtifactReferences, cloneArtifactReference(ref))
			}
		}
	}
	return timeline, nil
}

// Export serializes one timeline as stable JSON suitable for a report bundle.
func (s *Store) Export(taskID string) ([]byte, error) {
	timeline, err := s.Timeline(taskID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(timeline)
}

// ExportJSON is an explicit alias for callers that want to name the format.
func (s *Store) ExportJSON(taskID string) ([]byte, error) { return s.Export(taskID) }

func validateEventShape(event Event) error {
	if strings.TrimSpace(event.TaskID) == "" {
		return errors.New("events: task ID is required")
	}
	switch event.Type {
	case EventTypeTaskInput, EventTypePlan, EventTypeToolInvocation, EventTypeStateTransition, EventTypeEvidence, EventTypeArtifact:
	default:
		return fmt.Errorf("events: unknown event type %q", event.Type)
	}
	if event.ContractVersion != "" && event.ContractVersion != ContractVersion {
		return fmt.Errorf("events: unsupported contract version %q", event.ContractVersion)
	}
	if !event.OccurredAt.IsZero() && event.OccurredAt.Location() == nil {
		return errors.New("events: occurred_at has no location")
	}
	if event.Type == EventTypeTaskInput && event.Input == nil {
		return errors.New("events: task_input event requires input")
	}
	if event.Input != nil {
		if event.Input.TaskID == "" {
			return errors.New("events: input task ID is required")
		}
		if event.Input.TaskID != event.TaskID {
			return errors.New("events: input task ID does not match event task ID")
		}
	}
	if event.Type == EventTypePlan && event.Plan == nil {
		return errors.New("events: plan event requires plan")
	}
	if event.Type == EventTypeToolInvocation && event.Tool == nil {
		return errors.New("events: tool invocation event requires tool")
	}
	if event.Tool != nil && strings.TrimSpace(event.Tool.RequestedTool) == "" && strings.TrimSpace(event.Tool.ActualTool) == "" {
		return errors.New("events: tool invocation requires a requested or actual tool")
	}
	if event.Type == EventTypeEvidence && len(event.EvidenceReferences) == 0 {
		return errors.New("events: evidence event requires at least one evidence reference")
	}
	if event.Type == EventTypeArtifact && len(event.ArtifactReferences) == 0 {
		return errors.New("events: artifact event requires at least one artifact reference")
	}
	if event.Payload != nil && !json.Valid(event.Payload) {
		return errors.New("events: payload is not valid JSON")
	}
	for _, ref := range event.EvidenceReferences {
		if err := validateEvidenceReference(ref); err != nil {
			return err
		}
	}
	for _, ref := range event.ArtifactReferences {
		if strings.TrimSpace(ref.Name) == "" || strings.TrimSpace(ref.Reference) == "" {
			return errors.New("events: artifact reference requires a name and reference")
		}
		if err := validateDigest(ref.Digest); err != nil {
			return err
		}
	}
	return nil
}

func validateEvidenceReference(ref EvidenceReference) error {
	if strings.TrimSpace(ref.Reference) == "" || strings.TrimSpace(ref.Kind) == "" || strings.TrimSpace(ref.Source) == "" {
		return errors.New("events: evidence reference requires reference, kind, and source")
	}
	if ref.Sequence < 0 {
		return errors.New("events: evidence sequence cannot be negative")
	}
	return validateDigest(ref.Digest)
}

func validateDigest(digest *Digest) error {
	if digest != nil && (strings.TrimSpace(digest.Algorithm) == "" || strings.TrimSpace(digest.Value) == "") {
		return errors.New("events: digest must name an algorithm and value")
	}
	return nil
}

func redactToolInvocation(tool *ToolInvocation) {
	if tool == nil {
		return
	}
	for i, argument := range tool.Arguments {
		tool.Arguments[i] = harness.Redact(argument)
	}
}

func cloneEvent(event Event) Event {
	out := event
	if event.PriorState != nil {
		state := *event.PriorState
		out.PriorState = &state
	}
	if event.ResultingState != nil {
		state := *event.ResultingState
		out.ResultingState = &state
	}
	if event.Input != nil {
		input := cloneTaskInput(event.Input)
		out.Input = &input
	}
	if event.Plan != nil {
		plan := *event.Plan
		plan.Steps = append([]PlanStep{}, event.Plan.Steps...)
		for i := range plan.Steps {
			plan.Steps[i].Arguments = append([]string{}, event.Plan.Steps[i].Arguments...)
		}
		out.Plan = &plan
	}
	if event.Tool != nil {
		tool := *event.Tool
		tool.Arguments = append([]string{}, event.Tool.Arguments...)
		if event.Tool.ExitStatus != nil {
			status := *event.Tool.ExitStatus
			tool.ExitStatus = &status
		}
		if event.Tool.OutputDigest != nil {
			digest := *event.Tool.OutputDigest
			tool.OutputDigest = &digest
		}
		out.Tool = &tool
	}
	out.EvidenceReferences = make([]EvidenceReference, len(event.EvidenceReferences))
	for i, ref := range event.EvidenceReferences {
		out.EvidenceReferences[i] = cloneEvidenceReference(ref)
	}
	out.ArtifactReferences = make([]ArtifactReference, len(event.ArtifactReferences))
	for i, ref := range event.ArtifactReferences {
		out.ArtifactReferences[i] = cloneArtifactReference(ref)
	}
	out.Payload = append(json.RawMessage{}, event.Payload...)
	return out
}

func cloneTaskInput(input *TaskInput) TaskInput {
	if input == nil {
		return TaskInput{}
	}
	return *input
}

func cloneEvidenceReference(ref EvidenceReference) EvidenceReference {
	out := ref
	if ref.Digest != nil {
		digest := *ref.Digest
		out.Digest = &digest
	}
	return out
}

func cloneArtifactReference(ref ArtifactReference) ArtifactReference {
	out := ref
	if ref.Digest != nil {
		digest := *ref.Digest
		out.Digest = &digest
	}
	return out
}

// NewTaskInputEvent constructs the immutable first event for a session.
func NewTaskInputEvent(input TaskInput) Event {
	if input.ContractVersion == "" {
		input.ContractVersion = ContractVersion
	}
	return Event{Type: EventTypeTaskInput, TaskID: input.TaskID, RunID: input.RunID, OccurredAt: input.RequestedAt, Input: &input}
}

// NewPlanEvent constructs a planner event.
func NewPlanEvent(taskID string, plan Plan, occurredAt time.Time) Event {
	return Event{Type: EventTypePlan, TaskID: taskID, OccurredAt: occurredAt, Plan: &plan}
}

// NewToolInvocationEvent constructs a tool-call event.
func NewToolInvocationEvent(taskID string, tool ToolInvocation, occurredAt time.Time, evidence ...EvidenceReference) Event {
	return Event{Type: EventTypeToolInvocation, TaskID: taskID, OccurredAt: occurredAt, Tool: &tool, EvidenceReferences: append([]EvidenceReference{}, evidence...)}
}

// NewStateTransitionEvent constructs a governed state-change event.
func NewStateTransitionEvent(taskID string, from, to State, occurredAt time.Time, evidence ...EvidenceReference) Event {
	return Event{Type: EventTypeStateTransition, TaskID: taskID, OccurredAt: occurredAt, PriorState: &from, ResultingState: &to, EvidenceReferences: append([]EvidenceReference{}, evidence...)}
}

// NewEvidenceEvent constructs an event that indexes existing evidence.
func NewEvidenceEvent(taskID string, refs []EvidenceReference, occurredAt time.Time) Event {
	return Event{Type: EventTypeEvidence, TaskID: taskID, OccurredAt: occurredAt, EvidenceReferences: append([]EvidenceReference{}, refs...)}
}

// NewArtifactEvent constructs an event that indexes produced artifacts.
func NewArtifactEvent(taskID string, refs []ArtifactReference, occurredAt time.Time) Event {
	return Event{Type: EventTypeArtifact, TaskID: taskID, OccurredAt: occurredAt, ArtifactReferences: append([]ArtifactReference{}, refs...)}
}
