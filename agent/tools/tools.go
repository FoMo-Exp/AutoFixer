// Package tools is the agent prototype's allow-list tool registration layer.
//
// A Registry starts empty: every tool identity, its allowed arguments and
// scopes, and the minimum run risk class it may run under are registered
// explicitly as Permission metadata. Every request is denied unless it
// matches that metadata — unregistered, malformed, over-privileged, and
// risk-incompatible requests are denied with a recorded reason before any
// dispatch happens.
//
// The registry executes nothing and grants nothing. An authorized request is
// delivered through the injected Dispatcher; SandboxDispatcher forwards it to
// the existing sandbox.Runner, where the harness FP-03 policy decides again
// against the capability grant and writes the authoritative evidence chain.
// The registry's allow-list is a second, independent gate in front of that
// boundary, never a substitute for it.
package tools

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// Decision codes recorded by this layer. They parallel the harness FP-03
// codes but name this layer's own allow-list, so audit evidence states which
// gate decided.
const (
	AllowWithinRegistry = "allow_within_registry"

	DenyRequestIncomplete    = "deny_request_incomplete"
	DenyActionMalformed      = "deny_action_malformed"
	DenyToolUnregistered     = "deny_tool_unregistered"
	DenyRiskClassMismatch    = "deny_risk_class_mismatch"
	DenyArgumentNotPermitted = "deny_argument_not_permitted"
	DenyPathNotPermitted     = "deny_path_not_permitted"
	DenyNetworkNotPermitted  = "deny_network_not_permitted"
	DenyNoDispatcher         = "deny_no_dispatcher"
)

// Call is one tool invocation with its declared scopes. Every scope is
// declared, never inferred: a value the tool's registered permission does not
// list is over-privileged and denied.
type Call struct {
	Tool                string   `json:"tool"`
	Arguments           []string `json:"arguments"`
	Paths               []string `json:"paths"`
	NetworkDestinations []string `json:"network_destinations"`
}

// Request binds one Call to the run asking for it. Task and run identity make
// every audited decision attributable; RiskClass is the run's assessed risk
// class the tool's registered requirement is matched against.
type Request struct {
	TaskID    string            `json:"task_id"`
	RunID     string            `json:"run_id"`
	RiskClass harness.RiskClass `json:"risk_class"`
	Call      Call              `json:"call"`
}

// Permission is the registered metadata for one tool identity: the exact
// argument, path, and network allow-lists plus the minimum assessed run risk
// class the tool may run under. Every list defaults to empty and empty means
// nothing is permitted.
type Permission struct {
	Identity                   string            `json:"identity"`
	AllowedArguments           []string          `json:"allowed_arguments"`
	AllowedPaths               []string          `json:"allowed_paths"`
	AllowedNetworkDestinations []string          `json:"allowed_network_destinations"`
	MinimumRisk                harness.RiskClass `json:"minimum_risk"`
}

// Decision is this layer's allow-list output: whether a request may be
// dispatched and, either way, the code and human-readable reason recorded in
// the audit log. Missing or non-matching metadata means denied.
type Decision struct {
	Allowed bool   `json:"allowed"`
	Code    string `json:"code"`
	Reason  string `json:"reason"`
}

// AuditEntry is one recorded allow/deny decision from this layer: what was
// asked, under which task and run, and why it was decided that way. Arguments
// are stored redacted through harness.Redact.
type AuditEntry struct {
	OccurredAt time.Time `json:"occurred_at"`
	TaskID     string    `json:"task_id"`
	RunID      string    `json:"run_id"`
	Tool       string    `json:"tool"`
	Arguments  []string  `json:"arguments"`
	Code       string    `json:"code"`
	Reason     string    `json:"reason"`
}

// Outcome is the result of one Execute call.
type Outcome struct {
	// Decision is this layer's allow-list decision and audit reason; it is
	// recorded in the registry's audit log for every Execute call.
	Decision Decision
	// Result carries the dispatch-boundary evidence. It is nil exactly when
	// the registry denied the request and nothing was dispatched; when it is
	// non-nil the dispatch was attempted and its error, if any, is returned
	// alongside this outcome.
	Result *sandbox.Result
}

// Executor is the task-loop-facing surface of this layer: authorize one
// request against the allow-list, record the decision, and dispatch only
// when permitted. *Registry is the implementation the composition root
// injects; loop tests fake at this boundary.
type Executor interface {
	Execute(ctx context.Context, req Request) (Outcome, error)
}

