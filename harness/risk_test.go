package harness

import (
	"testing"
	"time"
)

func TestAssessRiskProhibited(t *testing.T) {
	cases := []struct {
		name string
		work ProposedWork
		code string
	}{
		{"secret access", ProposedWork{RequestsSecretAccess: true, LocalizedReversibleChange: true}, DecisionProhibitedSecretAccess},
		{"write main", ProposedWork{WritesToMain: true}, DecisionProhibitedMainWrite},
		{"edit workflows", ProposedWork{EditsCIWorkflows: true}, DecisionProhibitedWorkflowEdit},
		{"edit governance", ProposedWork{EditsGovernance: true}, DecisionProhibitedGovernanceChange},
		{"publish", ProposedWork{PublishesPackage: true}, DecisionProhibitedPublish},
		{"deploy", ProposedWork{Deploys: true}, DecisionProhibitedDeploy},
		{"infrastructure", ProposedWork{AltersInfrastructure: true}, DecisionProhibitedInfrastructure},
		{"unapproved network", ProposedWork{UnapprovedNetwork: true}, DecisionProhibitedNetworkEgress},
		// prohibited dominates other signals
		{"secrets beat elevated", ProposedWork{RequestsSecretAccess: true, Migration: true}, DecisionProhibitedSecretAccess},
		{"secrets beat low", ProposedWork{RequestsSecretAccess: true, LocalizedReversibleChange: true}, DecisionProhibitedSecretAccess},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			class, code := AssessRisk(tc.work)
			if class != RiskProhibited {
				t.Errorf("AssessRisk() class = %q, want %q", class, RiskProhibited)
			}
			if code != tc.code {
				t.Errorf("AssessRisk() code = %q, want %q", code, tc.code)
			}
		})
	}
}

func TestAssessRiskProhibitedPriorityIsDeterministic(t *testing.T) {
	work := ProposedWork{Deploys: true, WritesToMain: true, RequestsSecretAccess: true}
	_, code := AssessRisk(work)
	if code != DecisionProhibitedSecretAccess {
		t.Errorf("code = %q, want %q (secrets first)", code, DecisionProhibitedSecretAccess)
	}
}

func TestAssessRiskElevated(t *testing.T) {
	cases := []struct {
		name string
		work ProposedWork
	}{
		{"broad refactor", ProposedWork{BroadRefactor: true}},
		{"dependency change", ProposedWork{DependencyChange: true}},
		{"data shape change", ProposedWork{DataShapeChange: true}},
		{"migration", ProposedWork{Migration: true}},
		{"permission sensitive", ProposedWork{PermissionSensitive: true}},
		{"material uncertainty", ProposedWork{MaterialUncertainty: true}},
		// no positive low-risk signal: fail closed to elevated
		{"no signals at all", ProposedWork{}},
		{"localized but uncertain", ProposedWork{LocalizedReversibleChange: true, MaterialUncertainty: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			class, code := AssessRisk(tc.work)
			if class != RiskElevated {
				t.Errorf("AssessRisk() class = %q, want %q", class, RiskElevated)
			}
			if code != DecisionElevatedRequiresApproval {
				t.Errorf("AssessRisk() code = %q, want %q", code, DecisionElevatedRequiresApproval)
			}
		})
	}
}

func TestAssessRiskLow(t *testing.T) {
	class, code := AssessRisk(ProposedWork{LocalizedReversibleChange: true})
	if class != RiskLow {
		t.Errorf("class = %q, want %q", class, RiskLow)
	}
	if code != DecisionRiskLowApproved {
		t.Errorf("code = %q, want %q", code, DecisionRiskLowApproved)
	}
}

func TestNewRiskAssessmentRules(t *testing.T) {
	assessedAt := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	approvedAt := time.Date(2026, 10, 21, 8, 55, 0, 0, time.UTC)
	ref := func(at time.Time) *ApprovalReference {
		return &ApprovalReference{Reference: "evidence://grant-approvals/run-1", ApproverIdentity: "human:owner-1", ApprovedAt: at}
	}
	base := RiskAssessmentInput{
		TaskID: "task-1", RunID: "run-1", AssessedAt: assessedAt,
		AssessorIdentity: "human:reviewer-1", RationaleReference: "evidence://risk/task-1",
	}

	// low must carry an explicit null approval reference
	if _, err := NewRiskAssessment(base, RiskLow, DecisionRiskLowApproved, nil); err != nil {
		t.Errorf("low with nil ref: err = %v, want nil", err)
	}
	if _, err := NewRiskAssessment(base, RiskLow, DecisionRiskLowApproved, ref(approvedAt)); err == nil {
		t.Error("low with non-nil ref: err = nil, want error")
	}

	// elevated must carry a pre-grant approval reference
	if _, err := NewRiskAssessment(base, RiskElevated, DecisionElevatedRequiresApproval, nil); err == nil {
		t.Error("elevated with nil ref: err = nil, want error")
	}
	good, err := NewRiskAssessment(base, RiskElevated, DecisionElevatedRequiresApproval, ref(approvedAt))
	if err != nil {
		t.Errorf("elevated with valid ref: err = %v, want nil", err)
	}
	if good.ElevatedApprovalReference == nil || good.ElevatedApprovalReference.ApproverIdentity == "" {
		t.Error("elevated assessment must retain approver identity")
	}

	// prohibited must carry an explicit null approval reference
	if _, err := NewRiskAssessment(base, RiskProhibited, DecisionProhibitedSecretAccess, nil); err != nil {
		t.Errorf("prohibited with nil ref: err = %v, want nil", err)
	}
	if _, err := NewRiskAssessment(base, RiskProhibited, DecisionProhibitedSecretAccess, ref(approvedAt)); err == nil {
		t.Error("prohibited with non-nil ref: err = nil, want error")
	}

	// invalid risk class is rejected
	if _, err := NewRiskAssessment(base, RiskClass("unknown"), DecisionRiskLowApproved, nil); err == nil {
		t.Error("unknown risk class: err = nil, want error")
	}

	if good.ContractVersion != ContractVersion {
		t.Errorf("ContractVersion = %q, want %q", good.ContractVersion, ContractVersion)
	}
	if good.TaskID != "task-1" || good.RunID != "run-1" {
		t.Errorf("task/run linkage wrong: %+v", good)
	}
	if good.RiskClass != RiskElevated {
		t.Errorf("RiskClass = %q, want %q", good.RiskClass, RiskElevated)
	}
}
