package harness

import (
	"errors"
	"testing"
	"time"
)

func lowAssessment(t *testing.T) RiskAssessment {
	t.Helper()
	a, err := NewRiskAssessment(RiskAssessmentInput{
		TaskID: "task-1", RunID: "run-1",
		AssessedAt:         time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/task-1",
	}, RiskLow, DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatalf("low assessment: %v", err)
	}
	return a
}

func elevatedAssessment(t *testing.T, approvedAt time.Time) RiskAssessment {
	t.Helper()
	a, err := NewRiskAssessment(RiskAssessmentInput{
		TaskID: "task-1", RunID: "run-1",
		AssessedAt:         time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/task-1",
	}, RiskElevated, DecisionElevatedRequiresApproval, &ApprovalReference{
		Reference: "evidence://grant-approvals/run-1", ApproverIdentity: "human:owner-1", ApprovedAt: approvedAt,
	})
	if err != nil {
		t.Fatalf("elevated assessment: %v", err)
	}
	return a
}

func validGrantParams(issuedAt, expiresAt time.Time) GrantParams {
	return GrantParams{
		TaskID: "task-1", RunID: "run-1",
		IssuedAt: issuedAt, ExpiresAt: expiresAt,
		CapabilityGrantVersion: "grant-1",
		RepositoryURL:          "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:                "abc123",
		PermittedPaths:         []string{"harness/"},
		PermittedTools:         []PermittedTool{{Identity: "go-test", AllowedArguments: []string{"./..."}}},
		NetworkDestinations:    []string{},
		MaxWallClockSeconds:    600,
		ResourceLimits:         ResourceLimits{MaxMemoryMB: 512, MaxCPUSeconds: 300},
		MayCreatePatch:         true,
		MayCreateOrUpdatePR:    true,
	}
}

func TestIssueGrantLowRiskCarriesContractFields(t *testing.T) {
	issuedAt := time.Date(2026, 10, 21, 9, 1, 0, 0, time.UTC)
	expiresAt := issuedAt.Add(time.Hour)
	grant, err := IssueGrant(lowAssessment(t), validGrantParams(issuedAt, expiresAt))
	if err != nil {
		t.Fatalf("IssueGrant: %v", err)
	}
	if grant.ContractVersion != ContractVersion {
		t.Errorf("ContractVersion = %q, want %q", grant.ContractVersion, ContractVersion)
	}
	if grant.TaskID != "task-1" || grant.RunID != "run-1" {
		t.Errorf("task/run linkage wrong: %+v", grant)
	}
	if grant.PolicyVersion != DefaultPolicyVersion {
		t.Errorf("PolicyVersion = %q, want %q", grant.PolicyVersion, DefaultPolicyVersion)
	}
	if grant.CapabilityGrantVersion != "grant-1" {
		t.Errorf("CapabilityGrantVersion = %q, want %q", grant.CapabilityGrantVersion, "grant-1")
	}
	if grant.RepositoryURL == "" || grant.BaseSHA == "" {
		t.Error("grant must bind repository URL and base SHA")
	}
	if !grant.ExpiresAt.After(grant.IssuedAt) {
		t.Errorf("ExpiresAt %v must be after IssuedAt %v", grant.ExpiresAt, grant.IssuedAt)
	}
	if grant.ApprovalReference != nil {
		t.Errorf("low-risk grant ApprovalReference = %+v, want nil", grant.ApprovalReference)
	}
	if grant.MaxWallClockSeconds <= 0 {
		t.Error("MaxWallClockSeconds must be positive")
	}
}

func TestIssueGrantRefusesProhibited(t *testing.T) {
	assessment := RiskAssessment{RiskClass: RiskProhibited, TaskID: "task-1", RunID: "run-1"}
	issuedAt := time.Date(2026, 10, 21, 9, 1, 0, 0, time.UTC)
	_, err := IssueGrant(assessment, validGrantParams(issuedAt, issuedAt.Add(time.Hour)))
	if !errors.Is(err, ErrProhibitedRisk) {
		t.Errorf("err = %v, want ErrProhibitedRisk", err)
	}
}

func TestIssueGrantElevatedRequiresPreIssuanceApproval(t *testing.T) {
	issuedAt := time.Date(2026, 10, 21, 9, 1, 0, 0, time.UTC)
	expiresAt := issuedAt.Add(time.Hour)

	// approval before issuance: OK, grant carries the assessment's reference
	before := issuedAt.Add(-5 * time.Minute)
	assessment := elevatedAssessment(t, before)
	grant, err := IssueGrant(assessment, validGrantParams(issuedAt, expiresAt))
	if err != nil {
		t.Fatalf("IssueGrant with pre-issuance approval: %v", err)
	}
	if grant.ApprovalReference == nil || grant.ApprovalReference != assessment.ElevatedApprovalReference {
		t.Errorf("grant approval reference must equal the assessment's reference")
	}

	// approval at issuance time is not "pre-grant": rejected
	atIssuance := elevatedAssessment(t, issuedAt)
	if _, err := IssueGrant(atIssuance, validGrantParams(issuedAt, expiresAt)); err == nil {
		t.Error("approval at issuance: err = nil, want error")
	}

	// approval after issuance: rejected
	after := elevatedAssessment(t, issuedAt.Add(time.Minute))
	if _, err := IssueGrant(after, validGrantParams(issuedAt, expiresAt)); err == nil {
		t.Error("approval after issuance: err = nil, want error")
	}
}

func TestIssueGrantRejectsMalformedGrants(t *testing.T) {
	issuedAt := time.Date(2026, 10, 21, 9, 1, 0, 0, time.UTC)
	expiresAt := issuedAt.Add(time.Hour)
	assessment := lowAssessment(t)

	cases := []struct {
		name   string
		mutate func(*GrantParams)
	}{
		{"missing repository", func(p *GrantParams) { p.RepositoryURL = "" }},
		{"missing base sha", func(p *GrantParams) { p.BaseSHA = "" }},
		{"missing task id", func(p *GrantParams) { p.TaskID = "" }},
		{"missing run id", func(p *GrantParams) { p.RunID = "" }},
		{"missing grant version", func(p *GrantParams) { p.CapabilityGrantVersion = "" }},
		{"zero issued at", func(p *GrantParams) { p.IssuedAt = time.Time{} }},
		{"expires before issue", func(p *GrantParams) { p.ExpiresAt = issuedAt.Add(-time.Minute) }},
		{"expires at issue", func(p *GrantParams) { p.ExpiresAt = issuedAt }},
		{"zero wall clock", func(p *GrantParams) { p.MaxWallClockSeconds = 0 }},
		{"task mismatch with assessment", func(p *GrantParams) { p.TaskID = "other-task" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := validGrantParams(issuedAt, expiresAt)
			tc.mutate(&p)
			if _, err := IssueGrant(assessment, p); err == nil {
				t.Error("err = nil, want error")
			}
		})
	}
}
