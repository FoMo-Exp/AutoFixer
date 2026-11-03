// Package sandbox implements the FP-04 isolated execution surface: a
// one-time workspace per run, deny-by-default dispatch of commands, paths,
// and network destinations, grant-bounded wall-clock timeout and
// cancellation with workspace cleanup, and structured execution evidence.
//
// Permissions never originate here. Every dispatch is evaluated and recorded
// through the FP-03 policy output (harness.Run.EvaluateAndRecordAction), and
// the observed result is appended to the same append-only store through
// harness.Run.RecordExecutionOutcome. Missing scope means denied.
//
// Structured dispatch: registered read/search/edit operations run through
// the Tree gate (lexical and symlink containment, prohibited paths, edit
// scope by FP-01 path class) inside the materialized checkout, and registered
// test/dependency profiles run as OS-isolated processes (Seatbelt on macOS,
// bubblewrap on Linux) with no network, no host credentials, and writes
// confined to the workspace. When the isolation backend is missing the
// execution is blocked, never run unisolated. Every structured result binds
// the exact revision identity and — for test and dependency runs — the test
// environment identity (backend, profile digest, enforced budgets) into a
// tamper-evident record.
//
// The pilot's process tools (the M0 enum fixtures) keep their plain
// scrubbed-environment dispatch; they carry no untrusted code or arguments.
package sandbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

// Decision codes the sandbox records around FP-03's policy output.
const (
	// CodeExecutionStarted records approved -> running when the first
	// dispatch of an approved run begins.
	CodeExecutionStarted = "execution_started"
	// CodeExecutionTimedOut records an execution terminated by the
	// grant's wall-clock bound, and the run's transition to timed_out.
	CodeExecutionTimedOut = "execution_timed_out"
	// CodeExecutionCancelled records an execution terminated by caller
	// cancellation, and the run's transition to cancelled.
	CodeExecutionCancelled = "execution_cancelled"

	// Gate refusal codes: an in-grant dispatch the operation gate refused.
	// Each stops the run exactly as an out-of-grant dispatch does.
	CodePathEscapeDenied      = "path_escape_denied"
	CodeSymlinkEscapeDenied   = "symlink_escape_denied"
	CodeProhibitedPathDenied  = "prohibited_path_denied"
	CodeEditScopeDenied       = "edit_scope_denied"
	CodeOverprivilegedRequest = "overprivileged_request_denied"
	CodeGrantScopeExceeded    = "grant_scope_exceeded"
)

// ErrGrantScopeExceeded names a profile request whose real execution scope
// reaches outside the capability grant: a repository-wide suite or
// dependency run under a narrow grant, or a focused target beyond it.
var ErrGrantScopeExceeded = errors.New("sandbox: profile execution scope exceeds the granted paths")

const defaultOutputLimit = 1 << 20 // 1 MiB of retained output per execution

// defaultMaxInfraAttempts bounds sandbox-preparation retries from a pristine
// workspace. Once anything has changed, a failing sandbox blocks instead.
const defaultMaxInfraAttempts = 3

// Options carries runner configuration. The zero value is valid: the
// workspace is created in the system temp directory with the default output
// limit, and structured dispatch is blocked until a revision source and an
// isolation backend are available.
type Options struct {
	// WorkspaceRoot is the directory the one-time workspace is created
	// under. Empty means the system temp directory.
	WorkspaceRoot string
	// OutputLimit bounds how many bytes of output one execution retains
	// for its result and evidence digest; the full stream is still
	// consumed, and truncation is recorded. Zero or negative means
	// defaultOutputLimit.
	OutputLimit int64
	// RevisionSource materializes the pinned checkout structured
	// operations run against. Nil blocks structured dispatch.
	RevisionSource RevisionSource
	// DependencySource primes dependency caches from approved registries
	// before the isolated install phase. Nil blocks dependency profiles.
	DependencySource DependencySource
	// Profiles is the registered execution-profile vocabulary. Nil uses
	// DefaultExecProfiles.
	Profiles []ExecProfile
	// Isolator is the OS-level isolation backend. Nil uses NewIsolator.
	Isolator Isolator
	// DenyRead lists control-plane paths (runtime directory, boot token)
	// every untrusted execution must not read, on top of the built-in
	// credential denies.
	DenyRead []string
	// MaxInfraAttempts bounds sandbox-preparation retries from a pristine
	// workspace. Zero uses defaultMaxInfraAttempts.
	MaxInfraAttempts int
}

// DispatchKind selects which execution surface one invocation uses.
type DispatchKind int

