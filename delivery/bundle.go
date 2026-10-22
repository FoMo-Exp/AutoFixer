package delivery

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
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
	ArtifactReferences []string                 `json:"artifact_references"`
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
	if err := validateRiskAssessment(b.RiskAssessment, b.TaskInput.TaskID, b.PatchReport.RunID); err != nil {
		return err
	}
	if err := b.PatchReport.Validate(); err != nil {
		return err
	}
	if b.ApprovalSnapshot.ContractVersion != harness.ContractVersion || b.ApprovalSnapshot.TaskID != b.PatchReport.TaskID || b.ApprovalSnapshot.RunID != b.PatchReport.RunID {
		return errors.New("delivery: evidence bundle approval snapshot does not match")
	}
	if b.ApprovalSnapshot.ObservedAt.IsZero() || strings.TrimSpace(b.ApprovalSnapshot.EvidenceReference) == "" {
		return errors.New("delivery: evidence bundle approval snapshot is incomplete")
	}
	if err := validateApprovalSnapshotHeadBindings(b.ApprovalSnapshot, b.PatchReport.PatchStatus, dereference(b.PatchReport.HeadSHA)); err != nil {
		return err
	}
	if b.CapabilityGrant != nil && (b.CapabilityGrant.ContractVersion != harness.ContractVersion ||
		b.CapabilityGrant.TaskID != b.PatchReport.TaskID || b.CapabilityGrant.RunID != b.PatchReport.RunID ||
		b.CapabilityGrant.RepositoryURL != b.TaskInput.Repository.URL || b.CapabilityGrant.BaseSHA != b.TaskInput.Repository.BaseSHA) {
		return errors.New("delivery: evidence bundle capability grant does not match")
	}
	if len(b.ExecutionEvents) == 0 || len(b.EvidenceReferences) == 0 {
		return errors.New("delivery: evidence bundle requires events and evidence references")
	}
	revisionBound := false
	for i, event := range b.ExecutionEvents {
		if event.ContractVersion != harness.ContractVersion || event.EventID == "" || event.Sequence != i+1 ||
			(event.EventType != harness.EventTypeStateTransition && event.EventType != harness.EventTypeToolInvocation) ||
			event.TaskID != b.TaskInput.TaskID || event.IssueID != b.TaskInput.IssueID || event.RunID != b.PatchReport.RunID ||
			event.RepositoryURL != b.TaskInput.Repository.URL || event.BaseSHA != b.TaskInput.Repository.BaseSHA ||
			event.ActorIdentity == "" || event.ExecutionIdentity == "" || event.OccurredAt.IsZero() ||
			event.PolicyVersion == "" || event.ApprovalSnapshotRef == "" {
			return fmt.Errorf("delivery: event %d is not linked to the evidence bundle", i)
		}
		if event.EventDigest == "" || event.DigestAlgorithm != harness.DigestAlgorithmSHA256 {
			return fmt.Errorf("delivery: event %d has an invalid digest", i)
		}
		if i == 0 {
			if event.PreviousEventDigest != nil {
				return errors.New("delivery: first evidence event must have a null previous digest")
			}
		} else if event.PreviousEventDigest == nil || *event.PreviousEventDigest != b.ExecutionEvents[i-1].EventDigest {
			return fmt.Errorf("delivery: event %d chain link does not match its predecessor", i)
		}
		bound, err := validateEventRevision(event, b.PatchReport, revisionBound)
		if err != nil {
			return fmt.Errorf("delivery: event %d is not bound to the patch revision: %w", i, err)
		}
		revisionBound = revisionBound || bound
	}
	if b.PatchReport.PatchStatus != PatchNotCreated && !revisionBound {
		return errors.New("delivery: created-patch evidence requires a revision-bound event")
	}
	for _, reportReference := range b.PatchReport.EvidenceReferences {
		if !b.referenceResolves(reportReference) {
			return fmt.Errorf("delivery: patch report evidence reference %q does not resolve in the bundle", reportReference)
		}
	}
	for _, reportValidation := range b.PatchReport.Validation {
		if !eventReferenceResolves(reportValidation.EventReference, b.ExecutionEvents) {
			return fmt.Errorf("delivery: validation event reference %q does not resolve in the bundle", reportValidation.EventReference)
		}
	}
	for _, reference := range b.EvidenceReferences {
		if !b.referenceResolves(reference) {
			return fmt.Errorf("delivery: evidence reference %q does not resolve in the bundle", reference)
		}
	}
	if b.PatchReport.PatchStatus == PatchNotCreated {
		terminalEvent := b.ExecutionEvents[len(b.ExecutionEvents)-1]
		terminalReference := false
		for _, reference := range b.PatchReport.EvidenceReferences {
			if event, ok := resolveEventReference(reference, b.ExecutionEvents); ok {
				if event.Sequence != terminalEvent.Sequence {
					return fmt.Errorf("delivery: not_created evidence reference %q is not bound to the terminal event", reference)
				}
				terminalReference = true
			}
		}
		if !terminalReference {
			return errors.New("delivery: not_created patch report requires a terminal event reference")
		}
	}
	return nil
}

