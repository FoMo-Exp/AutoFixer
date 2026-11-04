package sandbox

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// ErrIsolationUnavailable is returned when the host cannot provide the
// OS-level isolation one untrusted execution requires. Execution is blocked
// instead of running unisolated: a sandbox that is not there is not a
// sandbox.
var ErrIsolationUnavailable = errors.New("sandbox: OS-level isolation is unavailable for this execution")

// NetworkPolicy is the egress scope one isolated execution needs.
type NetworkPolicy struct {
	// DenyAll refuses every network connection. This is the policy for
	// untrusted tests and offline dependency installation.
	DenyAll bool
	// Destinations lists approved "host:port" egress endpoints. Isolation
	// backends that cannot enforce a destination list at the OS level
	// refuse the execution (fail closed) instead of allowing egress.
	Destinations []string
}

// EnforcedLimits carries the resource limits one execution is held to and
// the mechanism that enforces them: never merely declared, always enforced
// (see supervise.go) or the execution is refused. Wall-clock, output, and
// operation budgets are enforced as well (see Runner and OpLimits).
type EnforcedLimits struct {
	MaxMemoryMB   int `json:"max_memory_mb"`
	MaxCPUSeconds int `json:"max_cpu_seconds"`
	// Enforcement names how the caps are enforced on this platform:
	// "supervisor_kill", "supervisor_kill+rlimit_cpu", or "none" when no
	// cap is declared.
	Enforcement string `json:"enforcement"`
}

// IsolationRequest describes one untrusted execution's isolation scope.
type IsolationRequest struct {
	// Dir is the working directory the command runs in.
	Dir string
	// ControlDir is a private directory the backend may write control files
	// (such as a generated profile) into. It is deliberately not part of
	// Writable, so an untrusted child cannot rewrite its own profile.
	ControlDir string
	// Writable lists the absolute paths the process may write. Everything
	// else is read-only or denied; an empty list is refused.
	Writable []string
	// DenyRead lists absolute paths the process must never read: the
	// control-plane runtime directory, credential homes, and similar.
	DenyRead []string
	// Network is the egress policy.
	Network NetworkPolicy
	// Limits are the grant's resource caps; the enforcement mechanism in
	// force is recorded in the environment identity. Enforcement itself is
	// the runner's supervisor (see runCommand).
	Limits EnforcedLimits
	// MaxWallClockSeconds and OutputLimitBytes are the enforced runtime
	// budgets, recorded in the environment identity alongside the profile.
	MaxWallClockSeconds int
	OutputLimitBytes    int64
}

// EnvironmentIdentity binds one execution's result to the exact test
// environment it ran in: the OS backend, the digest of the isolation profile
// actually applied, the network policy enforced, the writable roles, and the
// limits in force. It never carries absolute workspace paths.
type EnvironmentIdentity struct {
	Platform            string         `json:"platform"`
	Backend             string         `json:"backend"`
	ProfileDigest       string         `json:"isolation_profile_digest"`
	Network             string         `json:"network"`
	Writable            []string       `json:"writable"`
	MaxWallClockSeconds int            `json:"max_wall_clock_seconds"`
	OutputLimitBytes    int64          `json:"output_limit_bytes"`
	EnforcedLimits      EnforcedLimits `json:"enforced_limits"`
}

// ExecutionDomain is the process-lifecycle guarantee an isolation backend can
// make for one untrusted execution. It is a property of the platform
// mechanism, not of a grant: either every process the execution creates is
// guaranteed to be gone when the execution ends, or it is not.
type ExecutionDomain string

const (
	// DomainComplete means the backend owns the whole execution domain: a
	// PID namespace, cgroup, or VM guarantees every descendant dies with the
	// execution and its usage stays aggregated inside the domain. A child
	// that forks, calls setsid, is reparented, and leaves the workspace is
	// still part of the domain.
	DomainComplete ExecutionDomain = "complete"
	// DomainBestEffort means the backend confines what a process can reach
	// but cannot guarantee the domain's lifecycle or aggregate accounting:
	// a descendant that forks, creates its own session, is reparented, and
	// changes its working directory between two observations leaves the
	// tracked set (macOS Seatbelt; there is no cgroup or PID namespace).
	// Untrusted execution is refused on such a backend instead of running
	// behind a containment claim it cannot meet (DAT-253).
	DomainBestEffort ExecutionDomain = "best_effort"
)

// ErrExecutionDomainIncomplete reports that no selected backend can guarantee
// a complete execution domain on this host. An untrusted execution is refused
// rather than run with best-effort lifecycle control whose escape window
// cannot be closed without privilege (DAT-253).
var ErrExecutionDomainIncomplete = errors.New("sandbox: no backend guarantees a complete execution domain")

