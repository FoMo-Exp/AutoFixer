package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

// PatchStatus is the contract's patch outcome.
type PatchStatus string

const (
	PatchNotCreated   PatchStatus = "not_created"
	PatchPreparedNoPR PatchStatus = "prepared_no_pr"
	PatchProposed     PatchStatus = "proposed"
	PatchMerged       PatchStatus = "merged"
)

// ValidationEvidence is one validation attempt retained in a patch report.
// Arguments are redacted when the report is finalized; raw command output is
// never accepted by this type.
type ValidationEvidence struct {
	Tool           string         `json:"tool"`
	Arguments      []string       `json:"arguments"`
	ExitStatus     *int           `json:"exit_status"`
	OutputDigest   harness.Digest `json:"output_digest"`
	EventReference string         `json:"event_reference"`
}

// PatchReport is the versioned patch artifact described by the evidence
// contract. Pointers intentionally preserve explicit JSON nulls for outcomes
// that did not create a branch, head, or PR.
type PatchReport struct {
	ContractVersion    string               `json:"contract_version"`
	TaskID             string               `json:"task_id"`
	RunID              string               `json:"run_id"`
	IssuedAt           time.Time            `json:"issued_at"`
	RepositoryURL      string               `json:"repository_url"`
	BaseSHA            string               `json:"base_sha"`
	PatchStatus        PatchStatus          `json:"patch_status"`
	Branch             *string              `json:"branch"`
	HeadSHA            *string              `json:"head_sha"`
	PRID               *string              `json:"pr_id"`
	ChangeSummary      string               `json:"change_summary"`
	Validation         []ValidationEvidence `json:"validation"`
	EvidenceReferences []string             `json:"evidence_references"`
	ReportDigest       string               `json:"report_digest"`
	DigestAlgorithm    string               `json:"digest_algorithm"`
}

// NewPatchReport validates and finalizes a report. The returned report is
// self-contained and its digest is calculated over the redacted report with
// report_digest blanked, making the digest stable and independently verifiable.
func NewPatchReport(report PatchReport) (PatchReport, error) {
	if report.ContractVersion == "" {
		report.ContractVersion = harness.ContractVersion
	}
	if report.DigestAlgorithm == "" {
		report.DigestAlgorithm = harness.DigestAlgorithmSHA256
	}
	if err := report.validate(false); err != nil {
		return PatchReport{}, err
	}
	redacted := redactPatchReport(report)
	redacted.ReportDigest = ""
	digest, err := digestJSON(redacted)
	if err != nil {
		return PatchReport{}, fmt.Errorf("delivery: digest patch report: %w", err)
	}
	redacted.ReportDigest = digest
	return redacted, nil
}

// Validate checks the patch report's required fields and branch/head/PR
// nullability rules. It does not require validation evidence for a
// not_created outcome: a rejection can legitimately happen before a tool ran.
func (r PatchReport) Validate() error {
	return r.validate(true)
}

func (r PatchReport) validate(requireDigest bool) error {
	if r.ContractVersion != harness.ContractVersion {
		return fmt.Errorf("delivery: unsupported patch report contract version %q", r.ContractVersion)
	}
	if r.TaskID == "" || r.RunID == "" || r.IssuedAt.IsZero() || r.BaseSHA == "" || r.ChangeSummary == "" {
		return errors.New("delivery: patch report is missing a required field")
	}
	if err := ValidateRepositoryURL(r.RepositoryURL); err != nil {
		return err
	}
	switch r.PatchStatus {
	case PatchNotCreated:
		if r.Branch != nil || r.HeadSHA != nil || r.PRID != nil {
			return errors.New("delivery: not_created report must have null branch, head, and PR")
		}
	case PatchPreparedNoPR:
		if err := requireRevision(r.Branch, r.HeadSHA, nil); err != nil {
			return err
		}
		if r.PRID != nil {
			return errors.New("delivery: prepared_no_pr report must have a null PR")
		}
	case PatchProposed, PatchMerged:
		if err := requireRevision(r.Branch, r.HeadSHA, r.PRID); err != nil {
			return err
		}
	default:
		return fmt.Errorf("delivery: unknown patch status %q", r.PatchStatus)
	}
	if r.Branch != nil {
		if err := ValidateTaskBranch(r.TaskID, *r.Branch, dereference(r.HeadSHA)); err != nil {
			return err
		}
	}
	if r.PatchStatus != PatchNotCreated && len(r.Validation) == 0 {
		return errors.New("delivery: patch report requires validation evidence for a created patch")
	}
	if r.DigestAlgorithm != harness.DigestAlgorithmSHA256 {
		return fmt.Errorf("delivery: unsupported report digest algorithm %q", r.DigestAlgorithm)
	}
	if len(r.EvidenceReferences) == 0 {
		return errors.New("delivery: patch report requires evidence references")
	}
	for _, ref := range r.EvidenceReferences {
		if strings.TrimSpace(ref) == "" {
			return errors.New("delivery: patch report contains an empty evidence reference")
		}
	}
	for i := range r.Validation {
		v := r.Validation[i]
		if v.Tool == "" || v.EventReference == "" || v.OutputDigest.Algorithm == "" || v.OutputDigest.Value == "" {
			return fmt.Errorf("delivery: validation evidence %d is incomplete", i)
		}
		eventReferencePrefix := "evidence://events/" + r.RunID
		if v.EventReference != eventReferencePrefix && !strings.HasPrefix(v.EventReference, eventReferencePrefix+"/") {
			return fmt.Errorf("delivery: validation evidence %d is not scoped to run %q", i, r.RunID)
		}
		if v.OutputDigest.Algorithm != harness.DigestAlgorithmSHA256 {
			return fmt.Errorf("delivery: validation evidence %d uses unsupported digest algorithm", i)
		}
	}
	if requireDigest {
		if r.ReportDigest == "" {
			return errors.New("delivery: patch report is missing report_digest")
		}
		content := redactPatchReport(r)
		content.ReportDigest = ""
		want, err := digestJSON(content)
		if err != nil || want != r.ReportDigest {
			return errors.New("delivery: patch report digest does not match its content")
		}
	}
	return nil
}

