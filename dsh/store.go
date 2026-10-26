package dsh

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/Luthiel/AutoFixer/agent/tools"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// recordedApproval is the approval decision recorded against one run.
type recordedApproval struct {
	approvalID       string
	decision         string // "approve" | "reject"
	approverActor    string
	approverIdentity string
	approvedAt       time.Time
	scopeDigest      string
	auditReference   string
}

// runRecord is one run's control-plane state. `mu` guards the harness run and
// every field derived from it — including a dispatch in flight, so readers
// never observe a half-applied transition. `ctlMu` guards only the dispatch
// bookkeeping a canceller needs before it may touch `mu`, which keeps
// cancellation able to interrupt a running tool.
type runRecord struct {
	mu  sync.Mutex
	ctl sync.Mutex

	run    *harness.Run
	events *harness.EventStore

	created     time.Time
	summary     string
	sourceRef   string
	issueID     string
	requestedBy string
	scope       requestedScope
	scopeDigest string
	repository  repositoryRef
	issue       issueRef

	approval       *recordedApproval
	approvalExpiry time.Time

	actionIDs map[string]bool

	runner   *sandbox.Runner
	registry *tools.Registry

	busy     bool
	cancel   context.CancelFunc
	execDone chan struct{}
}

type repositoryRef struct {
	RepositoryID string `json:"repository_id"`
	URL          string `json:"url"`
	BaseRef      string `json:"base_ref"`
	BaseSHA      string `json:"base_sha"`
}

type issueRef struct {
	Provider        string `json:"provider"`
	ExternalID      string `json:"external_id"`
	SourceReference string `json:"source_reference"`
}

type requestedBy struct {
	ActorID     string `json:"actor_id"`
	DisplayName string `json:"display_name"`
}

type taskRequest struct {
	Summary            string      `json:"summary"`
	AcceptanceCriteria []string    `json:"acceptance_criteria,omitempty"`
	RequestedBy        requestedBy `json:"requested_by"`
}

// proposedWork mirrors the contract's camel-free risk indicators onto the
// harness classification input. Anything not signalled stays false, which
// fails closed to elevated exactly as harness.AssessRisk requires.
type proposedWork struct {
	LocalizedReversibleChange bool `json:"localized_reversible_change"`
	BroadRefactor             bool `json:"broad_refactor"`
	DependencyChange          bool `json:"dependency_change"`
	DataShapeChange           bool `json:"data_shape_change"`
	Migration                 bool `json:"migration"`
	PermissionSensitive       bool `json:"permission_sensitive"`
	MaterialUncertainty       bool `json:"material_uncertainty"`
	RequestsSecretAccess      bool `json:"requests_secret_access"`
	WritesToMain              bool `json:"writes_to_main"`
	EditsCIWorkflows          bool `json:"edits_ci_workflows"`
	EditsGovernance           bool `json:"edits_governance"`
	PublishesPackage          bool `json:"publishes_package"`
	Deploys                   bool `json:"deploys"`
	AltersInfrastructure      bool `json:"alters_infrastructure"`
	UnapprovedNetwork         bool `json:"unapproved_network"`
}

func (p proposedWork) toHarness() harness.ProposedWork {
	return harness.ProposedWork{
		LocalizedReversibleChange: p.LocalizedReversibleChange,
		BroadRefactor:             p.BroadRefactor,
		DependencyChange:          p.DependencyChange,
		DataShapeChange:           p.DataShapeChange,
		Migration:                 p.Migration,
		PermissionSensitive:       p.PermissionSensitive,
		MaterialUncertainty:       p.MaterialUncertainty,
		RequestsSecretAccess:      p.RequestsSecretAccess,
		WritesToMain:              p.WritesToMain,
		EditsCIWorkflows:          p.EditsCIWorkflows,
		EditsGovernance:           p.EditsGovernance,
		PublishesPackage:          p.PublishesPackage,
		Deploys:                   p.Deploys,
		AltersInfrastructure:      p.AltersInfrastructure,
		UnapprovedNetwork:         p.UnapprovedNetwork,
	}
}

type requestedScope struct {
	PathHints           []string `json:"path_hints"`
	ToolCapabilities    []string `json:"tool_capabilities"`
	MaxWallClockSeconds int      `json:"max_wall_clock_seconds"`
}

type createRequest struct {
	TaskID         string         `json:"task_id"`
	Issue          issueRef       `json:"issue"`
	Repository     repositoryRef  `json:"repository"`
	Request        taskRequest    `json:"request"`
	ProposedWork   proposedWork   `json:"proposed_work"`
	RequestedScope requestedScope `json:"requested_scope"`
}

type idemEntry struct {
	fingerprint string
	created     time.Time
	// done closes once status and body are final; in-flight waiters block
	// on it before replaying.
	done   chan struct{}
	status int
	body   []byte
}

// idempotencyTTL bounds how long a completed key stays replayable. The M0
// contract promises "the evidence retention period" without fixing a
// number; a day is long enough for any sane client retry window and keeps
// the in-memory ledger from growing without bound.
const idempotencyTTL = 24 * time.Hour

// store holds every run and the idempotency ledger for one server process.
// It is in-memory by design: M1 has no persistence, and evidence lives in the
// append-only harness event store for the life of the process.
type store struct {
	mu           sync.Mutex
	runs         map[string]*runRecord
	activeByTask map[string]string
	idempotency  map[string]*idemEntry
}

func newStore() *store {
	return &store{
		runs:         map[string]*runRecord{},
		activeByTask: map[string]string{},
		idempotency:  map[string]*idemEntry{},
	}
}

func (s *store) put(rec *runRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runs[rec.run.RunID] = rec
}

func (s *store) get(runID string) (*runRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.runs[runID]
	return rec, ok
}