var _ Executor = (*Registry)(nil)

// Option configures a Registry at construction time.
type Option func(*Registry)

// WithDispatcher sets the dispatch boundary authorized requests are delivered
// to. A registry without one denies every otherwise-valid request with
// DenyNoDispatcher instead of executing anything.
func WithDispatcher(d Dispatcher) Option {
	return func(r *Registry) { r.dispatcher = d }
}

// WithClock replaces the audit timestamp source. Tests use it for
// deterministic evidence; a nil clock keeps the default.
func WithClock(now func() time.Time) Option {
	return func(r *Registry) {
		if now != nil {
			r.now = now
		}
	}
}

// Registry is the immutable-registration allow-list: permissions are only
// added, never replaced or removed, every request is checked against them in
// a fixed order, and every decision is recorded with its reason before any
// dispatch. It executes nothing itself.
type Registry struct {
	mu          sync.Mutex
	permissions map[string]Permission
	entries     []AuditEntry
	dispatcher  Dispatcher
	now         func() time.Time
}

// NewRegistry builds an empty registry: no tool is dispatchable until it is
// registered.
func NewRegistry(opts ...Option) *Registry {
	r := &Registry{
		permissions: map[string]Permission{},
		now:         time.Now,
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// Register adds one tool's permission metadata. Registration is the only way
// a tool becomes dispatchable, and duplicates are refused rather than
// silently replacing the allow-list mid-run. Path roots are normalized once,
// here, so a misconfigured absolute or escaping root fails at registration
// instead of denying (or admitting) the wrong scope at runtime.
func (r *Registry) Register(p Permission) error {
	if p.Identity == "" {
		return errors.New("tools: permission requires a tool identity")
	}
	switch p.MinimumRisk {
	case harness.RiskLow, harness.RiskElevated:
	default:
		return fmt.Errorf("tools: tool %q must declare a usable minimum risk class (low or elevated), got %q", p.Identity, p.MinimumRisk)
	}
	roots := make([]string, 0, len(p.AllowedPaths))
	for _, root := range p.AllowedPaths {
		cleaned, err := cleanRoot(root)
		if err != nil {
			return fmt.Errorf("tools: tool %q permitted path root %q: %w", p.Identity, root, err)
		}
		roots = append(roots, cleaned)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.permissions[p.Identity]; exists {
		return fmt.Errorf("tools: tool %q is already registered", p.Identity)
	}
	r.permissions[p.Identity] = Permission{
		Identity:                   p.Identity,
		AllowedArguments:           append([]string{}, p.AllowedArguments...),
		AllowedPaths:               roots,
		AllowedNetworkDestinations: append([]string{}, p.AllowedNetworkDestinations...),
		MinimumRisk:                p.MinimumRisk,
	}
	return nil
}

// Authorize evaluates one request against the registry's allow-list. Checks
// run in a fixed order — request identity, action well-formedness,
// registration, risk class, arguments, paths, network, dispatch boundary —
// so the first failed check decides and the same request always produces the
// same decision. Authorize records nothing.
func (r *Registry) Authorize(req Request) Decision {
	deny := func(code, reason string) Decision {
		return Decision{Allowed: false, Code: code, Reason: reason}
	}

	if req.TaskID == "" || req.RunID == "" {
		return deny(DenyRequestIncomplete, "request is missing task or run identity")
	}
	if req.Call.Tool == "" {
		return deny(DenyActionMalformed, "action names an empty tool")
	}
	for _, arg := range req.Call.Arguments {
		if arg == "" {
			return deny(DenyActionMalformed, fmt.Sprintf("action for tool %q carries an empty argument", req.Call.Tool))
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	perm, registered := r.permissions[req.Call.Tool]
	if !registered {
		return deny(DenyToolUnregistered, fmt.Sprintf("tool %q is not registered in the allow-list", req.Call.Tool))
	}
	if !riskSatisfied(perm.MinimumRisk, req.RiskClass) {
		return deny(DenyRiskClassMismatch, fmt.Sprintf("tool %q requires run risk class %q or higher, run is assessed %q", req.Call.Tool, perm.MinimumRisk, req.RiskClass))
	}
	for _, arg := range req.Call.Arguments {
		if !containsString(perm.AllowedArguments, arg) {
			return deny(DenyArgumentNotPermitted, fmt.Sprintf("argument %q is not in the allow-list for tool %q", harness.Redact(arg), req.Call.Tool))
		}
	}
	for _, p := range req.Call.Paths {
		if !pathWithin(perm.AllowedPaths, p) {
			return deny(DenyPathNotPermitted, fmt.Sprintf("path %q is outside the permitted roots for tool %q", p, req.Call.Tool))
		}
	}
	for _, dest := range req.Call.NetworkDestinations {
		if !containsString(perm.AllowedNetworkDestinations, dest) {
			return deny(DenyNetworkNotPermitted, fmt.Sprintf("network destination %q is not in the allow-list for tool %q", dest, req.Call.Tool))
		}
	}
	if r.dispatcher == nil {
		return deny(DenyNoDispatcher, fmt.Sprintf("no dispatch boundary is configured for tool %q", req.Call.Tool))
	}
	return Decision{Allowed: true, Code: AllowWithinRegistry, Reason: fmt.Sprintf("tool %q is registered and within its allow-list", req.Call.Tool)}
}

// Execute authorizes a request, records the decision with its reason in the
// audit log, and only then delivers an allowed request to the dispatch
// boundary. A denial is a recorded outcome, not an error. The returned error
// is reserved for a dispatcher failure; the audit entry for the
// authorization decision is written before dispatch either way, and the
// dispatch's own evidence belongs to the boundary that produced it.
func (r *Registry) Execute(ctx context.Context, req Request) (Outcome, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	decision := r.Authorize(req)
	r.record(req, decision)
	if !decision.Allowed {
		return Outcome{Decision: decision}, nil
	}

	r.mu.Lock()
	dispatcher := r.dispatcher
	r.mu.Unlock()
	res, err := dispatcher.Dispatch(ctx, req.Call)
	outcome := Outcome{Decision: decision, Result: &res}
	if err != nil {
		return outcome, fmt.Errorf("tools: dispatch %q: %w", req.Call.Tool, err)
	}
	return outcome, nil
}

// Entries returns a copy of the recorded audit entries in order. Argument
// slices are copied too, so a consumer cannot rewrite stored evidence
// through a returned entry.
func (r *Registry) Entries() []AuditEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]AuditEntry, len(r.entries))
	for i, e := range r.entries {
		out[i] = e
		out[i].Arguments = copyStrings(e.Arguments)
	}
	return out
}

// record appends the decision for one request to the audit log. Arguments are
// redacted through harness.Redact before they are stored, so evidence never
// carries a secret-looking argument value.
func (r *Registry) record(req Request, d Decision) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, AuditEntry{
		OccurredAt: r.now(),
		TaskID:     req.TaskID,
		RunID:      req.RunID,
		Tool:       req.Call.Tool,
		Arguments:  redactArgs(req.Call.Arguments),
		Code:       d.Code,
		Reason:     d.Reason,
	})
}

