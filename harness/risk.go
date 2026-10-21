package harness

import (
	"errors"
	"time"
)

// RiskClass is the pre-approval risk decision from the FP-01 ADR.
type RiskClass string

const (
	RiskLow        RiskClass = "low"
	RiskElevated   RiskClass = "elevated"
	RiskProhibited RiskClass = "prohibited"
)

// Decision codes emitted by risk assessment.
const (
	DecisionRiskLowApproved            = "risk_low_approved"
	DecisionElevatedRequiresApproval   = "elevated_requires_approval"
	DecisionProhibitedSecretAccess     = "prohibited_secret_access"
	DecisionProhibitedMainWrite        = "prohibited_main_write"
	DecisionProhibitedWorkflowEdit     = "prohibited_workflow_edit"
	DecisionProhibitedGovernanceChange = "prohibited_governance_change"
	DecisionProhibitedPublish          = "prohibited_publish"
	DecisionProhibitedDeploy           = "prohibited_deploy"
	DecisionProhibitedInfrastructure   = "prohibited_infrastructure"
	DecisionProhibitedNetworkEgress    = "prohibited_network_egress"
)

// ContractVersion is the task-evidence contract version every record carries.
const ContractVersion = "1.0.0"

// DefaultPolicyVersion is the governance policy version in force for FP-03.
const DefaultPolicyVersion = "governance-1"

// ProposedWork describes the work a task asks the harness to permit, before
// any grant exists. Fields map to the FP-01 risk classification rules; anything
// not explicitly signalled fails closed to elevated.
type ProposedWork struct {
	// Prohibited indicators (FP-01 scope exclusions)
	RequestsSecretAccess bool
	WritesToMain         bool
	EditsCIWorkflows     bool
	EditsGovernance      bool
	PublishesPackage     bool
	Deploys              bool
	AltersInfrastructure bool
	UnapprovedNetwork    bool

	// Elevated indicators
	BroadRefactor       bool
	DependencyChange    bool
	DataShapeChange     bool
	Migration           bool
	PermissionSensitive bool
	MaterialUncertainty bool

	// Positive low-risk signal: a localized, reversible source or test change.
	LocalizedReversibleChange bool
}

// RiskAssessment is the contract's `risk_assessment` record.
type RiskAssessment struct {
	ContractVersion           string             `json:"contract_version"`
	TaskID                    string             `json:"task_id"`
	RunID                     string             `json:"run_id"`
	AssessedAt                time.Time          `json:"assessed_at"`
	AssessorIdentity          string             `json:"assessor_identity"`
	RiskClass                 RiskClass          `json:"risk_class"`
	DecisionCode              string             `json:"decision_code"`
	RationaleReference        string             `json:"rationale_reference"`
	PolicyVersion             string             `json:"policy_version"`
	ElevatedApprovalReference *ApprovalReference `json:"elevated_approval_reference"`
}

// ApprovalReference names the human approval attached to an elevated
// assessment and its grant.
type ApprovalReference struct {
	Reference        string    `json:"reference"`
	ApproverIdentity string    `json:"approver_identity"`
	ApprovedAt       time.Time `json:"approved_at"`
}

// RiskAssessmentInput carries the identifiers and timestamps for an
// assessment record; the risk class and decision code come from AssessRisk.
type RiskAssessmentInput struct {
	TaskID             string
	RunID              string
	AssessedAt         time.Time
	AssessorIdentity   string
	RationaleReference string
	PolicyVersion      string
}

// ErrProhibitedRisk is returned when a prohibited assessment is asked to
// proceed toward a grant.
var ErrProhibitedRisk = errors.New("harness: prohibited risk must lead to rejected, not a grant")

// prohibitedDecisions lists FP-01 prohibited indicators in the fixed
// evaluation order used by AssessRisk so classification is deterministic.
var prohibitedDecisions = []struct {
	hit  func(ProposedWork) bool
	code string
}{
	{func(w ProposedWork) bool { return w.RequestsSecretAccess }, DecisionProhibitedSecretAccess},
	{func(w ProposedWork) bool { return w.WritesToMain }, DecisionProhibitedMainWrite},
	{func(w ProposedWork) bool { return w.EditsCIWorkflows }, DecisionProhibitedWorkflowEdit},
	{func(w ProposedWork) bool { return w.EditsGovernance }, DecisionProhibitedGovernanceChange},
	{func(w ProposedWork) bool { return w.PublishesPackage }, DecisionProhibitedPublish},
	{func(w ProposedWork) bool { return w.Deploys }, DecisionProhibitedDeploy},
	{func(w ProposedWork) bool { return w.AltersInfrastructure }, DecisionProhibitedInfrastructure},
	{func(w ProposedWork) bool { return w.UnapprovedNetwork }, DecisionProhibitedNetworkEgress},
}

// AssessRisk classifies proposed work per FP-01: prohibited dominates, then
// elevated, and only an explicitly localized reversible change is low. Work
// with no positive low-risk signal fails closed to elevated.
func AssessRisk(w ProposedWork) (RiskClass, string) {
	for _, d := range prohibitedDecisions {
		if d.hit(w) {
			return RiskProhibited, d.code
		}
	}
	if w.BroadRefactor || w.DependencyChange || w.DataShapeChange ||
		w.Migration || w.PermissionSensitive || w.MaterialUncertainty {
		return RiskElevated, DecisionElevatedRequiresApproval
	}
	if w.LocalizedReversibleChange {
		return RiskLow, DecisionRiskLowApproved
	}
	return RiskElevated, DecisionElevatedRequiresApproval
}

// NewRiskAssessment builds a contract-compliant assessment record. Elevated
// assessments must carry a pre-grant approval reference; low and prohibited
// must carry an explicit null.
func NewRiskAssessment(in RiskAssessmentInput, class RiskClass, decisionCode string, approval *ApprovalReference) (RiskAssessment, error) {
	if in.TaskID == "" || in.RunID == "" || in.AssessorIdentity == "" || in.RationaleReference == "" {
		return RiskAssessment{}, errors.New("harness: risk assessment is missing a required field")
	}
	policyVersion := in.PolicyVersion
	if policyVersion == "" {
		policyVersion = DefaultPolicyVersion
	}
	switch class {
	case RiskLow, RiskProhibited:
		if approval != nil {
			return RiskAssessment{}, errors.New("harness: low and prohibited assessments must have a null elevated_approval_reference")
		}
	case RiskElevated:
		if approval == nil || approval.Reference == "" || approval.ApproverIdentity == "" {
			return RiskAssessment{}, errors.New("harness: elevated assessment requires a named pre-grant approval reference")
		}
	default:
		return RiskAssessment{}, errors.New("harness: unknown risk class")
	}
	return RiskAssessment{
		ContractVersion:           ContractVersion,
		TaskID:                    in.TaskID,
		RunID:                     in.RunID,
		AssessedAt:                in.AssessedAt,
		AssessorIdentity:          in.AssessorIdentity,
		RiskClass:                 class,
		DecisionCode:              decisionCode,
		RationaleReference:        in.RationaleReference,
		PolicyVersion:             policyVersion,
		ElevatedApprovalReference: approval,
	}, nil
}
