package harness

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"
)

// Event types allowed by the evidence contract.
const (
	EventTypeStateTransition = "state_transition"
	EventTypeToolInvocation  = "tool_invocation"
)

// DigestAlgorithmSHA256 is the digest algorithm for event and report digests.
const DigestAlgorithmSHA256 = "sha256"

// Digest is a named artifact or output digest.
type Digest struct {
	Algorithm string `json:"algorithm"`
	Value     string `json:"value"`
}

// ToolRecord is a redacted tool identity and its arguments on an event.
type ToolRecord struct {
	Identity  string   `json:"identity"`
	Arguments []string `json:"arguments"`
}

// ExecutionEvent is the contract's append-only `execution_event` record.
type ExecutionEvent struct {
	ContractVersion        string      `json:"contract_version"`
	EventID                string      `json:"event_id"`
	Sequence               int         `json:"sequence"`
	EventType              string      `json:"event_type"`
	RunID                  string      `json:"run_id"`
	TaskID                 string      `json:"task_id"`
	IssueID                string      `json:"issue_id"`
	PrID                   *string     `json:"pr_id"`
	ActorIdentity          string      `json:"actor_identity"`
	ExecutionIdentity      string      `json:"execution_identity"`
	OccurredAt             time.Time   `json:"occurred_at"`
	PriorState             State       `json:"prior_state"`
	ResultingState         State       `json:"resulting_state"`
	RiskClass              RiskClass   `json:"risk_class"`
	PolicyVersion          string      `json:"policy_version"`
	CapabilityGrantVersion string      `json:"capability_grant_version"`
	RepositoryURL          string      `json:"repository_url"`
	BaseSHA                string      `json:"base_sha"`
	Branch                 *string     `json:"branch"`
	HeadSHA                *string     `json:"head_sha"`
	RequestedTool          *ToolRecord `json:"requested_tool"`
	ActualTool             *ToolRecord `json:"actual_tool"`
	PathScope              []string    `json:"path_scope"`
	NetworkScope           []string    `json:"network_scope"`
	ExitStatus             *int        `json:"exit_status"`
	OutputDigest           *Digest     `json:"output_digest"`
	ArtifactDigests        []Digest    `json:"artifact_digests"`
	ApprovalSnapshotRef    string      `json:"approval_snapshot_ref"`
	DecisionOrStopCode     *string     `json:"decision_or_stop_code"`
	PreviousEventDigest    *string     `json:"previous_event_digest"`
	EventDigest            string      `json:"event_digest"`
	DigestAlgorithm        string      `json:"digest_algorithm"`
}

var redactionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)((?:token|secret|password|passwd|credential|api[_-]?key|authorization)[=:][ \t]*)(\S+)`),
	regexp.MustCompile(`(?i)(bearer[ \t]+)(\S+)`),
}

// Redact removes secret-looking values from a string before it may be
// recorded in an event.
func Redact(s string) string {
	out := s
	for _, re := range redactionPatterns {
		out = re.ReplaceAllString(out, "${1}[REDACTED]")
	}
	return out
}

func redactTool(t *ToolRecord) *ToolRecord {
	if t == nil {
		return nil
	}
	args := make([]string, len(t.Arguments))
	for i, a := range t.Arguments {
		args[i] = Redact(a)
	}
	return &ToolRecord{Identity: t.Identity, Arguments: args}
}

// eventDigest computes the tamper-evident digest over the event's canonical
// content: every field except event_digest itself, after redaction.
func eventDigest(e ExecutionEvent) (string, error) {
	e.EventDigest = ""
	raw, err := json.Marshal(e)
	if err != nil {
		return "", fmt.Errorf("harness: canonicalize event: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// EventStore is an in-memory append-only event log with a per-run digest
// chain. It exposes no update or delete operations.
type EventStore struct {
	mu     sync.Mutex
	events []*ExecutionEvent

	// appendAttempts and failAt form a test seam: when failAt is non-zero,
	// the failAt-th Append call fails, letting tests exercise audit-write
	// failure paths deterministically.
	appendAttempts int
	failAt         int
}

// NewEventStore creates an empty append-only store.
func NewEventStore() *EventStore { return &EventStore{} }

// Append validates and stores one event, assigning its sequence, chain link,
// event ID, redacted tool records, and digest. It returns a copy.
func (s *EventStore) Append(e ExecutionEvent) (ExecutionEvent, error) {
	if e.EventType != EventTypeStateTransition && e.EventType != EventTypeToolInvocation {
		return ExecutionEvent{}, errors.New("harness: unknown event_type")
	}
	if e.RunID == "" || e.TaskID == "" || e.IssueID == "" {
		return ExecutionEvent{}, errors.New("harness: event is missing run, task, or issue identity")
	}
	if e.ActorIdentity == "" || e.ExecutionIdentity == "" || e.OccurredAt.IsZero() || e.ApprovalSnapshotRef == "" {
		return ExecutionEvent{}, errors.New("harness: event is missing a required contract field")
	}
	if !IsValidState(e.PriorState) || !IsValidState(e.ResultingState) {
		return ExecutionEvent{}, errors.New("harness: event carries an invented state value")
	}
	switch e.RiskClass {
	case RiskLow, RiskElevated, RiskProhibited:
	default:
		return ExecutionEvent{}, errors.New("harness: event carries an unknown risk class")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.appendAttempts++
	if s.failAt != 0 && s.appendAttempts == s.failAt {
		return ExecutionEvent{}, errors.New("harness: simulated audit write failure (test seam)")
	}

	var previous *string
	sequence := 1
	for i := len(s.events) - 1; i >= 0; i-- {
		if s.events[i].RunID == e.RunID {
			sequence = s.events[i].Sequence + 1
			prev := s.events[i].EventDigest
			previous = &prev
			break
		}
	}

	e.Sequence = sequence
	e.PreviousEventDigest = previous
	if e.EventID == "" {
		e.EventID = fmt.Sprintf("evt-%s-%d", e.RunID, e.Sequence)
	}
	if e.ContractVersion == "" {
		e.ContractVersion = ContractVersion
	}
	if e.DigestAlgorithm == "" {
		e.DigestAlgorithm = DigestAlgorithmSHA256
	}
	if e.PathScope == nil {
		e.PathScope = []string{}
	}
	if e.NetworkScope == nil {
		e.NetworkScope = []string{}
	}
	if e.ArtifactDigests == nil {
		e.ArtifactDigests = []Digest{}
	}
	e.RequestedTool = redactTool(e.RequestedTool)
	e.ActualTool = redactTool(e.ActualTool)

	digest, err := eventDigest(e)
	if err != nil {
		return ExecutionEvent{}, err
	}
	e.EventDigest = digest

	stored := e
	s.events = append(s.events, &stored)
	return e, nil
}

// VerifyChain checks sequence order, chain links, and digests for a run.
func (s *EventStore) VerifyChain(runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	sequence := 0
	var priorDigest *string
	for _, e := range s.events {
		if e.RunID != runID {
			continue
		}
		sequence++
		if e.Sequence != sequence {
			return fmt.Errorf("harness: event sequence %d, want %d", e.Sequence, sequence)
		}
		if sequence == 1 {
			if e.PreviousEventDigest != nil {
				return errors.New("harness: first event must have a nil previous_event_digest")
			}
		} else {
			if e.PreviousEventDigest == nil || priorDigest == nil || *e.PreviousEventDigest != *priorDigest {
				return fmt.Errorf("harness: event %d chain link does not match its predecessor", e.Sequence)
			}
		}
		want, err := eventDigest(*e)
		if err != nil {
			return err
		}
		if want != e.EventDigest {
			return fmt.Errorf("harness: event %d digest mismatch (content altered)", e.Sequence)
		}
		d := e.EventDigest
		priorDigest = &d
	}
	if sequence == 0 {
		return fmt.Errorf("harness: no events found for run %q", runID)
	}
	return nil
}

// Events returns the stored events for one run, in order.
func (s *EventStore) Events(runID string) []ExecutionEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []ExecutionEvent{}
	for _, e := range s.events {
		if e.RunID == runID {
			out = append(out, *e)
		}
	}
	return out
}

// All returns every stored event, in append order.
func (s *EventStore) All() []ExecutionEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ExecutionEvent, 0, len(s.events))
	for _, e := range s.events {
		out = append(out, *e)
	}
	return out
}
