package harness

import (
	"path"
	"strings"
	"time"
)

// Decision codes: allow, per-scope denials, and stop conditions.
const (
	AllowWithinGrant = "allow_within_grant"

	DenyGrantMissing              = "deny_grant_missing"
	DenyGrantRevoked              = "deny_grant_revoked"
	DenyStateNotRunning           = "deny_state_not_running"
	DenyGrantExpired              = "deny_grant_expired"
	DenyRepositoryMismatch        = "deny_repository_mismatch"
	DenyBaseSHAMismatch           = "deny_base_sha_mismatch"
	DenyToolNotPermitted          = "deny_tool_not_permitted"
	DenyToolArgumentNotPermitted  = "deny_tool_argument_not_permitted"
	DenyBranchForbidden           = "deny_branch_forbidden"
	DenyPathNotPermitted          = "deny_path_not_permitted"
	DenyPathClassRequiresElevated = "deny_path_class_requires_elevated"
	DenyPathClassForbidden        = "deny_path_class_forbidden"
	DenyNetworkNotPermitted       = "deny_network_not_permitted"
	DenyPatchNotPermitted         = "deny_patch_not_permitted"
	DenyPRNotPermitted            = "deny_pr_not_permitted"

	StopCodeOutOfGrant   = "stop_out_of_grant"
	StopCodeGrantExpired = "stop_grant_expired"
)

// BranchPrefix is the only branch namespace a run may write, per FP-01.
const BranchPrefix = "autofixer/"

// ActionContext is the harness state a policy decision is evaluated against.
type ActionContext struct {
	State   State
	Grant   *CapabilityGrant
	Revoked bool
	Now     time.Time
	// RiskClass is the run's assessed risk class. Edit requests are matched
	// against the FP-01 path classes with it, so a structured edit tool can
	// never change dependency, workflow, or migration content beyond the
	// assessment's class. Empty fails closed.
	RiskClass RiskClass
}

// ActionRequest is one requested action the runner wants to dispatch.
type ActionRequest struct {
	Tool      string
	Arguments []string
	// EvidenceArguments are the redacted value forms recorded in the
	// evidence chain for structured calls whose grant-checked Arguments are
	// stable class tokens. Nil records Arguments unchanged.
	EvidenceArguments   []string
	RepositoryURL       string
	BaseSHA             string
	Branch              string
	Paths               []string
	NetworkDestinations []string

	// Repository-mutation intents, evaluated against the grant's
	// may_create_patch / may_create_or_update_pr scope bits.
	WantsPatch       bool
	WantsPROperation bool
}

// evidenceArgs picks the recorded argument form for one request: the
// redacted values when the caller supplied them, otherwise the
// grant-checked tokens.
func (req ActionRequest) evidenceArgs() []string {
	if req.EvidenceArguments != nil {
		return append([]string{}, req.EvidenceArguments...)
	}
	return append([]string{}, req.Arguments...)
}

// Decision is the FP-04-facing policy output: whether an action may proceed,
// why not when denied, and which stop condition (if any) the denial triggers.
// Missing scope means denied.
type Decision struct {
	Allowed  bool
	Code     string
	StopCode string
}

