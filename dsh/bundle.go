package dsh

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
)

// buildPatchReport binds the local no-patch outcome to the run's terminal
// event. The control plane performs no repository or GitHub writes in M1, so
// every terminal run reports `not_created` with the evidence reference of the
// event that ended it.
func buildPatchReport(rec *runRecord, events []harness.ExecutionEvent, now time.Time) (delivery.PatchReport, error) {
	if len(events) == 0 {
		return delivery.PatchReport{}, fmt.Errorf("dsh: run has no evidence events")
	}
	terminal := events[len(events)-1]
	terminalRef := fmt.Sprintf("evidence://events/%s/%d", terminal.RunID, terminal.Sequence)
	return delivery.NewPatchReport(delivery.PatchReport{
		TaskID:        rec.run.TaskID,
		RunID:         rec.run.RunID,
		IssuedAt:      now,
		RepositoryURL: rec.run.RepositoryURL,
		BaseSHA:       rec.run.BaseSHA,
		PatchStatus:   delivery.PatchNotCreated,
		ChangeSummary: rec.summary,
		EvidenceReferences: []string{
			terminalRef,
		},
	})
}

// buildApprovalSnapshot records that no pull request was observed, which is
// the only truthful snapshot for a run the local control plane never bound
// to a revision.
func buildApprovalSnapshot(run *harness.Run, now time.Time) harness.ApprovalSnapshot {
	snapshot := harness.ApprovalSnapshot{
		ContractVersion: harness.ContractVersion,
		TaskID:          run.TaskID,
		RunID:           run.RunID,
		ObservedAt:      now,
		QA:              harness.QAObservation{Status: "not_requested"},
		ReviewDiscussions: harness.DiscussionsObservation{
			Status:     "not_applicable",
			ObservedAt: now,
		},
		ApprovalQuorum:      harness.QuorumObservation{Status: "not_requested"},
		EvidenceReference:   fmt.Sprintf("evidence://approvals/%s/no-pr", run.RunID),
		MergeQueueAvailable: false,
	}
	snapshot.Evaluate()
	return snapshot
}

// buildEvidenceBundle assembles the terminal task/risk/grant/events/patch/
// approval bundle the contract's evidence endpoint returns. It validates
// through delivery.EvidenceBundle, so a bundle the control plane hands out is
// the same record the delivery boundary checks.
func buildEvidenceBundle(rec *runRecord, events []harness.ExecutionEvent, now time.Time) (*delivery.EvidenceBundle, error) {
	if len(events) == 0 {
		return nil, fmt.Errorf("dsh: run has no evidence events")
	}
	patchReport, err := buildPatchReport(rec, events, now)
	if err != nil {
		return nil, err
	}
	snapshot := buildApprovalSnapshot(rec.run, now)

	var grant *harness.CapabilityGrant
	if rec.run.Grant != nil {
		copied := *rec.run.Grant
		copied.PermittedPaths = append([]string{}, rec.run.Grant.PermittedPaths...)
		copied.PermittedTools = append([]harness.PermittedTool{}, rec.run.Grant.PermittedTools...)
		copied.NetworkDestinations = append([]string{}, rec.run.Grant.NetworkDestinations...)
		grant = &copied
	}

	bundle := &delivery.EvidenceBundle{
		ContractVersion: harness.ContractVersion,
		TaskInput: delivery.TaskInput{
			ContractVersion: harness.ContractVersion,
			TaskID:          rec.run.TaskID,
			IssueID:         rec.run.IssueID,
			RequestedAt:     rec.created,
			Repository: delivery.TaskRepository{
				URL:     rec.run.RepositoryURL,
				BaseSHA: rec.run.BaseSHA,
			},
			RequestedWork: delivery.RequestedWork{
				Summary:         rec.summary,
				SourceReference: rec.sourceRef,
			},
		},
		RiskAssessment:   rec.run.Assessment,
		CapabilityGrant:  grant,
		ExecutionEvents:  events,
		PatchReport:      patchReport,
		ApprovalSnapshot: snapshot,
		EvidenceReferences: []string{
			"evidence://events/" + rec.run.RunID,
			rec.run.Assessment.RationaleReference,
			snapshot.EvidenceReference,
		},
	}
	if err := bundle.Validate(); err != nil {
		return nil, err
	}
	return bundle, nil
}

type logEntry struct {
	Sequence       int             `json:"sequence"`
	EventID        string          `json:"event_id"`
	EventType      string          `json:"event_type"`
	OccurredAt     time.Time       `json:"occurred_at"`
	PriorState     harness.State   `json:"prior_state"`
	ResultingState harness.State   `json:"resulting_state"`
	ToolIdentity   string          `json:"tool_identity"`
	Arguments      []string        `json:"arguments"`
	ExitStatus     *int            `json:"exit_status"`
	OutputDigest   *harness.Digest `json:"output_digest"`
	DecisionOrStop *string         `json:"decision_or_stop_code"`
	EventDigest    string          `json:"event_digest"`
}

type executionLog struct {
	RunID   string     `json:"run_id"`
	Entries []logEntry `json:"entries"`
}

// executionLogFrom renders the redacted execution log artifact: the same
// digested events, projected for a reviewer. It never carries raw output,
// environment, or absolute workspace paths.
func executionLogFrom(events []harness.ExecutionEvent) executionLog {
	log := executionLog{Entries: []logEntry{}}
	for _, event := range events {
		entry := logEntry{
			Sequence:       event.Sequence,
			EventID:        event.EventID,
			EventType:      event.EventType,
			OccurredAt:     event.OccurredAt,
			PriorState:     event.PriorState,
			ResultingState: event.ResultingState,
			ExitStatus:     event.ExitStatus,
			OutputDigest:   event.OutputDigest,
			DecisionOrStop: event.DecisionOrStopCode,
			EventDigest:    event.EventDigest,
			Arguments:      []string{},
		}
		if log.RunID == "" {
			log.RunID = event.RunID
		}
		if event.RequestedTool != nil {
			entry.ToolIdentity = event.RequestedTool.Identity
			entry.Arguments = append([]string{}, event.RequestedTool.Arguments...)
		}
		log.Entries = append(log.Entries, entry)
	}
	return log
}

func marshalCanonical(value any) ([]byte, error) {
	return json.Marshal(value)
}