func dereference(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func requireRevision(branch, head, pr *string) error {
	if branch == nil || head == nil || *branch == "" || *head == "" {
		return errors.New("delivery: patch report is missing a required revision")
	}
	if pr != nil && *pr == "" {
		return errors.New("delivery: patch report contains an empty PR id")
	}
	return nil
}

func redactPatchReport(report PatchReport) PatchReport {
	report.ChangeSummary = harness.Redact(report.ChangeSummary)
	report.EvidenceReferences = append([]string{}, report.EvidenceReferences...)
	report.Validation = append([]ValidationEvidence{}, report.Validation...)
	for i := range report.Validation {
		report.Validation[i].Tool = harness.Redact(report.Validation[i].Tool)
		report.Validation[i].Arguments = make([]string, len(report.Validation[i].Arguments))
		for j, arg := range report.Validation[i].Arguments {
			report.Validation[i].Arguments[j] = harness.Redact(arg)
		}
	}
	return report
}

func digestJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// PullRequestReport is the human- and machine-readable report embedded in a
// PR body. It repeats the key patch fields so a reviewer can inspect one PR
// without chasing an inaccessible artifact, while retaining the full patch
// report and the current-head approval snapshot.
type PullRequestReport struct {
	ContractVersion  string                   `json:"contract_version"`
	TaskID           string                   `json:"task_id"`
	RunID            string                   `json:"run_id"`
	CurrentHeadSHA   string                   `json:"current_head_sha"`
	PatchSummary     string                   `json:"patch_summary"`
	Validation       []ValidationEvidence     `json:"validation"`
	RiskAssessment   harness.RiskAssessment   `json:"risk_assessment"`
	ApprovalSnapshot harness.ApprovalSnapshot `json:"approval_snapshot"`
	PatchReport      PatchReport              `json:"patch_report"`
}

// NewPullRequestReport constructs a report bound to one proposed patch and
// one exact current head. It permits an ineligible snapshot because a new PR
// is expected to await QA/checks/review; merge eligibility is checked later.
func NewPullRequestReport(patch PatchReport, risk harness.RiskAssessment, snapshot harness.ApprovalSnapshot) (PullRequestReport, error) {
	if err := patch.Validate(); err != nil {
		return PullRequestReport{}, err
	}
	if patch.PatchStatus != PatchProposed && patch.PatchStatus != PatchMerged {
		return PullRequestReport{}, errors.New("delivery: pull-request report requires a proposed or merged patch")
	}
	if err := validateRiskAssessment(risk, patch.TaskID, patch.RunID); err != nil {
		return PullRequestReport{}, err
	}
	if snapshot.ContractVersion != harness.ContractVersion || snapshot.TaskID != patch.TaskID || snapshot.RunID != patch.RunID {
		return PullRequestReport{}, errors.New("delivery: approval snapshot does not match patch report")
	}
	if patch.HeadSHA == nil || *patch.HeadSHA == "" || snapshot.HeadSHA == nil || *snapshot.HeadSHA != *patch.HeadSHA {
		return PullRequestReport{}, errors.New("delivery: approval snapshot must bind to the patch head")
	}
	if err := validateApprovalSnapshotHeadBindings(snapshot, patch.PatchStatus, *patch.HeadSHA); err != nil {
		return PullRequestReport{}, err
	}
	return PullRequestReport{
		ContractVersion:  harness.ContractVersion,
		TaskID:           patch.TaskID,
		RunID:            patch.RunID,
		CurrentHeadSHA:   *patch.HeadSHA,
		PatchSummary:     patch.ChangeSummary,
		Validation:       append([]ValidationEvidence{}, patch.Validation...),
		RiskAssessment:   risk,
		ApprovalSnapshot: snapshot,
		PatchReport:      patch,
	}, nil
}

// Validate ensures a report remains tied to the patch head before a PR is
// created or updated.
func (r PullRequestReport) Validate() error {
	if r.ContractVersion != harness.ContractVersion || r.TaskID == "" || r.RunID == "" || r.CurrentHeadSHA == "" {
		return errors.New("delivery: pull-request report is missing a required field")
	}
	if err := r.PatchReport.Validate(); err != nil {
		return err
	}
	if r.PatchReport.TaskID != r.TaskID || r.PatchReport.RunID != r.RunID ||
		r.PatchReport.HeadSHA == nil || *r.PatchReport.HeadSHA != r.CurrentHeadSHA {
		return errors.New("delivery: pull-request report is not bound to its current head")
	}
	if r.PatchSummary == "" || r.PatchSummary != r.PatchReport.ChangeSummary || len(r.Validation) != len(r.PatchReport.Validation) {
		return errors.New("delivery: pull-request report is missing patch evidence")
	}
	if err := validateRiskAssessment(r.RiskAssessment, r.TaskID, r.RunID); err != nil {
		return err
	}
	if r.ApprovalSnapshot.ContractVersion != harness.ContractVersion || r.ApprovalSnapshot.TaskID != r.TaskID || r.ApprovalSnapshot.RunID != r.RunID || r.ApprovalSnapshot.ObservedAt.IsZero() || r.ApprovalSnapshot.EvidenceReference == "" ||
		r.ApprovalSnapshot.HeadSHA == nil || *r.ApprovalSnapshot.HeadSHA != r.CurrentHeadSHA {
		return errors.New("delivery: pull-request report has mismatched approval evidence")
	}
	if err := validateApprovalSnapshotHeadBindings(r.ApprovalSnapshot, r.PatchReport.PatchStatus, r.CurrentHeadSHA); err != nil {
		return err
	}
	return nil
}

func validateRiskAssessment(risk harness.RiskAssessment, taskID, runID string) error {
	if risk.ContractVersion != harness.ContractVersion || risk.TaskID != taskID || risk.RunID != runID ||
		risk.AssessedAt.IsZero() || risk.AssessorIdentity == "" || risk.DecisionCode == "" ||
		risk.RationaleReference == "" || risk.PolicyVersion == "" {
		return errors.New("delivery: pull-request report has incomplete risk evidence")
	}
	switch risk.RiskClass {
	case harness.RiskLow, harness.RiskProhibited:
		if risk.ElevatedApprovalReference != nil {
			return errors.New("delivery: low or prohibited risk must have a null elevated approval reference")
		}
	case harness.RiskElevated:
		ref := risk.ElevatedApprovalReference
		if ref == nil || ref.Reference == "" || ref.ApproverIdentity == "" || ref.ApprovedAt.IsZero() {
			return errors.New("delivery: elevated risk requires a preceding approval reference")
		}
	default:
		return errors.New("delivery: pull-request report has an unknown risk class")
	}
	return nil
}

// MarshalBody returns a deterministic PR body. It includes a JSON evidence
// block so automated consumers and reviewers observe the same report. Values
// are redacted before serialization.
func (r PullRequestReport) MarshalBody() (string, error) {
	if err := r.Validate(); err != nil {
		return "", err
	}
	redacted := r
	redacted.PatchReport = redactPatchReport(redacted.PatchReport)
	redacted.PatchSummary = harness.Redact(redacted.PatchSummary)
	redacted.Validation = append([]ValidationEvidence{}, redacted.Validation...)
	for i := range redacted.Validation {
		redacted.Validation[i].Tool = harness.Redact(redacted.Validation[i].Tool)
		redacted.Validation[i].Arguments = make([]string, len(redacted.Validation[i].Arguments))
		for j, arg := range redacted.Validation[i].Arguments {
			redacted.Validation[i].Arguments[j] = harness.Redact(arg)
		}
	}
	raw, err := json.MarshalIndent(redacted, "", "  ")
	if err != nil {
		return "", fmt.Errorf("delivery: marshal pull-request report: %w", err)
	}
	return "<!-- forgepilot-report:v1 -->\n\n## ForgePilot remediation report\n\n```json\n" + string(raw) + "\n```\n", nil
}