// Isolator wraps one command in OS-level process/filesystem/network
// isolation. Wrap mutates the command in place and returns the identity that
// was applied; an error means the command must not run at all.
type Isolator interface {
	// Name is the backend identity ("seatbelt", "bwrap").
	Name() string
	// Available reports whether the backend can isolate on this host.
	Available() error
	// ExecutionDomain reports the process-lifecycle guarantee this backend
	// can make. Untrusted execution requires DomainComplete.
	ExecutionDomain() ExecutionDomain
	// Wrap applies the isolation and returns its environment identity.
	Wrap(cmd *exec.Cmd, req IsolationRequest) (EnvironmentIdentity, error)
}

// requireCompleteExecutionDomain refuses an execution whose backend cannot
// guarantee that every process it starts dies with it. The refusal wraps both
// ErrIsolationUnavailable (the existing 503 DSH_SANDBOX_UNAVAILABLE path) and
// ErrExecutionDomainIncomplete (the operator-facing reason).
func requireCompleteExecutionDomain(isolator Isolator) error {
	if isolator == nil {
		return fmt.Errorf("%w: %w: no isolation backend is configured",
			ErrIsolationUnavailable, ErrExecutionDomainIncomplete)
	}
	if domain := isolator.ExecutionDomain(); domain != DomainComplete {
		return fmt.Errorf("%w: %w: backend %q provides %q execution-domain containment",
			ErrIsolationUnavailable, ErrExecutionDomainIncomplete, isolator.Name(), domain)
	}
	return nil
}

// NewIsolator returns the OS-level isolation backend for this host. The
// backend still reports itself unavailable (and refuses Wrap) when its
// platform mechanism is missing.
func NewIsolator() Isolator { return platformIsolator() }

// validateIsolationRequest applies the checks every backend shares: the
// network policy must be one the backend can actually enforce, and the
// writable scope must be explicit.
func validateIsolationRequest(req IsolationRequest) error {
	if len(req.Network.Destinations) > 0 {
		// No backend here filters egress per destination at the OS level,
		// so a destination-scoped run is blocked rather than silently
		// widened to all or no network.
		return ErrIsolationUnavailable
	}
	if !req.Network.DenyAll {
		return ErrIsolationUnavailable
	}
	if req.Dir == "" {
		return errors.New("sandbox: isolation request requires a working directory")
	}
	if len(req.Writable) == 0 {
		return errors.New("sandbox: isolation request requires an explicit writable scope")
	}
	for _, writable := range req.Writable {
		if writable == "" || !filepath.IsAbs(writable) {
			return errors.New("sandbox: writable scope must name absolute paths")
		}
	}
	return nil
}

// isolationIdentity builds the identity record for an applied profile. The
// writable scope appears as sorted workspace roles (base names), never as
// absolute host paths.
func isolationIdentity(backend, profileDigest string, req IsolationRequest) EnvironmentIdentity {
	roles := make([]string, 0, len(req.Writable))
	seen := map[string]bool{}
	for _, writable := range req.Writable {
		role := filepath.Base(writable)
		if !seen[role] {
			seen[role] = true
			roles = append(roles, role)
		}
	}
	sort.Strings(roles)
	return EnvironmentIdentity{
		Platform:            runtime.GOOS + "/" + runtime.GOARCH,
		Backend:             backend,
		ProfileDigest:       "sha256:" + profileDigest,
		Network:             "denied",
		Writable:            roles,
		MaxWallClockSeconds: req.MaxWallClockSeconds,
		OutputLimitBytes:    req.OutputLimitBytes,
		EnforcedLimits: EnforcedLimits{
			MaxMemoryMB:   req.Limits.MaxMemoryMB,
			MaxCPUSeconds: req.Limits.MaxCPUSeconds,
			Enforcement:   enforcementFor(req.Limits),
		},
	}
}

// profileDigest hashes the exact isolation profile applied to one command,
// so a result can only ever claim the environment it actually ran in.
func profileDigest(profile []byte) string {
	sum := sha256.Sum256(profile)
	return hex.EncodeToString(sum[:])
}

// denyReadFragments normalizes the deny-read list for profile builders:
// non-empty absolute paths, sorted for a stable digest.
func denyReadFragments(req IsolationRequest) []string {
	out := make([]string, 0, len(req.DenyRead))
	seen := map[string]bool{}
	for _, p := range req.DenyRead {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, filepath.Clean(p))
	}
	sort.Strings(out)
	return out
}

// writableFragments normalizes the writable list for profile builders:
// non-empty absolute paths, sorted for a stable digest.
func writableFragments(req IsolationRequest) []string {
	out := make([]string, 0, len(req.Writable))
	seen := map[string]bool{}
	for _, p := range req.Writable {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, filepath.Clean(p))
	}
	sort.Strings(out)
	return out
}

// seatbeltQuote quotes a path for a seatbelt profile string literal with the
// escaping the profile language shares with Go string literals.
func seatbeltQuote(value string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		switch r {
		case '\\', '"':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