// claimTask reserves task_id for a new run while another run of the same
// task is still open. Terminal runs release the claim.
func (s *store) claimTask(taskID, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if active, ok := s.activeByTask[taskID]; ok && active != runID {
		return fmt.Errorf("task %q already has active run %q", taskID, active)
	}
	s.activeByTask[taskID] = runID
	return nil
}

// releaseTask drops the claim once the run reaches a terminal state. The
// caller must hold rec.mu, because terminality is read from the run.
func (s *store) releaseTask(rec *runRecord, terminal bool) {
	if !terminal {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeByTask[rec.run.TaskID] == rec.run.RunID {
		delete(s.activeByTask, rec.run.TaskID)
	}
}

// beginIdempotent atomically claims key for this request (owner=true), joins
// an in-flight execution of the same key (owner=false, entry still open), or
// reports a fingerprint conflict. Because the claim happens before the
// handler runs, two concurrent identical POSTs cannot both execute.
func (s *store) beginIdempotent(key, fingerprint string, now time.Time) (entry *idemEntry, owner, conflict bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.evictIdempotencyLocked(now)
	if existing, ok := s.idempotency[key]; ok {
		if existing.fingerprint != fingerprint {
			return nil, false, true
		}
		return existing, false, false
	}
	e := &idemEntry{
		fingerprint: fingerprint,
		created:     now,
		done:        make(chan struct{}),
	}
	s.idempotency[key] = e
	return e, true, false
}

// finishIdempotent publishes the outcome to waiters. Retryable outcomes are
// dropped from the ledger so a client's same-key retry re-executes instead of
// replaying a cached failure; concurrent waiters still receive the outcome.
func (s *store) finishIdempotent(key string, e *idemEntry, status int, body []byte, record bool) {
	e.status = status
	e.body = append([]byte{}, body...)
	s.mu.Lock()
	if !record && s.idempotency[key] == e {
		delete(s.idempotency, key)
	}
	s.mu.Unlock()
	close(e.done)
}

func (s *store) evictIdempotencyLocked(now time.Time) {
	for key, entry := range s.idempotency {
		select {
		case <-entry.done:
		default:
			continue // still in flight
		}
		if now.Sub(entry.created) > idempotencyTTL {
			delete(s.idempotency, key)
		}
	}
}

func (s *store) closeRuns() []error {
	s.mu.Lock()
	records := make([]*runRecord, 0, len(s.runs))
	for _, rec := range s.runs {
		records = append(records, rec)
	}
	s.mu.Unlock()

	var errs []error
	for _, rec := range records {
		rec.mu.Lock()
		runner := rec.runner
		rec.runner = nil
		rec.mu.Unlock()
		if runner != nil {
			if err := runner.Close(); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errs
}

// terminalState reports whether the run currently sits in a terminal state.
func (rec *runRecord) terminalState() harness.State {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if harness.IsTerminal(rec.run.State) {
		return rec.run.State
	}
	return ""
}

// latestAuditReference names the newest evidence event of the run. Lock
// ordering is always runRecord.mu before EventStore.mu, matching the
// harness, which appends while the caller holds the run lock.
func (rec *runRecord) latestAuditReference() string {
	rec.mu.Lock()
	runID := rec.run.RunID
	rec.mu.Unlock()
	events := rec.events.Events(runID)
	if len(events) == 0 {
		return ""
	}
	last := events[len(events)-1]
	return fmt.Sprintf("evidence://events/%s/%d", last.RunID, last.Sequence)
}

// closeRunnerLocked tears down the one-time workspace once the run can no
// longer dispatch. The caller must hold rec.mu.
func (rec *runRecord) closeRunnerLocked() error {
	if !harness.IsTerminal(rec.run.State) || rec.runner == nil {
		return nil
	}
	runner := rec.runner
	rec.runner = nil
	return runner.Close()
}

// dispatchSlot acquires the right to run one action, or reports why it cannot
// be taken. The cancel function is registered in the same critical section
// that sets the busy flag, so a canceller racing the start of a dispatch can
// never observe busy with a nil cancel and skip the interrupt. The busy flag
// is checked before waiting on `mu` so a second action during an execution
// fails fast with DSH_RUN_BUSY instead of blocking behind it.
func (rec *runRecord) dispatchSlot(cancel context.CancelFunc) (release func(), busy bool) {
	rec.ctl.Lock()
	if rec.busy {
		rec.ctl.Unlock()
		return nil, true
	}
	rec.busy = true
	rec.cancel = cancel
	done := make(chan struct{})
	rec.execDone = done
	rec.ctl.Unlock()

	return func() {
		rec.ctl.Lock()
		rec.busy = false
		rec.execDone = nil
		rec.cancel = nil
		close(done)
		rec.ctl.Unlock()
	}, false
}

// interruptDispatch cancels an in-flight tool and waits for it to settle, so
// the canceller can evidence the terminal state from the same chain the
// dispatch wrote. While the run is busy the cancel function is guaranteed
// non-nil: it is armed atomically with the dispatch slot.
func (rec *runRecord) interruptDispatch() {
	rec.ctl.Lock()
	cancel := rec.cancel
	done := rec.execDone
	rec.ctl.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(30 * time.Second):
		}
	}
}

func (rec *runRecord) hasDispatchInFlight() bool {
	rec.ctl.Lock()
	defer rec.ctl.Unlock()
	return rec.execDone != nil
}

// isBusy reports whether a dispatch currently owns the run, using only the
// control lock so the answer never waits on the run lock an execution holds.
func (rec *runRecord) isBusy() bool {
	rec.ctl.Lock()
	defer rec.ctl.Unlock()
	return rec.busy
}

// id returns the run id. It is immutable after creation.
func (rec *runRecord) id() string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.run.RunID
}
