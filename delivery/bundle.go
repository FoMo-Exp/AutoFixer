package delivery

import (
	"errors"
	"fmt"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

// TaskInput is the immutable request record retained with a complete
// evidence bundle. It intentionally contains references and summaries, never
// credentials or raw tool output.
type TaskInput struct {
	ContractVersion string         `json:"contract_version"`
	TaskID          string         `json:"task_id"`
	IssueID         string         `json:"issue_id"`
	RequestedAt     time.Time      `json:"requested_at"`
	Repository      TaskRepository `json:"repository"`
	RequestedWork   RequestedWork  `json:"requested_work"`
}

type TaskRepository struct {
	URL     string `json:"url"`
	BaseSHA string `json:"base_sha"`
}

type RequestedWork struct {
	Summary         string `json:"summary"`
	SourceReference string `json:"source_reference"`
}

// EvidenceBundle groups the records needed to hand a terminal run to a
// reviewer or an access-controlled evidence store. It does not persist raw
// event output or grant credentials.
type EvidenceBundle struct {
	ContractVersion    string                   `json:"contract_version"`
	TaskInput          TaskInput                `json:"task_input"`
	RiskAssessment     harness.RiskAssessment   `json:"risk_assessment"`
	CapabilityGrant    *harness.CapabilityGrant `json:"capability_grant"`
	ExecutionEvents    []harness.ExecutionEvent `json:"execution_events"`
	PatchReport        PatchReport              `json:"patch_report"`
	ApprovalSnapshot   harness.ApprovalSnapshot `json:"approval_snapshot"`
	EvidenceReferences []string                 `json:"evidence_references"`
}

// Validate checks cross-record linkage and the explicit null/empty rules that
// matter at the delivery boundary. The complete event chain is verified by
// harness.EventStore before a bundle is assembled; this type only receives
// immutable event copies and checks their linkage.
func (b EvidenceBundle) Validate() error {
	if b.ContractVersion != harness.ContractVersion || b.TaskInput.ContractVersion != harness.ContractVersion {
		return errors.New("delivery: evidence bundle has an unsupported contract version")
	}
	if b.TaskInput.TaskID == "" || b.TaskInput.IssueID == "" || b.TaskInput.RequestedAt.IsZero() ||
		b.TaskInput.Repository.URL == "" || b.TaskInput.Repository.BaseSHA == "" ||
		b.TaskInput.RequestedWork.Summary == "" || b.TaskInput.RequestedWork.SourceReference == "" {
		return errors.New("delivery: task input is incomplete")
	}
	if b.RiskAssessment.ContractVersion != harness.ContractVersion || b.RiskAssessment.TaskID != b.TaskInput.TaskID ||
		b.RiskAssessment.RunID != b.PatchReport.RunID || b.PatchReport.TaskID != b.TaskInput.TaskID ||
		b.PatchReport.RepositoryURL != b.TaskInput.Repository.URL || b.PatchReport.BaseSHA != b.TaskInput.Repository.BaseSHA {
		return errors.New("delivery: evidence bundle task linkage does not match")
	}
	if err := b.PatchReport.Validate(); err != nil {
		return err
	}
	if b.ApprovalSnapshot.ContractVersion != harness.ContractVersion || b.ApprovalSnapshot.TaskID != b.PatchReport.TaskID || b.ApprovalSnapshot.RunID != b.PatchReport.RunID {
		return errors.New("delivery: evidence bundle approval snapshot does not match")
	}
	if b.PatchReport.PatchStatus != PatchNotCreated {
		if b.ApprovalSnapshot.HeadSHA == nil || b.PatchReport.HeadSHA == nil || *b.ApprovalSnapshot.HeadSHA != *b.PatchReport.HeadSHA {
			return errors.New("delivery: evidence bundle approval snapshot is not bound to the patch head")
		}
	}
	if b.CapabilityGrant != nil && (b.CapabilityGrant.ContractVersion != harness.ContractVersion ||
		b.CapabilityGrant.TaskID != b.PatchReport.TaskID || b.CapabilityGrant.RunID != b.PatchReport.RunID ||
		b.CapabilityGrant.RepositoryURL != b.TaskInput.Repository.URL || b.CapabilityGrant.BaseSHA != b.TaskInput.Repository.BaseSHA) {
		return errors.New("delivery: evidence bundle capability grant does not match")
	}
	if len(b.ExecutionEvents) == 0 || len(b.EvidenceReferences) == 0 {
		return errors.New("delivery: evidence bundle requires events and evidence references")
	}
	for i, event := range b.ExecutionEvents {
		if event.ContractVersion != harness.ContractVersion || event.TaskID != b.TaskInput.TaskID || event.IssueID != b.TaskInput.IssueID || event.RunID != b.PatchReport.RunID {
			return fmt.Errorf("delivery: event %d is not linked to the evidence bundle", i)
		}
	}
	return nil
}