// validateApprovalSnapshotHeadBindings enforces the contract's nullability
// rule: once a patch revision exists, every observed approval sub-record must
// be tied to that exact head. A no-patch outcome explicitly keeps all such
// head fields null.
func validateApprovalSnapshotHeadBindings(snapshot harness.ApprovalSnapshot, status PatchStatus, head string) error {
	if status == PatchNotCreated {
		if snapshot.HeadSHA != nil || snapshot.QA.HeadSHA != nil || snapshot.ReviewDiscussions.HeadSHA != nil || snapshot.ApprovalQuorum.HeadSHA != nil {
			return errors.New("delivery: not_created approval snapshot must have null head bindings")
		}
		for i, check := range snapshot.RequiredChecks {
			if check.HeadSHA != nil {
				return fmt.Errorf("delivery: not_created required check %d must have a null head binding", i)
			}
		}
		for i, approval := range snapshot.ApprovalQuorum.Approvals {
			if approval.HeadSHA != nil {
				return fmt.Errorf("delivery: not_created approval %d must have a null head binding", i)
			}
		}
		return nil
	}
	if head == "" || snapshot.HeadSHA == nil || *snapshot.HeadSHA != head {
		return errors.New("delivery: approval snapshot is not bound to the patch head")
	}
	if snapshot.QA.HeadSHA == nil || *snapshot.QA.HeadSHA != head {
		return errors.New("delivery: QA observation is not bound to the patch head")
	}
	if snapshot.ReviewDiscussions.HeadSHA == nil || *snapshot.ReviewDiscussions.HeadSHA != head {
		return errors.New("delivery: review discussion observation is not bound to the patch head")
	}
	if snapshot.ApprovalQuorum.HeadSHA == nil || *snapshot.ApprovalQuorum.HeadSHA != head {
		return errors.New("delivery: approval quorum observation is not bound to the patch head")
	}
	for i, check := range snapshot.RequiredChecks {
		if check.HeadSHA == nil || *check.HeadSHA != head {
			return fmt.Errorf("delivery: required check %d is not bound to the patch head", i)
		}
	}
	for i, approval := range snapshot.ApprovalQuorum.Approvals {
		if approval.HeadSHA == nil || *approval.HeadSHA != head {
			return fmt.Errorf("delivery: approval %d is not bound to the patch head", i)
		}
	}
	return nil
}

func validateEventRevision(event harness.ExecutionEvent, report PatchReport, revisionBound bool) (bool, error) {
	if report.PatchStatus == PatchNotCreated {
		if event.Branch != nil || event.HeadSHA != nil {
			return false, errors.New("not_created evidence must have null branch and head")
		}
		return false, nil
	}
	if event.Branch == nil && event.HeadSHA == nil {
		if revisionBound {
			return false, errors.New("evidence lost its branch and head after the patch revision was bound")
		}
		return false, nil
	}
	if event.Branch == nil || event.HeadSHA == nil {
		return false, errors.New("evidence must provide both branch and head when a revision is bound")
	}
	if report.Branch == nil || report.HeadSHA == nil {
		return false, errors.New("created-patch report is missing branch and head")
	}
	if *event.Branch != *report.Branch || *event.HeadSHA != *report.HeadSHA {
		return false, fmt.Errorf("event revision %s/%s differs from report %s/%s", *event.Branch, *event.HeadSHA, *report.Branch, *report.HeadSHA)
	}
	return true, nil
}

func eventReferenceResolves(reference string, events []harness.ExecutionEvent) bool {
	_, ok := resolveEventReference(reference, events)
	return ok
}

func resolveEventReference(reference string, events []harness.ExecutionEvent) (harness.ExecutionEvent, bool) {
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		if reference == event.EventID || eventReferenceMatches(reference, event) {
			return event, true
		}
	}
	return harness.ExecutionEvent{}, false
}

func eventReferenceMatches(reference string, event harness.ExecutionEvent) bool {
	if reference == "evidence://events/"+event.RunID {
		return true
	}
	prefix := "evidence://events/" + event.RunID + "/"
	if !strings.HasPrefix(reference, prefix) {
		return false
	}
	selector := strings.TrimPrefix(reference, prefix)
	return selector == event.EventID || selector == strconv.Itoa(event.Sequence)
}

func (b EvidenceBundle) referenceResolves(reference string) bool {
	if strings.TrimSpace(reference) == "" {
		return false
	}
	if eventReferenceResolves(reference, b.ExecutionEvents) {
		return true
	}
	if reference == b.RiskAssessment.RationaleReference || reference == b.ApprovalSnapshot.EvidenceReference {
		return true
	}
	if b.CapabilityGrant != nil && b.CapabilityGrant.ApprovalReference != nil && reference == b.CapabilityGrant.ApprovalReference.Reference {
		return true
	}
	for _, artifact := range b.ArtifactReferences {
		if reference == artifact {
			return true
		}
	}
	return false
}
