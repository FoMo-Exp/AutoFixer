// Package session provides the in-process task session registry.
//
// A session owns the immutable task input and delegates its append-only
// timeline to agent/events. Sessions are keyed by task ID and can be exported
// as one serializable timeline for the later Agent integration.
package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Luthiel/AutoFixer/agent/events"
)

// TaskInput is the public session input type. It aliases the serializable
// event-layer input so callers do not need conversion glue.
type TaskInput = events.TaskInput

// State is the governed state vocabulary shared with the harness.
type State = events.State

const (
	StateRequested        = events.StateRequested
	StateApproved         = events.StateApproved
	StateRunning          = events.StateRunning
	StateAwaitingReview   = events.StateAwaitingReview
	StateApprovedForMerge = events.StateApprovedForMerge
	StateStopped          = events.StateStopped
	StateTimedOut         = events.StateTimedOut
	StateExpired          = events.StateExpired
	StateRejected         = events.StateRejected
	StateCancelled        = events.StateCancelled
	StateMerged           = events.StateMerged
)

// Snapshot is a read-only view of session metadata. The session's immutable
// event history is available through Timeline.
type Snapshot struct {
	TaskID    string    `json:"task_id"`
	Input     TaskInput `json:"input"`
	State     State     `json:"state"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Store is an in-memory registry keyed by task ID. It is safe for concurrent
// session creation, lookup, event append, and export.
type Store struct {
	mu       sync.RWMutex
	sessions map[string]*record
	events   *events.Store
	now      func() time.Time
}

// SessionStore is the descriptive name used by integrations that keep a
// registry alongside a task loop.
type SessionStore = Store

type record struct {
	input     TaskInput
	createdAt time.Time
	updatedAt time.Time
}

// Session is a stable handle to one task ID. It contains no mutable event
// data; all writes go through its owning Store.
type Session struct {
	store  *Store
	taskID string
}

// NewStore returns an empty in-process session store.
func NewStore() *Store {
	return &Store{
		sessions: make(map[string]*record),
		events:   events.NewStore(),
		now:      time.Now,
	}
}

// NewSessionStore is a descriptive alias for NewStore.
func NewSessionStore() *Store { return NewStore() }

// NewStoreWithEvents shares a caller-owned append-only event store. This is
// useful when the integration wants one event source for multiple adapters.
func NewStoreWithEvents(eventStore *events.Store) (*Store, error) {
	if eventStore == nil {
		return nil, errors.New("session: event store is required")
	}
	store := NewStore()
	store.events = eventStore
	return store, nil
}

// Create records the immutable task input and returns a session handle.
func (s *Store) Create(input TaskInput) (*Session, error) {
	if s == nil {
		return nil, errors.New("session: nil store")
	}
	if err := validateInput(input); err != nil {
		return nil, err
	}
	if input.ContractVersion == "" {
		input.ContractVersion = events.ContractVersion
	}
	if input.RequestedAt.IsZero() {
		input.RequestedAt = s.now().UTC()
	} else {
		input.RequestedAt = input.RequestedAt.UTC()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions == nil {
		s.sessions = make(map[string]*record)
	}
	if _, exists := s.sessions[input.TaskID]; exists {
		return nil, fmt.Errorf("session: task %q already exists", input.TaskID)
	}
	if _, err := s.events.Append(events.NewTaskInputEvent(input)); err != nil {
		return nil, fmt.Errorf("session: record task input: %w", err)
	}
	now := s.now().UTC()
	s.sessions[input.TaskID] = &record{input: input, createdAt: now, updatedAt: now}
	return &Session{store: s, taskID: input.TaskID}, nil
}

// CreateSession is an explicit alias for Create.
func (s *Store) CreateSession(input TaskInput) (*Session, error) { return s.Create(input) }

// Get returns a stable handle for a task ID.
func (s *Store) Get(taskID string) (*Session, error) {
	if s == nil {
		return nil, errors.New("session: nil store")
	}
	if strings.TrimSpace(taskID) == "" {
		return nil, errors.New("session: task ID is required")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.sessions[taskID]; !ok {
		return nil, fmt.Errorf("session: task %q not found", taskID)
	}
	return &Session{store: s, taskID: taskID}, nil
}

// GetByTaskID is an explicit alias for Get.
func (s *Store) GetByTaskID(taskID string) (*Session, error) { return s.Get(taskID) }

// GetSession is an explicit alias for Get.
func (s *Store) GetSession(taskID string) (*Session, error) { return s.Get(taskID) }

// Snapshot returns immutable session metadata.
func (s *Store) Snapshot(taskID string) (Snapshot, error) {
	if s == nil {
		return Snapshot{}, errors.New("session: nil store")
	}
	s.mu.RLock()
	rec, ok := s.sessions[taskID]
	if !ok {
		s.mu.RUnlock()
		return Snapshot{}, fmt.Errorf("session: task %q not found", taskID)
	}
	input := rec.input
	createdAt, updatedAt := rec.createdAt, rec.updatedAt
	s.mu.RUnlock()
	state, err := s.events.CurrentState(taskID)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{TaskID: taskID, Input: input, State: state, CreatedAt: createdAt, UpdatedAt: updatedAt}, nil
}

// Append adds an event to this task's timeline. The task input event is
// reserved for Create and cannot overwrite the original request.
func (s *Store) Append(taskID string, event events.Event) (events.Event, error) {
	if s == nil {
		return events.Event{}, errors.New("session: nil store")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.sessions[taskID]
	if !ok {
		return events.Event{}, fmt.Errorf("session: task %q not found", taskID)
	}
	if event.Type == events.EventTypeTaskInput {
		return events.Event{}, errors.New("session: task input is immutable and can only be recorded at creation")
	}
	if event.TaskID == "" {
		event.TaskID = taskID
	}
	if event.TaskID != taskID {
		return events.Event{}, errors.New("session: event task ID does not match session")
	}
	appended, err := s.events.Append(event)
	if err != nil {
		return events.Event{}, err
	}
	rec.updatedAt = s.now().UTC()
	return appended, nil
}

// Record is a descriptive alias for Append.
func (s *Store) Record(taskID string, event events.Event) (events.Event, error) {
	return s.Append(taskID, event)
}

// Transition appends one legal governed state transition and returns the
// immutable event that was recorded.
func (s *Store) Transition(taskID string, to State, occurredAt time.Time, evidence ...events.EvidenceReference) (events.Event, error) {
	current, err := s.events.CurrentState(taskID)
	if err != nil {
		return events.Event{}, err
	}
	return s.Append(taskID, events.NewStateTransitionEvent(taskID, current, to, occurredAt, evidence...))
}

// Timeline returns the complete serializable task timeline.
func (s *Store) Timeline(taskID string) (events.Timeline, error) {
	if s == nil {
		return events.Timeline{}, errors.New("session: nil store")
	}
	return s.events.Timeline(taskID)
}

// Export serializes the task timeline as JSON.
func (s *Store) Export(taskID string) ([]byte, error) {
	if s == nil {
		return nil, errors.New("session: nil store")
	}
	return s.events.Export(taskID)
}

// ExportJSON is an explicit alias for Export.
func (s *Store) ExportJSON(taskID string) ([]byte, error) { return s.Export(taskID) }

// Events returns the immutable event copies for one task.
func (s *Store) Events(taskID string) []events.Event {
	if s == nil {
		return nil
	}
	return s.events.Events(taskID)
}

// TaskID returns the ID represented by this session handle.
func (session *Session) TaskID() string {
	if session == nil {
		return ""
	}
	return session.taskID
}

// Snapshot returns this session's current metadata.
func (session *Session) Snapshot() (Snapshot, error) {
	if session == nil || session.store == nil {
		return Snapshot{}, errors.New("session: nil session")
	}
	return session.store.Snapshot(session.taskID)
}

// State returns this session's current governed state.
func (session *Session) State() (State, error) {
	snapshot, err := session.Snapshot()
	if err != nil {
		return "", err
	}
	return snapshot.State, nil
}

// Append adds an event to this session.
func (session *Session) Append(event events.Event) (events.Event, error) {
	if session == nil || session.store == nil {
		return events.Event{}, errors.New("session: nil session")
	}
	return session.store.Append(session.taskID, event)
}

// Record is a descriptive alias for Append.
func (session *Session) Record(event events.Event) (events.Event, error) {
	return session.Append(event)
}

// Transition adds one legal state transition to this session.
func (session *Session) Transition(to State, occurredAt time.Time, evidence ...events.EvidenceReference) (events.Event, error) {
	if session == nil || session.store == nil {
		return events.Event{}, errors.New("session: nil session")
	}
	return session.store.Transition(session.taskID, to, occurredAt, evidence...)
}

// Timeline returns this session's full timeline.
func (session *Session) Timeline() (events.Timeline, error) {
	if session == nil || session.store == nil {
		return events.Timeline{}, errors.New("session: nil session")
	}
	return session.store.Timeline(session.taskID)
}

// Export serializes this session's timeline as JSON.
func (session *Session) Export() ([]byte, error) {
	if session == nil || session.store == nil {
		return nil, errors.New("session: nil session")
	}
	return session.store.Export(session.taskID)
}

// MarshalJSON makes a session handle useful in diagnostics without exposing
// the store or allowing a caller to mutate its data.
func (session *Session) MarshalJSON() ([]byte, error) {
	snapshot, err := session.Snapshot()
	if err != nil {
		return nil, err
	}
	return json.Marshal(snapshot)
}

func validateInput(input TaskInput) error {
	if strings.TrimSpace(input.TaskID) == "" {
		return errors.New("session: task ID is required")
	}
	if input.ContractVersion != "" && input.ContractVersion != events.ContractVersion {
		return fmt.Errorf("session: unsupported contract version %q", input.ContractVersion)
	}
	return nil
}