// EvaluateAction checks one requested action against the capability grant.
// Checks run in a fixed order so denials are deterministic; the first failed
// check decides.
func EvaluateAction(ctx ActionContext, req ActionRequest) Decision {
	deny := func(code, stop string) Decision {
		return Decision{Allowed: false, Code: code, StopCode: stop}
	}

	if ctx.Grant == nil {
		return deny(DenyGrantMissing, "")
	}
	if ctx.Revoked {
		return deny(DenyGrantRevoked, "")
	}
	if ctx.State != StateRunning {
		return deny(DenyStateNotRunning, "")
	}
	if !ctx.Now.Before(ctx.Grant.ExpiresAt) {
		return deny(DenyGrantExpired, StopCodeGrantExpired)
	}
	if req.RepositoryURL == "" || req.RepositoryURL != ctx.Grant.RepositoryURL {
		return deny(DenyRepositoryMismatch, StopCodeOutOfGrant)
	}
	if req.BaseSHA == "" || req.BaseSHA != ctx.Grant.BaseSHA {
		return deny(DenyBaseSHAMismatch, StopCodeOutOfGrant)
	}
	argsAllowed, ok := lookupToolArgs(ctx.Grant.PermittedTools, req.Tool)
	if !ok {
		return deny(DenyToolNotPermitted, StopCodeOutOfGrant)
	}
	for _, arg := range req.Arguments {
		if !containsString(argsAllowed, arg) {
			return deny(DenyToolArgumentNotPermitted, StopCodeOutOfGrant)
		}
	}
	if req.Branch != "" && !strings.HasPrefix(req.Branch, BranchPrefix) {
		return deny(DenyBranchForbidden, StopCodeOutOfGrant)
	}
	if req.WantsPatch && !ctx.Grant.MayCreatePatch {
		return deny(DenyPatchNotPermitted, StopCodeOutOfGrant)
	}
	if req.WantsPROperation && !ctx.Grant.MayCreateOrUpdatePR {
		return deny(DenyPRNotPermitted, StopCodeOutOfGrant)
	}
	for _, path := range req.Paths {
		if !pathWithinAny(ctx.Grant.PermittedPaths, path) {
			return deny(DenyPathNotPermitted, StopCodeOutOfGrant)
		}
	}
	// No request may touch prohibited paths at all: secret-looking content
	// and version-control internals are unreadable and uneditable whatever
	// the tool, the granted paths, or the assessed class.
	for _, p := range req.Paths {
		if !ReadableFor(ClassifyPath(p)) {
			return deny(DenyPathClassForbidden, StopCodeOutOfGrant)
		}
	}
	// Edit intents additionally keep each path's FP-01 class: dependency and
	// migration changes need an elevated assessment, workflow and governance
	// content is never editable, and an unknown class fails closed. This is
	// the no-implicit-expansion gate in front of every structured edit.
	if req.WantsPatch {
		for _, p := range req.Paths {
			class := ClassifyPath(p)
			if EditAllowedFor(class, ctx.RiskClass) {
				continue
			}
			code := DenyPathClassForbidden
			if (class == ClassSource || class == ClassDependency || class == ClassMigration) &&
				(ctx.RiskClass == RiskLow || ctx.RiskClass == RiskElevated) {
				code = DenyPathClassRequiresElevated
			}
			return deny(code, StopCodeOutOfGrant)
		}
	}
	for _, dest := range req.NetworkDestinations {
		if !containsString(ctx.Grant.NetworkDestinations, dest) {
			return deny(DenyNetworkNotPermitted, StopCodeOutOfGrant)
		}
	}
	return Decision{Allowed: true, Code: AllowWithinGrant}
}

func lookupToolArgs(tools []PermittedTool, identity string) ([]string, bool) {
	if identity == "" {
		return nil, false
	}
	for _, t := range tools {
		if t.Identity == identity {
			return t.AllowedArguments, true
		}
	}
	return nil, false
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// pathWithinAny reports whether path is the permitted root itself or lives
// under it. Requested paths are untrusted input, so they are lexically
// normalized first: an absolute path, or one whose cleaned form escapes
// every permitted root via ".." (for example "harness/../../.github"), is
// denied. Roots and paths are compared on path-segment boundaries so
// "harness-evil" does not match a grant for "harness".
func pathWithinAny(permitted []string, requested string) bool {
	if requested == "" {
		return false
	}
	cleaned := path.Clean(requested)
	if path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") || cleaned == "." {
		return false
	}
	for _, root := range permitted {
		if root == "" {
			continue
		}
		trimmed := strings.TrimSuffix(path.Clean(root), "/")
		if trimmed == "." {
			trimmed = ""
		}
		if trimmed == "" {
			// A grant for the repository root only admits paths that stay
			// inside it after cleaning, which the escape checks above
			// already guarantee.
			return true
		}
		if cleaned == trimmed || strings.HasPrefix(cleaned, trimmed+"/") {
			return true
		}
	}
	return false
}