const (
	// DispatchProcess runs a plain tool binary (the M0 enum fixtures).
	DispatchProcess DispatchKind = iota
	// DispatchRead runs a structured repository read.
	DispatchRead
	// DispatchSearch runs a structured repository search.
	DispatchSearch
	// DispatchEdit runs a structured repository edit.
	DispatchEdit
	// DispatchProfile runs a registered test or dependency profile under
	// OS-level isolation.
	DispatchProfile
)

// OpRequest is one structured file operation's payload.
type OpRequest struct {
	// Path is a repository-relative file (or search scope) path.
	Path string
	// Pattern is the search expression (RE2).
	Pattern string
	// Content is the edit payload.
	Content string
	// Limits bounds the operation; zero values take the defaults.
	Limits OpLimits
}

// ProcessRequest is one profile-driven execution request.
type ProcessRequest struct {
	// ProfileID is the registered profile identity.
	ProfileID string
	// Mode is the registered mode ("focused", "suite").
	Mode string
	// Target is the repository-relative test target.
	Target string
}

// Spec describes one tool invocation the runner is asked to perform. Every
// field beyond the tool identity is a declared scope the FP-03 policy
// evaluates; an unlisted or ungranted value is denied, never silently
// ignored. There is no per-spec timeout: the wall-clock bound comes only
// from the capability grant (and, for profiles, the profile ceiling).
type Spec struct {
	Tool                string
	Arguments           []string
	EvidenceArguments   []string
	Paths               []string
	NetworkDestinations []string
	// WantsPatch marks a repository-mutating intent, evaluated against the
	// grant's may_create_patch bit and the FP-01 path classes.
	WantsPatch bool
	// Kind selects the dispatch surface; zero is DispatchProcess.
	Kind DispatchKind
	// Op carries structured operation payloads.
	Op *OpRequest
	// Process carries profile-driven requests.
	Process *ProcessRequest
}

// GateRefusal is the operation gate's refusal of an in-grant dispatch: the
// path/symlink containment, prohibited-path, edit-scope, or profile
// vocabulary gate stopped the request. The run stops exactly as an
// out-of-grant dispatch does.
type GateRefusal struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

// Result is the outcome of one Execute call. A policy denial is not an
// error: it arrives here with Decision.Allowed false and the recorded
// decision code. A gate refusal arrives with Gate set. Errors are reserved
// for runner and control failures (closed runner, start failure, audit write
// failure, cleanup failure, unavailable sandbox).
type Result struct {
	// Decision is the FP-03 policy output the dispatch was evaluated
	// against, recorded in the evidence chain before anything ran.
	Decision harness.Decision
	// Gate is set when the operation gate refused an in-grant dispatch.
	Gate *GateRefusal
	// ExitStatus is the observed exit status, nil when no process ran.
	ExitStatus *int
	// Output is the redacted, retained output the execution produced.
	Output []byte
	// OutputDigest is the sha256 digest of Output, the value recorded in
	// the completion evidence.
	OutputDigest *harness.Digest
	// OutputBytes counts the full output stream before retention was
	// capped; OutputTruncated reports whether retention dropped bytes.
	OutputBytes     int64
	OutputTruncated bool
	// TimedOut reports termination by the grant's wall-clock bound; the
	// run transitions to timed_out and the workspace is destroyed.
	TimedOut bool
	// Canceled reports termination by caller cancellation; the run
	// transitions to cancelled and the workspace is destroyed.
	Canceled bool
	// ResourceExceeded names the granted resource cap that terminated the
	// execution ("memory", "cpu"), or "accounting" when enforcement itself
	// broke down mid-run and the execution was stopped rather than left to
	// run uncapped. A resource violation stops the run and revokes the
	// grant.
	ResourceExceeded string
	// Record binds a structured dispatch's result to the exact revision
	// and test environment it ran in. Nil for plain process tools.
	Record *ExecutionResult
}

// Runner executes permitted tool invocations for one harness run inside one
// one-time workspace. It is not safe for concurrent use; one runner drives
// one run's dispatch sequence.
type Runner struct {
	run         *harness.Run
	workspace   string
	outputLimit int64
	closed      bool
	closeErr    error

	revisionSource   RevisionSource
	dependencySource DependencySource
	profiles         []ExecProfile
	isolator         Isolator
	denyRead         []string
	maxInfraAttempts int

	tree       *Tree
	revision   *RevisionIdentity
	prepared   bool
	primedDeps map[string]bool
	mutated    bool
	uncertain  bool
}

