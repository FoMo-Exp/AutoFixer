package harness

import "time"

// Snapshot status values for an approval snapshot.
const (
	SnapshotStatusEligible     = "eligible"
	SnapshotStatusIneligible   = "ineligible"
	SnapshotStatusNotRequested = "not_requested"
)

// Evaluation codes for the GitHub merge boundary.
const (
	AllowMergeQueueEligible = "allow_merge_queue_eligible"

	DenyApprovalNoHead                = "deny_approval_no_head"
	DenyApprovalQANotPassed           = "deny_approval_qa_not_passed"
	DenyApprovalQAStaleHead           = "deny_approval_qa_stale_head"
	DenyApprovalChecksMissing         = "deny_approval_checks_missing"
	DenyApprovalChecksNotPassed       = "deny_approval_checks_not_passed"
	DenyApprovalChecksStaleHead       = "deny_approval_checks_stale_head"
	DenyApprovalDiscussionsUnresolved = "deny_approval_discussions_unresolved"
	DenyApprovalDiscussionsStaleHead  = "deny_approval_discussions_stale_head"
	DenyApprovalQuorumIncomplete      = "deny_approval_quorum_incomplete"
	DenyApprovalQuorumStaleHead       = "deny_approval_quorum_stale_head"
	DenySnapshotRunMismatch           = "deny_snapshot_run_mismatch"
)

// RequiredApprovers is the approval quorum from CONTEXT.md: simultaneous
// approvals by both named owners on the current pull-request head.
var RequiredApprovers = []string{"Luthiel", "Ludwig-Planck"}

// QAObservation records the QA result for one head.
type QAObservation struct {
	Status     string     `json:"status"`
	HeadSHA    *string    `json:"head_sha"`
	Identity   *string    `json:"identity"`
	ApprovedAt *time.Time `json:"approved_at"`
}

// CheckObservation records one required GitHub check for one head.
type CheckObservation struct {
	Name       string    `json:"name"`
	Status     string    `json:"status"`
	HeadSHA    *string   `json:"head_sha"`
	ObservedAt time.Time `json:"observed_at"`
}

// DiscussionsObservation records whether review discussions are resolved.
type DiscussionsObservation struct {
	Status     string    `json:"status"`
	HeadSHA    *string   `json:"head_sha"`
	ObservedAt time.Time `json:"observed_at"`
}

// Approval is one approver's decision bound to an exact head.
type Approval struct {
	Identity   string    `json:"identity"`
	HeadSHA    *string   `json:"head_sha"`
	ApprovedAt time.Time `json:"approved_at"`
}

// QuorumObservation records the approval quorum for one head.
type QuorumObservation struct {
	Status    string     `json:"status"`
	HeadSHA   *string    `json:"head_sha"`
	Approvals []Approval `json:"approvals"`
}

// ApprovalSnapshot is the contract's `approval_snapshot` record: GitHub's
// merge boundary for one exact head, or why no approval was available.
type ApprovalSnapshot struct {
	ContractVersion        string                 `json:"contract_version"`
	TaskID                 string                 `json:"task_id"`
	RunID                  string                 `json:"run_id"`
	ObservedAt             time.Time              `json:"observed_at"`
	HeadSHA                *string                `json:"head_sha"`
	QA                     QAObservation          `json:"qa"`
	RequiredChecks         []CheckObservation     `json:"required_checks"`
	ReviewDiscussions      DiscussionsObservation `json:"review_discussions"`
	ApprovalQuorum         QuorumObservation      `json:"approval_quorum"`
	MergeQueueEligible     bool                   `json:"merge_queue_eligible"`
	ApprovalSnapshotStatus string                 `json:"approval_snapshot_status"`
	EvidenceReference      string                 `json:"evidence_reference"`
}

// EligibilityResult is the outcome of evaluating a snapshot.
type EligibilityResult struct {
	Eligible bool
	Status   string
	Code     string
}

// Evaluate checks the four simultaneous merge conditions for the snapshot's
// exact head (contract section 4), updates the snapshot's eligibility fields,
// and returns the result. Any missing, failed, or head-stale observation is
// a denial.
func (s *ApprovalSnapshot) Evaluate() EligibilityResult {
	result := s.evaluate()
	s.MergeQueueEligible = result.Eligible
	s.ApprovalSnapshotStatus = result.Status
	return result
}

func (s *ApprovalSnapshot) evaluate() EligibilityResult {
	deny := func(code string) EligibilityResult {
		return EligibilityResult{Eligible: false, Status: SnapshotStatusIneligible, Code: code}
	}
	if s.HeadSHA == nil {
		return EligibilityResult{Eligible: false, Status: SnapshotStatusNotRequested, Code: DenyApprovalNoHead}
	}
	head := *s.HeadSHA

	// 1. QA must be passed for this exact head.
	if s.QA.Status != "passed" {
		return deny(DenyApprovalQANotPassed)
	}
	if s.QA.HeadSHA == nil || *s.QA.HeadSHA != head {
		return deny(DenyApprovalQAStaleHead)
	}

	// 2. Every required check must be passed for this exact head; an empty
	// list is fail-closed because no passing observation exists.
	if len(s.RequiredChecks) == 0 {
		return deny(DenyApprovalChecksMissing)
	}
	for _, c := range s.RequiredChecks {
		if c.Status != "passed" {
			return deny(DenyApprovalChecksNotPassed)
		}
		if c.HeadSHA == nil || *c.HeadSHA != head {
			return deny(DenyApprovalChecksStaleHead)
		}
	}

	// 3. Review discussions must be resolved for this exact head.
	if s.ReviewDiscussions.Status != "resolved" {
		return deny(DenyApprovalDiscussionsUnresolved)
	}
	if s.ReviewDiscussions.HeadSHA == nil || *s.ReviewDiscussions.HeadSHA != head {
		return deny(DenyApprovalDiscussionsStaleHead)
	}

	// 4. Both named approvers must have approved this exact head.
	for _, required := range RequiredApprovers {
		approvedCurrent := false
		hasAny := false
		for _, a := range s.ApprovalQuorum.Approvals {
			if a.Identity != required {
				continue
			}
			hasAny = true
			if a.HeadSHA != nil && *a.HeadSHA == head {
				approvedCurrent = true
				break
			}
		}
		if !approvedCurrent {
			if hasAny {
				return deny(DenyApprovalQuorumStaleHead)
			}
			return deny(DenyApprovalQuorumIncomplete)
		}
	}

	return EligibilityResult{Eligible: true, Status: SnapshotStatusEligible, Code: AllowMergeQueueEligible}
}
