// Package sandbox implements the FP-04 minimal isolated sandbox runner: a
// one-time execution workspace per run, deny-by-default dispatch of
// commands, paths, and network destinations, grant-bounded wall-clock
// timeout and cancellation with workspace cleanup, and structured execution
// evidence.
//
// Permissions never originate here. Every dispatch is evaluated and recorded
// through the FP-03 policy output (harness.Run.EvaluateAndRecordAction), and
// the observed result is appended to the same append-only store through
// harness.Run.RecordExecutionOutcome. Missing scope means denied.
//
// Isolation boundary: commands run with their working directory inside a
// per-run workspace created under Options.WorkspaceRoot, and with a
// scrubbed environment built from an explicit allowlist — a fixed system
// PATH, HOME and TMPDIR redirected into the workspace, and no inherited
// credentials, SSH agent, proxy, or cloud variables. Declared paths and
// network destinations are policy-enforced and every denial is evidenced.
// The pilot does not attempt OS-level syscall sandboxing: egress a child
// process attempts outside its declared, granted destinations cannot be
// blocked on a stock host, so the controls here are the deny-by-default
// dispatch surface, the credential-free environment, and the evidence trail.
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
)

const defaultOutputLimit = 1 << 20 // 1 MiB of retained output per execution

// Options carries runner configuration. The zero value is valid: the
// workspace is created in the system temp directory with the default output
// limit.
type Options struct {
	// WorkspaceRoot is the directory the one-time workspace is created
	// under. Empty means the system temp directory.
	WorkspaceRoot string
	// OutputLimit bounds how many bytes of output one execution retains
	// for its result and evidence digest; the full stream is still
	// consumed, and truncation is recorded. Zero or negative means
	// defaultOutputLimit.
	OutputLimit int64
}

// Spec describes one tool invocation the runner is asked to perform. Every
// field beyond the tool identity is a declared scope the FP-03 policy
// evaluates; an unlisted or ungranted value is denied, never silently
// ignored. There is no per-spec timeout: the wall-clock bound comes only
// from the capability grant.
type Spec struct {
	Tool                string
	Arguments           []string
	Paths               []string
	NetworkDestinations []string
}

// Result is the outcome of one Execute call. A policy denial is not an
// error: it arrives here with Decision.Allowed false and the recorded
// decision code. Errors are reserved for runner and control failures
// (closed runner, start failure, audit write failure, cleanup failure).
type Result struct {
	// Decision is the FP-03 policy output the dispatch was evaluated
	// against, recorded in the evidence chain before anything ran.
	Decision harness.Decision
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
	if err := os.MkdirAll(filepath.Join(workspace, "tmp"), 0o700); err != nil {
		os.RemoveAll(workspace)
		return nil, fmt.Errorf("sandbox: create workspace temp directory: %w", err)
	}
	limit := opts.OutputLimit
	if limit <= 0 {
		limit = defaultOutputLimit
	}
	return &Runner{run: run, workspace: workspace, outputLimit: limit}, nil
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
// An allowed dispatch runs the tool with the grant's wall-clock bound as
// its deadline, records the observed exit status and redacted output digest
// as completion evidence, and on timeout or cancellation also transitions
// the run to timed_out or cancelled and destroys the one-time workspace.
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

	req := harness.ActionRequest{
		Tool:                spec.Tool,
		Arguments:           append([]string{}, spec.Arguments...),
		RepositoryURL:       r.run.RepositoryURL,
		BaseSHA:             r.run.BaseSHA,
		Paths:               append([]string{}, spec.Paths...),
		NetworkDestinations: append([]string{}, spec.NetworkDestinations...),
	}

	// The FP-03 policy output is the only execution permission: the
	// decision (allow, or a per-scope denial with its reason and any stop
	// condition) is appended to the evidence chain here, before dispatch.
	decision := r.run.EvaluateAndRecordAction(req)
	result := Result{Decision: decision}
	if !decision.Allowed {
		return result, nil
	}

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
	out := &cappedBuffer{limit: r.outputLimit}
	// The same writer for both streams: os/exec serializes writes from
	// equal writers, so stdout and stderr interleave safely in one buffer.
	cmd.Stdout = out
	cmd.Stderr = out

	startErr := cmd.Start()
	if startErr == nil {
		// The wait error only describes how the process ended, and an
		// ordinary failure (non-zero exit, external signal) is surfaced
		// in Result.ExitStatus, not as an Execute error; outcomes are
		// classified from the contexts below.
		_ = cmd.Wait()
	}
	// Outcomes come from the contexts, not the exit status: a tool that
	// exits non-zero completed under policy; a deadline or cancellation
	// terminates the run itself. The first context error wins, so a
	// parent cancellation is a cancellation even if the grant deadline
	// has also passed.
	canceled := ctx.Err() != nil
	timedOut := !canceled && execCtx.Err() == context.DeadlineExceeded

	if startErr != nil && !canceled && !timedOut {
		// A real start failure: the dispatch evidence exists but no
		// tool ran, so there is no completion record to append.
		return result, fmt.Errorf("sandbox: start tool %q: %w", spec.Tool, startErr)
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
		sum := sha256.Sum256(result.Output)
		digest := &harness.Digest{
			Algorithm: harness.DigestAlgorithmSHA256,
			Value:     hex.EncodeToString(sum[:]),
		}
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
		}
		if err := r.run.RecordExecutionOutcome(req, harness.ExecutionOutcome{
			ExitStatus:   result.ExitStatus,
			OutputDigest: digest,
			Code:         outcomeCode,
		}); err != nil {
			return result, err
		}
	}
	result.TimedOut = timedOut
	result.Canceled = canceled

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
	}
	if timedOut || canceled {
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
// into the workspace, so a tool that resolves "~" or a temp path stays
// inside the one-time directory.
func childEnv(workspace string) []string {
	return []string{
		"PATH=" + toolPath(),
		"HOME=" + workspace,
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
