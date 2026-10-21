// Package harness implements the ForgePilot remediation-run state machine,
// deny-by-default policy executor, dual-approval evaluation, and append-only
// audit evidence defined by docs/adr/0001-forgepilot-governance-and-threat-model.md
// and docs/contracts/task-evidence-contract-v1.md (contract 1.0.0). It
// performs no sandbox execution, GitHub writes, or network access itself.
package harness

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Decision codes recorded on run-level events.
const (
	DecisionGrantIssued = "grant_issued"

	DenyStateTransitionForbidden = "deny_state_transition_forbidden"
	DenyStateNotAwaitingReview   = "deny_state_not_awaiting_review"
	DenyAuditFailure             = "deny_audit_failure"

	StopCodeAuditFailure = "stop_audit_failure"
)

// RunConfig identifies one remediation run and the identities acting in it.
type RunConfig struct {
	TaskID            string
	RunID             string
	IssueID           string
	ActorIdentity     string
	ExecutionIdentity string
	RepositoryURL     string
	BaseSHA           string
}

// Run is one remediation attempt: current state, assessment, grant, PR
// binding, and its append-only evidence in the shared EventStore. It never
// performs repository or GitHub side effects itself.
type Run struct {
	TaskID            string
	RunID             string
	IssueID           string
	ActorIdentity     string
	ExecutionIdentity string
	RepositoryURL     string
	BaseSHA           string

	State      State
	Assessment RiskAssessment
	Grant      *CapabilityGrant
	Revoked    bool

	// grantReady marks that Approve has issued a fresh grant for the very
	// next transition, enforcing FP-01's "new grant only" rule for
	// stopped -> approved.
	grantReady bool
	Branch     *string
	HeadSHA    *string
	PrID       *string

	store *EventStore
	now   func() time.Time
}

// NewRun creates a run in `requested` with its risk assessment recorded.
// No event is written until the first state transition: the contract types
// every event as a state transition or a tool invocation, and creation is
// neither.
func NewRun(cfg RunConfig, assessment RiskAssessment, store *EventStore) (*Run, error) {
	if cfg.TaskID == "" || cfg.RunID == "" || cfg.IssueID == "" ||
		cfg.ActorIdentity == "" || cfg.ExecutionIdentity == "" ||
		cfg.RepositoryURL == "" || cfg.BaseSHA == "" {
		return nil, errors.New("harness: run configuration is missing a required field")
	}
	if store == nil {
		return nil, errors.New("harness: run requires an event store")
	}
	if assessment.TaskID != cfg.TaskID || assessment.RunID != cfg.RunID {
		return nil, errors.New("harness: risk assessment must match the run linkage")
	}
	switch assessment.RiskClass {
	case RiskLow, RiskElevated, RiskProhibited:
	default:
		return nil, errors.New("harness: risk assessment carries an unknown risk class")
	}
	return &Run{
		TaskID:            cfg.TaskID,
		RunID:             cfg.RunID,
		IssueID:           cfg.IssueID,
		ActorIdentity:     cfg.ActorIdentity,
		ExecutionIdentity: cfg.ExecutionIdentity,
		RepositoryURL:     cfg.RepositoryURL,
		BaseSHA:           cfg.BaseSHA,
		State:             StateRequested,
		Assessment:        assessment,
		store:             store,
		now:               time.Now,
	}, nil
}

// Approve issues the capability grant for this run and moves it to
// `approved`. Prohibited assessments are refused with ErrProhibitedRisk and
// no state change; the caller must reject the run instead.
func (r *Run) Approve(p GrantParams) error {
	if r.State != StateRequested && r.State != StateStopped {
		return fmt.Errorf("harness: cannot issue a grant from state %q", r.State)
	}
	grant, err := IssueGrant(r.Assessment, p)
	if err != nil {
		return err
	}
	r.Grant = &grant
	r.Revoked = false
	r.grantReady = true
	return r.Transition(StateApproved, DecisionGrantIssued)
}

// Transition moves the run per the ADR state table, appending evidence for
// both allowed and denied attempts. The run never advances without a stored
// event; an audit-write failure is returned and no state changes.
func (r *Run) Transition(to State, code string) error {
	defer func() { r.grantReady = false }()
	if !CanTransition(r.State, to) {
		return r.denyTransition(fmt.Errorf("harness: transition %q -> %q is not permitted by the ADR state table", r.State, to))
	}
	switch {
	case to == StateApproved && (!r.grantReady || r.Grant == nil):
		return r.denyTransition(errors.New("harness: approved requires a newly issued capability grant; stopped runs may reapprove only through Approve"))
	case to == StateRunning && r.Grant == nil:
		return r.denyTransition(errors.New("harness: running requires a recorded capability grant"))
	case to == StateAwaitingReview && (r.PrID == nil || r.HeadSHA == nil):
		return r.denyTransition(errors.New("harness: awaiting_review requires a PR bound to the current commit"))
	}

	ev := r.baseEvent(EventTypeStateTransition, r.State, to)
	if code != "" {
		c := code
		ev.DecisionOrStopCode = &c
	}
	if _, err := r.store.Append(ev); err != nil {
		return fmt.Errorf("harness: audit write failed, run left in %q: %w", r.State, err)
	}
	r.State = to
	switch to {
	case StateApproved, StateRunning:
		r.Revoked = false
	default:
		// Leaving the dispatchable window revokes the grant: cancellation,
		// expiry, timeout, stop, review, and every terminal state.
		r.Revoked = true
	}
	return nil
}

