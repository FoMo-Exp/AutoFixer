package harness

import (
	"strings"
	"time"
)

// Decision codes: allow, per-scope denials, and stop conditions.
const (
	AllowWithinGrant = "allow_within_grant"

	DenyGrantMissing             = "deny_grant_missing"
	DenyGrantRevoked             = "deny_grant_revoked"
	DenyStateNotRunning          = "deny_state_not_running"
	DenyGrantExpired             = "deny_grant_expired"
	DenyRepositoryMismatch       = "deny_repository_mismatch"
	DenyBaseSHAMismatch          = "deny_base_sha_mismatch"
	DenyToolNotPermitted         = "deny_tool_not_permitted"
	DenyToolArgumentNotPermitted = "deny_tool_argument_not_permitted"
	DenyBranchForbidden          = "deny_branch_forbidden"
	DenyPathNotPermitted         = "deny_path_not_permitted"
	DenyNetworkNotPermitted      = "deny_network_not_permitted"

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
}

// ActionRequest is one requested action the runner wants to dispatch.
type ActionRequest struct {
	Tool                string
	Arguments           []string
	RepositoryURL       string
	BaseSHA             string
	Branch              string
	Paths               []string
	NetworkDestinations []string
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
	for _, path := range req.Paths {
		if !pathWithinAny(ctx.Grant.PermittedPaths, path) {
			return deny(DenyPathNotPermitted, StopCodeOutOfGrant)
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
// under it, respecting path-segment boundaries so "harness-evil" does not
// match a grant for "harness".
func pathWithinAny(permitted []string, path string) bool {
	if path == "" {
		return false
	}
	for _, root := range permitted {
		if root == "" {
			continue
		}
		trimmed := strings.TrimSuffix(root, "/")
		if path == trimmed || strings.HasPrefix(path, trimmed+"/") {
			return true
		}
	}
	return false
}