// riskSatisfied matches a tool's minimum risk requirement against the run's
// assessed risk class: a tool that demands an elevated (human-approved)
// assessment never runs under a low one, a safer tool is usable under any
// approved assessment, and a prohibited or unknown run class satisfies
// nothing — the check fails closed.
func riskSatisfied(required, run harness.RiskClass) bool {
	switch run {
	case harness.RiskLow:
		return required == harness.RiskLow
	case harness.RiskElevated:
		return required == harness.RiskLow || required == harness.RiskElevated
	default:
		return false
	}
}

// pathWithin reports whether a requested path sits under one of the
// registered roots. It mirrors the harness policy's containment rules —
// requested paths are untrusted, so absolute paths and any cleaned form that
// escapes via ".." are denied, and roots match on path-segment boundaries —
// so this gate and the harness gate reject the same escapes. Roots are
// normalized at registration; "" is the repository-root sentinel.
func pathWithin(roots []string, requested string) bool {
	if requested == "" {
		return false
	}
	cleaned := path.Clean(requested)
	if path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") || cleaned == "." {
		return false
	}
	for _, root := range roots {
		if root == "" {
			return true
		}
		if cleaned == root || strings.HasPrefix(cleaned, root+"/") {
			return true
		}
	}
	return false
}

// cleanRoot normalizes one registered path root the way the harness policy
// normalizes requested paths: relative after cleaning and never ".."-escaping.
// "." is the repository-root sentinel and normalizes to "".
func cleanRoot(root string) (string, error) {
	if root == "" {
		return "", errors.New("root is empty")
	}
	cleaned := path.Clean(root)
	if path.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("root must stay relative to the repository")
	}
	if cleaned == "." {
		return "", nil
	}
	return cleaned, nil
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func redactArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = harness.Redact(a)
	}
	return out
}
