package harness

import (
	"errors"
	"time"
)

// PermittedTool is one tool identity and the exact argument allowlist from a
// capability grant. Missing scope means denied: an argument not listed here
// is not permitted.
type PermittedTool struct {
	Identity         string   `json:"identity"`
	AllowedArguments []string `json:"allowed_arguments"`
}

// ResourceLimits bounds one run's resource usage.
type ResourceLimits struct {
	MaxMemoryMB   int `json:"max_memory_mb"`
	MaxCPUSeconds int `json:"max_cpu_seconds"`
}

// CapabilityGrant is the contract's `capability_grant` record: the only
// actions a runner may exercise.
type CapabilityGrant struct {
	ContractVersion        string             `json:"contract_version"`
	TaskID                 string             `json:"task_id"`
	RunID                  string             `json:"run_id"`
	IssuedAt               time.Time          `json:"issued_at"`
	ExpiresAt              time.Time          `json:"expires_at"`
	PolicyVersion          string             `json:"policy_version"`
	CapabilityGrantVersion string             `json:"capability_grant_version"`
	RepositoryURL          string             `json:"repository_url"`
	BaseSHA                string             `json:"base_sha"`
	PermittedPaths         []string           `json:"permitted_paths"`
	PermittedTools         []PermittedTool    `json:"permitted_tools"`
	NetworkDestinations    []string           `json:"network_destinations"`
	MaxWallClockSeconds    int                `json:"max_wall_clock_seconds"`
	ResourceLimits         ResourceLimits     `json:"resource_limits"`
	MayCreatePatch         bool               `json:"may_create_patch"`
	MayCreateOrUpdatePR    bool               `json:"may_create_or_update_pr"`
	ApprovalReference      *ApprovalReference `json:"approval_reference"`
}

// GrantParams carries the runtime parameters for issuing a grant.
type GrantParams struct {
	TaskID                 string
	RunID                  string
	IssuedAt               time.Time
	ExpiresAt              time.Time
	CapabilityGrantVersion string
	PolicyVersion          string
	RepositoryURL          string
	BaseSHA                string
	PermittedPaths         []string
	PermittedTools         []PermittedTool
	NetworkDestinations    []string
	MaxWallClockSeconds    int
	ResourceLimits         ResourceLimits
	MayCreatePatch         bool
	MayCreateOrUpdatePR    bool
}

// IssueGrant validates a risk assessment against FP-01's issuance rules and
// builds the capability grant record. Prohibited assessments are refused
// outright; elevated assessments require an approval that precedes issuance.
func IssueGrant(assessment RiskAssessment, p GrantParams) (CapabilityGrant, error) {
	if assessment.RiskClass == RiskProhibited {
		return CapabilityGrant{}, ErrProhibitedRisk
	}
	if p.TaskID == "" || p.RunID == "" || p.RepositoryURL == "" || p.BaseSHA == "" ||
		p.CapabilityGrantVersion == "" || p.IssuedAt.IsZero() || p.MaxWallClockSeconds <= 0 {
		return CapabilityGrant{}, errors.New("harness: capability grant is missing a required field")
	}
	if p.TaskID != assessment.TaskID || p.RunID != assessment.RunID {
		return CapabilityGrant{}, errors.New("harness: capability grant must match the risk assessment linkage")
	}
	if !p.ExpiresAt.After(p.IssuedAt) {
		return CapabilityGrant{}, errors.New("harness: capability grant must expire after it is issued")
	}

	var approval *ApprovalReference
	switch assessment.RiskClass {
	case RiskElevated:
		ref := assessment.ElevatedApprovalReference
		if ref == nil || ref.Reference == "" || ref.ApproverIdentity == "" {
			return CapabilityGrant{}, errors.New("harness: elevated grant requires a named approval reference")
		}
		if !ref.ApprovedAt.Before(p.IssuedAt) {
			return CapabilityGrant{}, errors.New("harness: elevated approval must precede grant issuance")
		}
		approval = ref
	case RiskLow:
		if assessment.ElevatedApprovalReference != nil {
			return CapabilityGrant{}, errors.New("harness: low-risk grant must carry a null approval reference")
		}
	default:
		return CapabilityGrant{}, errors.New("harness: unknown risk class")
	}

	policyVersion := p.PolicyVersion
	if policyVersion == "" {
		policyVersion = DefaultPolicyVersion
	}
	if policyVersion != assessment.PolicyVersion {
		return CapabilityGrant{}, errors.New("harness: capability grant policy version must match the risk assessment")
	}
	return CapabilityGrant{
		ContractVersion:        ContractVersion,
		TaskID:                 p.TaskID,
		RunID:                  p.RunID,
		IssuedAt:               p.IssuedAt,
		ExpiresAt:              p.ExpiresAt,
		PolicyVersion:          policyVersion,
		CapabilityGrantVersion: p.CapabilityGrantVersion,
		RepositoryURL:          p.RepositoryURL,
		BaseSHA:                p.BaseSHA,
		PermittedPaths:         p.PermittedPaths,
		PermittedTools:         p.PermittedTools,
		NetworkDestinations:    p.NetworkDestinations,
		MaxWallClockSeconds:    p.MaxWallClockSeconds,
		ResourceLimits:         p.ResourceLimits,
		MayCreatePatch:         p.MayCreatePatch,
		MayCreateOrUpdatePR:    p.MayCreateOrUpdatePR,
		ApprovalReference:      approval,
	}, nil
}