// New creates the run's one-time workspace. The directory exists until
// Close, or until a timed-out or canceled execution destroys it.
func New(run *harness.Run, opts Options) (*Runner, error) {
	if run == nil {
		return nil, errors.New("sandbox: runner requires a harness run")
	}
	root := opts.WorkspaceRoot
	if root == "" {
		root = os.TempDir()
	}
	workspace, err := os.MkdirTemp(root, "autofixer-sandbox-")
	if err != nil {
		return nil, fmt.Errorf("sandbox: create one-time workspace: %w", err)
	}
	for _, sub := range []string{"tmp", "home", "ctl"} {
		if err := os.MkdirAll(filepath.Join(workspace, sub), 0o700); err != nil {
			os.RemoveAll(workspace)
			return nil, fmt.Errorf("sandbox: create workspace %s directory: %w", sub, err)
		}
	}
	limit := opts.OutputLimit
	if limit <= 0 {
		limit = defaultOutputLimit
	}
	profiles := opts.Profiles
	if profiles == nil {
		profiles = DefaultExecProfiles()
	}
	isolator := opts.Isolator
	if isolator == nil {
		isolator = NewIsolator()
	}
	attempts := opts.MaxInfraAttempts
	if attempts <= 0 {
		attempts = defaultMaxInfraAttempts
	}
	return &Runner{
		run:              run,
		workspace:        workspace,
		outputLimit:      limit,
		revisionSource:   opts.RevisionSource,
		dependencySource: opts.DependencySource,
		profiles:         profiles,
		isolator:         isolator,
		denyRead:         append([]string{}, opts.DenyRead...),
		maxInfraAttempts: attempts,
		primedDeps:       map[string]bool{},
	}, nil
}

// Workspace returns the workspace path. It exists until Close or a
// terminating execution removes it.
func (r *Runner) Workspace() string { return r.workspace }

