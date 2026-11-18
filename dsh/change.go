package dsh

import (
	"context"
	"fmt"
	"strings"

	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// Prepared-change capture (DAT-258).
//
// A local preparation run may edit its isolated checkout through the
// structured `workspace.patch` gate and validate it through registered
// `test.run` profiles. Once the run stops, the control plane freezes that
// change into one exact revision: a deterministic local commit object, its
// unified diff, changed paths, and the validation evidence of the same
// revision.
//
// The frozen revision is what a pre-PR candidate is bound to. Nothing here
// writes to a provider: capture stages the working tree, writes a tree object,
// and creates a dangling commit object locally. No branch, ref, remote, or PR
// exists before a candidate-bound human approval.

// preparedBranch is the prospective `autofixer/*` branch name of one frozen
// revision. It is a name only: capture never creates the branch.
func preparedBranch(taskID, headSHA string) (string, error) {
	short := headSHA
	if len(short) > 7 {
		short = short[:7]
	}
	branch := delivery.BranchPrefix + strings.ToLower(taskID) + "-" + short
	if err := delivery.ValidateTaskBranch(taskID, branch, headSHA); err != nil {
		return "", fmt.Errorf("dsh: prepared revision cannot form a delivery branch: %w", err)
	}
	return branch, nil
}

// validationEvidence projects the run's completed test executions as the
// patch report's validation attempts. Only completion events count: an
// intent that never ran, a denied dispatch, or a refused profile has no exit
// status and is not validation evidence.
//
// When a captured tree is supplied, only attempts that ran against that exact
// tree count. An earlier result belongs to an earlier revision and cannot
// validate the frozen one.
func validationEvidence(rec *runRecord, events []harness.ExecutionEvent, treeSHA string) []delivery.ValidationEvidence {
	out := []delivery.ValidationEvidence{}
	for _, event := range events {
		if event.RequestedTool == nil || event.RequestedTool.Identity != "test.run" {
			continue
		}
		if event.ExitStatus == nil || event.OutputDigest == nil {
			continue
		}
		if treeSHA != "" && rec.testTrees[event.Sequence] != treeSHA {
			continue
		}
		arguments := append([]string{}, event.RequestedTool.Arguments...)
		tool := "test.run"
		if len(arguments) > 0 && arguments[0] != "" {
			// The first evidence argument is the registered profile identity
			// the check belongs to (`go.test`, `node.test`).
			tool = arguments[0]
		}
		status := *event.ExitStatus
		out = append(out, delivery.ValidationEvidence{
			Tool:         tool,
			Arguments:    arguments,
			ExitStatus:   &status,
			OutputDigest: *event.OutputDigest,
			EventReference: fmt.Sprintf(
				"evidence://events/%s/%d", event.RunID, event.Sequence,
			),
		})
	}
	return out
}

// recordTestTreeLocked pins the working tree a test execution ran against.
// The caller holds rec.mu and has just dispatched a test profile; the
// completion event is the newest event in the run's chain, and the
// execution domain has already been torn down, so no other process can write
// the workspace between the test and this measurement.
func (rec *runRecord) recordTestTreeLocked(executor *sandbox.Runner, tool string, exitStatus *int) {
	if tool != "test.run" || exitStatus == nil {
		return
	}
	treeSHA, err := executor.CurrentTreeSHA(context.Background())
	if err != nil || treeSHA == "" {
		// Unmeasurable validation is not evidence for any revision. The
		// completion event stays in the chain; it simply never matches a
		// captured tree.
		return
	}
	events := rec.events.Events(rec.run.RunID)
	if len(events) == 0 {
		return
	}
	if rec.testTrees == nil {
		rec.testTrees = map[int]string{}
	}
	rec.testTrees[events[len(events)-1].Sequence] = treeSHA
}

// captureChangeLocked freezes the run's prepared change once. The caller holds
// rec.mu. It retains the diff on the run record (the workspace is deleted
// after a terminal run) and, when the run also has a completed validation
// attempt against the exact captured tree, binds the revision into the
// evidence chain so the bundle can prove which revision the results belong to.
func (rec *runRecord) captureChangeLocked() error {
	if rec.changeCaptured {
		return rec.changeErr
	}
	rec.changeCaptured = true
	if rec.runner == nil || rec.runner.Closed() {
		return nil
	}
	// Only a completed preparation (`stopped`) produces a reviewable
	// candidate. Cancellation, timeout, rejection, and failure are truthful
	// outcomes with nothing to freeze: their terminal state is the answer.
	if rec.run.State != harness.StateStopped {
		return nil
	}
	change, err := rec.runner.CaptureChange(context.Background())
	if err != nil {
		rec.changeErr = err
		return err
	}
	if change == nil {
		return nil
	}
	rec.change = change
	// Without a completed validation attempt against this exact tree the
	// change is not a reviewable patch: the evidence contract has no
	// "prepared but unvalidated" patch status, so no revision is bound and no
	// candidate can be frozen from it.
	events := rec.events.Events(rec.run.RunID)
	if len(validationEvidence(rec, events, change.TreeSHA)) == 0 {
		return nil
	}
	branch, err := preparedBranch(rec.run.TaskID, change.HeadSHA)
	if err != nil {
		rec.changeErr = err
		return err
	}
	if err := rec.run.BindPreparedRevision(branch, change.HeadSHA); err != nil {
		rec.changeErr = err
		return err
	}
	rec.branch = branch
	rec.prepared = true
	return nil
}

// prepareChangeLocked captures the change if the run may already be read as
// finalized. It is a no-op for a run that never materialized a workspace.
func (rec *runRecord) prepareChangeLocked() {
	if rec.runner == nil || rec.runner.Closed() {
		return
	}
	if !bundleFinalized(rec.run.State) {
		return
	}
	_ = rec.captureChangeLocked()
}

// frozenChange is the retained, immutable change of one run. Nil means the
// run produced no reviewable change at all.
func (rec *runRecord) frozenChange() *sandbox.ProposedChange {
	return rec.change
}

// changeArtifact is the reviewable diff artifact. The digest is the sha256 of
// exactly Diff, so a reader recomputes it instead of trusting the envelope.
type changeArtifact struct {
	BaseSHA      string   `json:"base_sha"`
	HeadSHA      string   `json:"head_sha"`
	TreeSHA      string   `json:"tree_sha"`
	DiffDigest   string   `json:"diff_digest"`
	ChangedPaths []string `json:"changed_paths"`
	Insertions   int      `json:"insertions"`
	Deletions    int      `json:"deletions"`
	Diff         string   `json:"diff"`
}

func buildChangeArtifact(change *sandbox.ProposedChange) changeArtifact {
	return changeArtifact{
		BaseSHA:      change.BaseSHA,
		HeadSHA:      change.HeadSHA,
		TreeSHA:      change.TreeSHA,
		DiffDigest:   change.DiffDigest,
		ChangedPaths: append([]string{}, change.ChangedPaths...),
		Insertions:   change.Insertions,
		Deletions:    change.Deletions,
		Diff:         change.Diff,
	}
}

// validationArtifact is the per-attempt validation record for one frozen
// revision: every attempt, its exit status, and the digest of its redacted
// output. The Node product layer binds a passing attempt to a retained
// test-report artifact by this event reference and digest.
type validationArtifact struct {
	RunID      string                        `json:"run_id"`
	State      harness.State                 `json:"state"`
	BaseSHA    string                        `json:"base_sha"`
	HeadSHA    *string                       `json:"head_sha"`
	Branch     *string                       `json:"branch"`
	Validation []delivery.ValidationEvidence `json:"validation"`
}

func buildValidationArtifact(rec *runRecord, events []harness.ExecutionEvent) validationArtifact {
	var head, branch *string
	if rec.change != nil && rec.prepared {
		head = stringPointer(rec.change.HeadSHA)
		branch = stringPointer(rec.branch)
	}
	var baseSHA string
	if rec.change != nil {
		baseSHA = rec.change.BaseSHA
	} else {
		baseSHA = rec.run.BaseSHA
	}
	validation := validationEvidence(rec, events, "")
	if rec.prepared && rec.change != nil {
		validation = validationEvidence(rec, events, rec.change.TreeSHA)
	}
	if validation == nil {
		validation = []delivery.ValidationEvidence{}
	}
	return validationArtifact{
		RunID:      rec.run.RunID,
		State:      rec.run.State,
		BaseSHA:    baseSHA,
		HeadSHA:    head,
		Branch:     branch,
		Validation: validation,
	}
}

// candidateArtifact is the control plane's immutable candidate manifest: the
// exact base/tree/head identity, the commit identity behind that head, the diff
// digest, the summary, and the validation attempts of that same revision. It
// creates nothing; the Node delivery layer retains it as the run's `candidate`
// artifact when it freezes a product-level candidate.
type candidateArtifact struct {
	RunID              string                        `json:"run_id"`
	TaskID             string                        `json:"task_id"`
	IssueID            string                        `json:"issue_id"`
	RepositoryURL      string                        `json:"repository_url"`
	BaseSHA            string                        `json:"base_sha"`
	TreeSHA            string                        `json:"tree_sha"`
	HeadSHA            string                        `json:"head_sha"`
	Commit             sandbox.CommitIdentity        `json:"commit"`
	Branch             string                        `json:"branch"`
	DiffDigest         string                        `json:"diff_digest"`
	ChangedPaths       []string                      `json:"changed_paths"`
	Insertions         int                           `json:"insertions"`
	Deletions          int                           `json:"deletions"`
	Summary            string                        `json:"summary"`
	RiskClass          harness.RiskClass             `json:"risk_class"`
	Validation         []delivery.ValidationEvidence `json:"validation"`
	EvidenceReferences []string                      `json:"evidence_references"`
}

func buildCandidateArtifact(rec *runRecord, events []harness.ExecutionEvent) candidateArtifact {
	change := rec.change
	validation := validationEvidence(rec, events, change.TreeSHA)
	// Every reference names an evidenced event of this run exactly, so a
	// reader resolves it instead of trusting an unsequenced pseudo-reference.
	var references []string
	if len(events) > 0 {
		terminal := events[len(events)-1]
		references = append(references,
			fmt.Sprintf("evidence://events/%s/%d", terminal.RunID, terminal.Sequence))
	}
	for _, entry := range validation {
		references = append(references, entry.EventReference)
	}
	return candidateArtifact{
		RunID:              rec.run.RunID,
		TaskID:             rec.run.TaskID,
		IssueID:            rec.run.IssueID,
		RepositoryURL:      rec.run.RepositoryURL,
		BaseSHA:            change.BaseSHA,
		TreeSHA:            change.TreeSHA,
		HeadSHA:            change.HeadSHA,
		Commit:             change.Commit,
		Branch:             rec.branch,
		DiffDigest:         change.DiffDigest,
		ChangedPaths:       append([]string{}, change.ChangedPaths...),
		Insertions:         change.Insertions,
		Deletions:          change.Deletions,
		Summary:            rec.summary,
		RiskClass:          rec.run.Assessment.RiskClass,
		Validation:         validation,
		EvidenceReferences: references,
	}
}

func stringPointer(value string) *string {
	copied := value
	return &copied
}