// denyTransition records the refused attempt (best effort) and returns the
// underlying reason unchanged when the record itself was stored.
func (r *Run) denyTransition(reason error) error {
	ev := r.baseEvent(EventTypeStateTransition, r.State, r.State)
	code := DenyStateTransitionForbidden
	ev.DecisionOrStopCode = &code
	if _, err := r.store.Append(ev); err != nil {
		return fmt.Errorf("harness: audit write failed while recording a denied transition: %w", err)
	}
	return reason
}

// SetPR binds the run to a PR opened from an autofixer/* branch.
func (r *Run) SetPR(branch, headSHA, prID string) error {
	if branch == "" || !strings.HasPrefix(branch, BranchPrefix) {
		return fmt.Errorf("harness: branch %q must start with %q", branch, BranchPrefix)
	}
	if headSHA == "" || prID == "" {
		return errors.New("harness: PR binding requires a head SHA and a PR id")
	}
	r.Branch = &branch
	r.HeadSHA = &headSHA
	r.PrID = &prID
	return nil
}

// EvaluateAndRecordAction applies the policy executor, records the decision
// as a tool-invocation event, and applies any resulting stop condition.
// The harness executes nothing itself; exit status and output digest stay
// null because no tool ran inside FP-03.
func (r *Run) EvaluateAndRecordAction(req ActionRequest) Decision {
	d := EvaluateAction(ActionContext{
		State: r.State, Grant: r.Grant, Revoked: r.Revoked, Now: r.now(),
	}, req)

	ev := r.baseEvent(EventTypeToolInvocation, r.State, r.State)
	ev.RequestedTool = &ToolRecord{
		Identity:  req.Tool,
		Arguments: append([]string{}, req.Arguments...),
	}
	ev.ActualTool = &ToolRecord{
		Identity:  req.Tool,
		Arguments: append([]string{}, req.Arguments...),
	}
	code := d.Code
	ev.DecisionOrStopCode = &code

	if _, err := r.store.Append(ev); err != nil {
		// Control failure: block further dispatch immediately. The stop event
		// itself cannot be trusted to a store that is failing.
		r.Revoked = true
		return Decision{Allowed: false, Code: DenyAuditFailure, StopCode: StopCodeAuditFailure}
	}

	if d.StopCode != "" && CanTransition(r.State, StateStopped) {
		// A stop that cannot be evidenced (or is refused by the state table)
		// is already carried by the decision event above.
		_ = r.Transition(StateStopped, d.StopCode)
	}
	return d
}

// RecordMergeEligibility evaluates an approval snapshot against this run's
// recorded head and appends the result. An eligible result does not advance
// the state by itself: the caller transitions to approved_for_merge
// separately, keeping GitHub's merge boundary outside the runner.
func (r *Run) RecordMergeEligibility(snap *ApprovalSnapshot) EligibilityResult {
	record := func(res EligibilityResult) EligibilityResult {
		ev := r.baseEvent(EventTypeStateTransition, r.State, r.State)
		code := res.Code
		ev.DecisionOrStopCode = &code
		if snap.EvidenceReference != "" {
			ev.ApprovalSnapshotRef = snap.EvidenceReference
		}
		if _, err := r.store.Append(ev); err != nil {
			return EligibilityResult{Eligible: false, Status: SnapshotStatusIneligible, Code: DenyAuditFailure}
		}
		return res
	}

	if snap.RunID != r.RunID || snap.TaskID != r.TaskID {
		return record(EligibilityResult{Eligible: false, Status: SnapshotStatusIneligible, Code: DenySnapshotRunMismatch})
	}
	if r.State != StateAwaitingReview {
		return record(EligibilityResult{Eligible: false, Status: SnapshotStatusIneligible, Code: DenyStateNotAwaitingReview})
	}
	return record(snap.Evaluate())
}

func (r *Run) approvalSnapshotRef() string {
	if r.HeadSHA != nil {
		return "evidence://approvals/" + r.RunID + "/" + *r.HeadSHA
	}
	return "evidence://approvals/" + r.RunID + "/no-pr"
}

func (r *Run) baseEvent(eventType string, prior, resulting State) ExecutionEvent {
	ev := ExecutionEvent{
		ContractVersion:     ContractVersion,
		EventType:           eventType,
		RunID:               r.RunID,
		TaskID:              r.TaskID,
		IssueID:             r.IssueID,
		PrID:                r.PrID,
		ActorIdentity:       r.ActorIdentity,
		ExecutionIdentity:   r.ExecutionIdentity,
		OccurredAt:          r.now(),
		PriorState:          prior,
		ResultingState:      resulting,
		RiskClass:           r.Assessment.RiskClass,
		PolicyVersion:       r.Assessment.PolicyVersion,
		RepositoryURL:       r.RepositoryURL,
		BaseSHA:             r.BaseSHA,
		Branch:              r.Branch,
		HeadSHA:             r.HeadSHA,
		PathScope:           []string{},
		NetworkScope:        []string{},
		ArtifactDigests:     []Digest{},
		ApprovalSnapshotRef: r.approvalSnapshotRef(),
		DigestAlgorithm:     DigestAlgorithmSHA256,
	}
	if r.Grant != nil {
		ev.CapabilityGrantVersion = r.Grant.CapabilityGrantVersion
		if r.Grant.PermittedPaths != nil {
			ev.PathScope = append([]string{}, r.Grant.PermittedPaths...)
		}
		if r.Grant.NetworkDestinations != nil {
			ev.NetworkScope = append([]string{}, r.Grant.NetworkDestinations...)
		}
	}
	return ev
}