// Execute dispatches one tool invocation inside the runner's workspace.
//
// The call first moves an approved run into running (the only state change
// the runner performs on its own), then asks the FP-03 policy for a
// decision, which is appended to the evidence chain before anything runs.
// A denied dispatch returns the recorded decision and touches no process.
// An allowed dispatch runs the tool through its dispatch surface — a plain
// process, a gated structured operation, or an OS-isolated registered
// profile — records the observed outcome as completion evidence, and on
// timeout or cancellation transitions the run and destroys the workspace.
func (r *Runner) Execute(ctx context.Context, spec Spec) (Result, error) {
	if r.closed {
		return Result{}, errors.New("sandbox: runner is closed; its one-time workspace is gone")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	// The first dispatch of an approved run enters `running`; every other
	// state change comes from FP-03's policy, stop conditions, or the
	// timeout/cancellation handling below.
	if r.run.State == harness.StateApproved {
		if err := r.run.Transition(harness.StateRunning, CodeExecutionStarted); err != nil {
			return Result{}, fmt.Errorf("sandbox: enter running: %w", err)
		}
	}

	// The touched paths are always part of the checked scope: the declared
	// path scope and the operation's own path both face the policy, so a
	// hostile request cannot check one path and touch another.
	paths := append([]string{}, spec.Paths...)
	if spec.Op != nil && spec.Op.Path != "" && spec.Op.Path != "." && !containsPath(paths, spec.Op.Path) {
		paths = append(paths, spec.Op.Path)
	}
	// Profile execution scope faces the grant too: the target and its
	// execution directory are checked as part of the action's path scope,
	// so a request cannot declare one directory and execute another.
	if spec.Process != nil && spec.Process.Target != "" {
		if profile, ok := ProfileFor(r.profiles, spec.Process.ProfileID); ok {
			if scope, treeWide := profile.ExecutionScope(spec.Process.Mode, spec.Process.Target); !treeWide {
				for _, p := range scope {
					if !containsPath(paths, p) {
						paths = append(paths, p)
					}
				}
			}
		}
	}
	req := harness.ActionRequest{
		Tool:                spec.Tool,
		Arguments:           append([]string{}, spec.Arguments...),
		RepositoryURL:       r.run.RepositoryURL,
		BaseSHA:             r.run.BaseSHA,
		Paths:               paths,
		NetworkDestinations: append([]string{}, spec.NetworkDestinations...),
		WantsPatch:          spec.WantsPatch,
	}
	if spec.EvidenceArguments != nil {
		req.EvidenceArguments = append([]string{}, spec.EvidenceArguments...)
	}

	// The FP-03 policy output is the only execution permission: the
	// decision (allow, or a per-scope denial with its reason and any stop
	// condition) is appended to the evidence chain here, before dispatch.
	decision := r.run.EvaluateAndRecordAction(req)
	result := Result{Decision: decision}
	if !decision.Allowed {
		return result, nil
	}

	switch spec.Kind {
	case DispatchRead, DispatchSearch, DispatchEdit:
		return r.executeOp(ctx, spec, req, result)
	case DispatchProfile:
		return r.executeProfile(ctx, spec, req, result)
	default:
		return r.executeProcess(ctx, spec, req, result)
	}
}

// executeProcess runs a plain tool binary with the scrubbed environment —
// the M0 enum fixtures, which carry no untrusted code or arguments.
func (r *Runner) executeProcess(ctx context.Context, spec Spec, req harness.ActionRequest, result Result) (Result, error) {
	binary, err := resolveTool(spec.Tool, toolPath())
	if err != nil {
		// The dispatch evidence exists; the runner refuses to guess a
		// binary the grant did not name exactly.
		return result, err
	}

	grant := r.run.Grant // non-nil: the policy just allowed this dispatch
	timeout := time.Duration(grant.MaxWallClockSeconds) * time.Second
	if remaining := time.Until(grant.ExpiresAt); remaining < timeout {
		timeout = remaining
	}
	execCtx, cancelExec := context.WithTimeout(ctx, timeout)
	defer cancelExec()

	cmd := exec.CommandContext(execCtx, binary, spec.Arguments...)
	cmd.Dir = r.workspace
	cmd.Env = childEnv(r.workspace)
	configureProcess(cmd)
	return r.runCommand(execCtx, ctx, cmd, req, result, nil, nil)
}

// executeOp runs one structured read/search/edit through the tree gate.
func (r *Runner) executeOp(ctx context.Context, spec Spec, req harness.ActionRequest, result Result) (Result, error) {
	if spec.Op == nil {
		return result, errors.New("sandbox: structured dispatch requires an operation payload")
	}
	if err := r.sandboxSetup(ctx); err != nil {
		return result, err
	}
	var (
		out        []byte
		actualArgs []string
		opErr      error
	)
	switch spec.Kind {
	case DispatchRead:
		read, err := r.tree.Read(spec.Op.Path, spec.Op.Limits)
		opErr = err
		out = read.Content
		actualArgs = []string{"read", spec.Op.Path}
	case DispatchSearch:
		search, err := r.tree.Search(spec.Op.Pattern, spec.Op.Path, spec.Op.Limits)
		opErr = err
		if opErr == nil {
			var b strings.Builder
			for _, hit := range search.Hits {
				fmt.Fprintf(&b, "%s:%d: %s\n", hit.Path, hit.Line, hit.Text)
			}
			if search.Truncated {
				b.WriteString("[sandbox: search results truncated]\n")
			}
			out = []byte(b.String())
		}
		actualArgs = []string{"search", spec.Op.Pattern}
	case DispatchEdit:
		edit, err := r.tree.Edit(spec.Op.Path, spec.Op.Content, r.run.Assessment.RiskClass, spec.Op.Limits)
		opErr = err
		if opErr == nil {
			r.mutated = true
			out = []byte(fmt.Sprintf("edited %s (%d bytes)", edit.Path, edit.Bytes))
		}
		actualArgs = []string{"edit", spec.Op.Path}
	}
	if opErr != nil {
		if isGateRefusal(opErr) {
			return r.gateRefusal(req, result, opErr, actualArgs)
		}
		return result, opErr
	}

	redacted := harness.Redact(string(out))
	digest := outputDigest([]byte(redacted))
	result.Output = []byte(redacted)
	result.OutputDigest = digest
	result.OutputBytes = int64(len(out))
	if err := r.run.RecordExecutionOutcome(req, harness.ExecutionOutcome{
		OutputDigest:    digest,
		ActualArguments: actualArgs,
	}); err != nil {
		r.uncertain = true
		return result, err
	}
	record, err := NewExecutionResult(ExecutionResultInput{
		Tool:         spec.Tool,
		Revision:     r.revision,
		OutputDigest: digest,
	})
	if err != nil {
		return result, err
	}
	result.Record = &record
	return result, nil
}

// executeProfile runs one registered test or dependency profile under
// OS-level isolation. The command line is built by the profile, never by the
// caller, and the result binds both the revision and the test environment
// identities.
func (r *Runner) executeProfile(ctx context.Context, spec Spec, req harness.ActionRequest, result Result) (Result, error) {
	if spec.Process == nil {
		return result, errors.New("sandbox: profile dispatch requires a process request")
	}
	profile, ok := ProfileFor(r.profiles, spec.Process.ProfileID)
	if !ok {
		return r.gateRefusal(req, result, fmt.Errorf("sandbox: profile %q is not registered", spec.Process.ProfileID),
			[]string{spec.Process.ProfileID})
	}
	argv, err := profile.Argv(spec.Process.Mode, spec.Process.Target)
	if err != nil {
		return r.gateRefusal(req, result, err, []string{spec.Process.ProfileID, spec.Process.Mode})
	}
	// The profile's real execution scope must fit the grant. Repository-wide
	// scope (suite, dependency preparation, root-level targets) needs a
	// repository-wide grant; nothing executes wider than what was granted.
	if _, treeWide := profile.ExecutionScope(spec.Process.Mode, spec.Process.Target); treeWide {
		if !harness.GrantCoversRoot(r.run.Grant.PermittedPaths) {
			return r.gateRefusal(req, result, ErrGrantScopeExceeded,
				[]string{spec.Process.ProfileID, spec.Process.Mode})
		}
	}
	if err := r.sandboxSetup(ctx); err != nil {
		return result, err
	}
	if profile.Kind == ProfileDependency {
		if err := r.primeDependencies(ctx, profile); err != nil {
			return result, err
		}
	}
	binary, err := resolveTool(profile.Command, toolPath())
	if err != nil {
		return result, err
	}

	grant := r.run.Grant
	timeout := time.Duration(grant.MaxWallClockSeconds) * time.Second
	if remaining := time.Until(grant.ExpiresAt); remaining < timeout {
		timeout = remaining
	}
	if profile.MaxWallClockSeconds > 0 {
		if ceiling := time.Duration(profile.MaxWallClockSeconds) * time.Second; ceiling < timeout {
			timeout = ceiling
		}
	}
	execCtx, cancelExec := context.WithTimeout(ctx, timeout)
	defer cancelExec()

	isoReq := IsolationRequest{
		Dir:                 filepath.Join(r.workspace, "repo"),
		ControlDir:          filepath.Join(r.workspace, "ctl"),
		Writable:            []string{filepath.Join(r.workspace, "repo"), filepath.Join(r.workspace, "tmp"), filepath.Join(r.workspace, "home")},
		DenyRead:            append([]string{}, r.denyRead...),
		Network:             NetworkPolicy{DenyAll: true},
		Limits:              EnforcedLimits{MaxMemoryMB: grant.ResourceLimits.MaxMemoryMB, MaxCPUSeconds: grant.ResourceLimits.MaxCPUSeconds},
		MaxWallClockSeconds: int(timeout / time.Second),
		OutputLimitBytes:    r.outputLimit,
	}
	if profile.OutputLimitBytes > 0 && profile.OutputLimitBytes < isoReq.OutputLimitBytes {
		isoReq.OutputLimitBytes = profile.OutputLimitBytes
	}

	var (
		cmd      *exec.Cmd
		identity EnvironmentIdentity
	)
	if err := r.infraRetry(func() error {
		cmd = exec.CommandContext(execCtx, binary, argv...)
		cmd.Dir = isoReq.Dir
		cmd.Env = childEnv(r.workspace)
		configureProcess(cmd)
		wrapped, wrapErr := r.isolator.Wrap(cmd, isoReq)
		if wrapErr != nil {
			return wrapErr
		}
		identity = wrapped
		return nil
	}); err != nil {
		// No process started: an unavailable sandbox blocks execution.
		return result, err
	}

	res, err := r.runCommand(execCtx, ctx, cmd, req, result, &identity, actualArgsFor(spec, argv))
	return res, err
}

// actualArgsFor is the profile-built command line recorded as the actual
// tool arguments in the completion evidence.
func actualArgsFor(spec Spec, argv []string) []string {
	return append([]string{spec.Process.ProfileID}, argv...)
}

// runCommand runs an already-wrapped command under the grant's wall clock
// and resource caps, records the completion evidence, and classifies
// timeout, cancellation, and resource-limit breaches. environment binds the
// test environment identity into the structured result when one applies.
func (r *Runner) runCommand(execCtx, ctx context.Context, cmd *exec.Cmd, req harness.ActionRequest, result Result, environment *EnvironmentIdentity, actualArgs []string) (Result, error) {
	out := &cappedBuffer{limit: r.outputLimit}
	cmd.Stdout = out
	cmd.Stderr = out

	// The grant's resource caps are enforced, never merely declared: an
	// execution whose caps cannot be enforced on this platform is refused
	// before anything starts (fail closed), never run uncapped.
	limits := resourceLimitsFrom(r.run.Grant)
	if limits.declared() && !usageAccountingAvailable() {
		return result, fmt.Errorf("%w: resource accounting is unavailable; the grant's limits cannot be enforced", ErrIsolationUnavailable)
	}

	startErr := cmd.Start()
	breach := ""
	if startErr == nil {
		supervisor, err := startSupervision(cmd, limits)
		if err != nil {
			killExecution(cmd)
			_ = cmd.Wait()
			return result, err
		}
		// The wait error only describes how the process ended, and an
		// ordinary failure (non-zero exit, external signal) is surfaced
		// in Result.ExitStatus, not as an Execute error; outcomes are
		// classified from the contexts below.
		_ = cmd.Wait()
		if supervisor != nil {
			breach = supervisor.stop()
		}
		if breach == "" {
			breach = signalBreach(cmd)
		}
	}
	// Outcomes come from the contexts, not the exit status: a tool that
	// exits non-zero completed under policy; a deadline or cancellation
	// terminates the run itself. The first context error wins, so a
	// parent cancellation is a cancellation even if the grant deadline
	// has also passed. A breach that raced the deadline is classified as
	// the termination that came first: the contexts.
	canceled := ctx.Err() != nil
	timedOut := !canceled && execCtx.Err() == context.DeadlineExceeded

	if startErr != nil && !canceled && !timedOut {
		// A real start failure: the dispatch evidence exists but no
		// tool ran, so there is no completion record to append.
		return result, fmt.Errorf("sandbox: start tool %q: %w", cmd.Path, startErr)
	}

	if startErr == nil {
		retained, total := out.result()
		output := harness.Redact(retained)
		truncated := total > int64(len(retained))
		if truncated {
			output += fmt.Sprintf("\n[sandbox: output truncated, retained %d of %d bytes]", len(retained), total)
		}
		result.Output = []byte(output)
		result.OutputBytes = total
		result.OutputTruncated = truncated
		digest := outputDigest(result.Output)
		result.OutputDigest = digest
		if ps := cmd.ProcessState; ps != nil {
			status := ps.ExitCode()
			result.ExitStatus = &status
		}
		outcomeCode := harness.AllowWithinGrant
		switch {
		case timedOut:
			outcomeCode = CodeExecutionTimedOut
		case canceled:
			outcomeCode = CodeExecutionCancelled
		case breach != "":
			outcomeCode = breachCode(breach)
		}
		if err := r.run.RecordExecutionOutcome(req, harness.ExecutionOutcome{
			ExitStatus:      result.ExitStatus,
			OutputDigest:    digest,
			Code:            outcomeCode,
			ActualArguments: actualArgs,
		}); err != nil {
			// The process ran but its outcome cannot be evidenced:
			// later sandbox retries must not paper over the unknown.
			r.uncertain = true
			return result, err
		}
		if r.revision != nil {
			record, err := NewExecutionResult(ExecutionResultInput{
				Tool:             req.Tool,
				Revision:         r.revision,
				Environment:      environment,
				ExitStatus:       result.ExitStatus,
				OutputDigest:     digest,
				TimedOut:         timedOut,
				Canceled:         canceled,
				ResourceExceeded: breach,
			})
			if err != nil {
				return result, err
			}
			result.Record = &record
		}
	}
	result.TimedOut = timedOut
	result.Canceled = canceled
	result.ResourceExceeded = breach
	if startErr == nil {
		r.mutated = true
	}

	var errs []error
	switch {
	case timedOut && r.run.State == harness.StateRunning:
		if err := r.run.Transition(harness.StateTimedOut, CodeExecutionTimedOut); err != nil {
			// A timeout that cannot be evidenced must not leave
			// dispatch open: revoke the grant before surfacing the
			// control failure.
			r.run.Revoked = true
			errs = append(errs, err)
		}
	case canceled && r.run.State == harness.StateRunning:
		if err := r.run.Transition(harness.StateCancelled, CodeExecutionCancelled); err != nil {
			r.run.Revoked = true
			errs = append(errs, err)
		}
	case breach != "" && !timedOut && !canceled && r.run.State == harness.StateRunning:
		// A resource violation stops the run and revokes the grant: the
		// execution exceeded what it was allowed to consume, or its caps
		// could no longer be enforced at all.
		r.run.Revoked = true
		if err := r.run.Transition(harness.StateStopped, breachCode(breach)); err != nil {
			errs = append(errs, err)
		}
	}
	if timedOut || canceled || (breach != "" && !timedOut && !canceled) {
		// The one-time environment dies with the terminated execution;
		// the evidence lives in the event store, never in the workspace.
		if err := r.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return result, errors.Join(errs...)
	}
	return result, nil
}

// resourceLimitsFrom derives the enforced caps from the grant's declared
// resource limits.
func resourceLimitsFrom(grant *harness.CapabilityGrant) resourceLimits {
	var limits resourceLimits
	if grant != nil {
		if mb := grant.ResourceLimits.MaxMemoryMB; mb > 0 {
			limits.MemoryBytes = int64(mb) << 20
		}
		if cpu := grant.ResourceLimits.MaxCPUSeconds; cpu > 0 {
			limits.CPUSeconds = int64(cpu)
		}
	}
	return limits
}

// startSupervision pins the grant's resource caps on a started execution:
// the kernel-hard CPU cap where the platform has one, and the kill-on-breach
// supervisor over the execution domain. A nil supervisor with a nil error
// means no cap is declared and nothing needs enforcing.
func startSupervision(cmd *exec.Cmd, limits resourceLimits) (*limitSupervisor, error) {
	if !limits.declared() {
		return nil, nil
	}
	if err := applyKernelLimits(cmd.Process.Pid, limits); err != nil {
		return nil, fmt.Errorf("sandbox: pin kernel resource limits on %q: %w", cmd.Path, err)
	}
	supervisor, err := newLimitSupervisor(cmd.Process.Pid, limits, supervisorInterval, platformUsage, func() { killExecution(cmd) })
	if err != nil {
		return nil, fmt.Errorf("sandbox: supervise resource limits on %q: %w", cmd.Path, err)
	}
	supervisor.start()
	return supervisor, nil
}

// killExecution removes a running execution's whole supervision domain: its
// process group and every descendant, including children that started their
// own session to escape the group.
func killExecution(cmd *exec.Cmd) {
	if cmd.Process != nil {
		killDomain(cmd.Process.Pid)
	}
	if cmd.Cancel != nil {
		_ = cmd.Cancel()
	}
}

// breachCode maps a resource breach kind to its evidence code.
func breachCode(breach string) string {
	if breach == BreachAccounting {
		return CodeExecutionUnenforcedLimit
	}
	return CodeExecutionResourceExceeded
}

// gateRefusal records the operation gate's refusal of an in-grant dispatch
// as completion evidence and stops the run exactly as an out-of-grant
// dispatch does: the contract requires a stop and a revoked grant for
// prohibited paths and out-of-scope attempts.
func (r *Runner) gateRefusal(req harness.ActionRequest, result Result, refusal error, actualArgs []string) (Result, error) {
	code := gateCode(refusal)
	reason := harness.Redact(refusal.Error())
	digest := outputDigest([]byte(reason))
	if err := r.run.RecordExecutionOutcome(req, harness.ExecutionOutcome{
		OutputDigest:    digest,
		Code:            code,
		ActualArguments: actualArgs,
	}); err != nil {
		r.uncertain = true
		return result, err
	}
	result.Gate = &GateRefusal{Code: code, Reason: reason}
	result.Output = []byte(reason)
	result.OutputDigest = digest
	result.OutputBytes = int64(len(reason))
	r.run.Revoked = true
	if harness.CanTransition(r.run.State, harness.StateStopped) {
		if err := r.run.Transition(harness.StateStopped, harness.StopCodeOutOfGrant); err != nil {
			return result, err
		}
	}
	if err := r.Close(); err != nil {
		return result, err
	}
	return result, nil
}

// isGateRefusal reports whether an operation error is a gate refusal (a
// scope violation) rather than a control or I/O failure.
func isGateRefusal(err error) bool {
	return errors.Is(err, ErrPathEscape) || errors.Is(err, ErrSymlinkEscape) ||
		errors.Is(err, ErrProhibitedPath) || errors.Is(err, ErrEditForbidden) ||
		errors.Is(err, ErrLimitExceeded) || errors.Is(err, ErrGrantScopeExceeded)
}

// containsPath reports whether list already names path.
func containsPath(list []string, path string) bool {
	for _, item := range list {
		if item == path {
			return true
		}
	}
	return false
}

// gateCode maps an operation refusal to its evidence code.
func gateCode(err error) string {
	switch {
	case errors.Is(err, ErrPathEscape):
		return CodePathEscapeDenied
	case errors.Is(err, ErrSymlinkEscape):
		return CodeSymlinkEscapeDenied
	case errors.Is(err, ErrProhibitedPath):
		return CodeProhibitedPathDenied
	case errors.Is(err, ErrEditForbidden):
		return CodeEditScopeDenied
	case errors.Is(err, ErrGrantScopeExceeded):
		return CodeGrantScopeExceeded
	default:
		return CodeOverprivilegedRequest
	}
}

// sandboxSetup materializes the pinned checkout the structured operations
// run against. It runs inside the bounded infra retry: a failing sandbox is
// retried only while the workspace has no changes that could be left in an
// uncertain state.
func (r *Runner) sandboxSetup(ctx context.Context) error {
	return r.infraRetry(func() error {
		if r.prepared {
			return nil
		}
		if r.revisionSource == nil {
			return errors.New("sandbox: no revision source is configured; structured dispatch is blocked")
		}
		repoDir := filepath.Join(r.workspace, "repo")
		if err := os.RemoveAll(repoDir); err != nil {
			return err
		}
		if err := os.MkdirAll(repoDir, 0o755); err != nil {
			return err
		}
		identity, err := r.revisionSource.Materialize(ctx, repoDir, r.run.RepositoryURL, r.run.BaseSHA)
		if err != nil {
			return err
		}
		if !sameRevision(identity, r.run.RepositoryURL, r.run.BaseSHA) {
			return fmt.Errorf("sandbox: materialized revision %s@%s does not match the run's base", identity.RepositoryURL, identity.BaseSHA)
		}
		tree, err := OpenTree(repoDir)
		if err != nil {
			return err
		}
		r.tree = tree
		r.revision = &identity
		r.prepared = true
		return nil
	})
}

// primeDependencies prepares one dependency profile's cache from the
// approved dependency source, once per profile and run.
func (r *Runner) primeDependencies(ctx context.Context, profile ExecProfile) error {
	return r.infraRetry(func() error {
		if r.primedDeps[profile.ID] {
			return nil
		}
		if r.dependencySource == nil {
			return errors.New("sandbox: no dependency source is configured; dependency profiles are blocked")
		}
		layout := DependencyLayout{
			RepoDir: filepath.Join(r.workspace, "repo"),
			HomeDir: filepath.Join(r.workspace, "home"),
		}
		if err := r.dependencySource.Prime(ctx, layout, profile); err != nil {
			return err
		}
		r.primedDeps[profile.ID] = true
		r.mutated = true
		return nil
	})
}

// infraRetry runs one sandbox-infrastructure step with bounded retries. A
// failing sandbox is retried only while the workspace has no changes at all
// (the conservative reading of "no uncertain changes"): once anything has
// changed, the first failure blocks execution instead of retrying into
// uncertainty.
func (r *Runner) infraRetry(fn func() error) error {
	attempts := r.maxInfraAttempts
	if r.mutated || r.uncertain {
		attempts = 1
	}
	var lastErr error
	for i := 0; i < attempts; i++ {
		if err := fn(); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

// sameRevision reports whether a materialized identity matches the run's
// pinned revision, allowing abbreviated and full commit ids to compare.
func sameRevision(identity RevisionIdentity, repositoryURL, baseSHA string) bool {
	if identity.RepositoryURL != repositoryURL {
		return false
	}
	return strings.HasPrefix(identity.BaseSHA, baseSHA) || strings.HasPrefix(baseSHA, identity.BaseSHA)
}

// outputDigest hashes one retained output for the completion evidence.
func outputDigest(output []byte) *harness.Digest {
	sum := sha256.Sum256(output)
	return &harness.Digest{
		Algorithm: harness.DigestAlgorithmSHA256,
		Value:     hex.EncodeToString(sum[:]),
	}
}

// Close removes the one-time workspace. It deletes only the directory New
// created for this runner, is idempotent, and returns the first close error
// on repeated calls. After Close the runner refuses further dispatch.
func (r *Runner) Close() error {
	if r.closed {
		return r.closeErr
	}
	r.closed = true
	if err := os.RemoveAll(r.workspace); err != nil {
		r.closeErr = fmt.Errorf("sandbox: remove one-time workspace: %w", err)
	}
	return r.closeErr
}

// childEnv builds the child environment from an explicit allowlist: nothing
// from the parent environment is inherited, so credentials, SSH agent,
// proxies, and cloud variables are absent by default. HOME and TMPDIR point
// into writable workspace roles, so a tool that resolves "~" or a temp path
// stays inside the one-time directory.
func childEnv(workspace string) []string {
	return []string{
		"PATH=" + toolPath(),
		"HOME=" + filepath.Join(workspace, "home"),
		"TMPDIR=" + filepath.Join(workspace, "tmp"),
		"LANG=C",
	}
}

// resolveTool maps a permitted tool identity to a binary the sandbox can
// prove: an absolute identity is used exactly as named, a bare name is
// searched only on the sandbox PATH, and a relative path the runner cannot
// anchor is refused rather than guessed.
func resolveTool(tool, pathValue string) (string, error) {
	if tool == "" {
		return "", errors.New("sandbox: tool identity is empty")
	}
	if filepath.IsAbs(tool) {
		return tool, nil
	}
	if strings.ContainsRune(tool, '/') || strings.ContainsRune(tool, os.PathSeparator) {
		return "", fmt.Errorf("sandbox: tool identity %q must be absolute or a bare name on the sandbox PATH", tool)
	}
	for _, dir := range filepath.SplitList(pathValue) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, tool)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("sandbox: tool %q not found on the sandbox PATH", tool)
}

// cappedBuffer keeps at most limit bytes of output while counting the full
// stream, so a runaway tool cannot grow memory without bound. os/exec
// guarantees at most one goroutine writes to it at a time when it is
// assigned to both Stdout and Stderr.
type cappedBuffer struct {
	buf   bytes.Buffer
	limit int64
	total int64
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.total += int64(len(p))
	if room := b.limit - int64(b.buf.Len()); room > 0 {
		if int64(len(p)) < room {
			room = int64(len(p))
		}
		b.buf.Write(p[:room])
	}
	return len(p), nil
}

// result returns the retained raw output and the full stream size.
func (b *cappedBuffer) result() (string, int64) {
	return b.buf.String(), b.total
}
