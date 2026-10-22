//go:build unix

package sandbox_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

const (
	testRepoURL = "https://github.com/Luthiel/AutoFixer.git"
	testBaseSHA = "abc123"
)

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// newApprovedRun builds a low-risk run with an issued grant, using real
// timestamps so the FP-03 policy's expiry check applies as in production.
func newApprovedRun(t *testing.T, tools []harness.PermittedTool, paths, network []string, wallSeconds int) (*harness.Run, *harness.EventStore) {
	t.Helper()
	store := harness.NewEventStore()
	assessment, err := harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID:             "task-fp04",
		RunID:              "run-fp04",
		AssessedAt:         time.Now().UTC().Truncate(time.Second),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/task-fp04",
	}, harness.RiskLow, harness.DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatalf("NewRiskAssessment: %v", err)
	}
	run, err := harness.NewRun(harness.RunConfig{
		TaskID:            "task-fp04",
		RunID:             "run-fp04",
		IssueID:           "DAT-172",
		ActorIdentity:     "human:owner-1",
		ExecutionIdentity: "agent:sandbox-1",
		RepositoryURL:     testRepoURL,
		BaseSHA:           testBaseSHA,
	}, assessment, store)
	if err != nil {
		t.Fatalf("NewRun: %v", err)
	}
	now := time.Now().UTC()
	err = run.Approve(harness.GrantParams{
		TaskID:                 "task-fp04",
		RunID:                  "run-fp04",
		IssuedAt:               now.Add(-time.Minute),
		ExpiresAt:              now.Add(time.Hour),
		CapabilityGrantVersion: "grant-1",
		RepositoryURL:          testRepoURL,
		BaseSHA:                testBaseSHA,
		PermittedPaths:         paths,
		PermittedTools:         tools,
		NetworkDestinations:    network,
		MaxWallClockSeconds:    wallSeconds,
	})
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
	if run.State != harness.StateApproved {
		t.Fatalf("state = %q, want %q", run.State, harness.StateApproved)
	}
	return run, store
}

func newRunner(t *testing.T, run *harness.Run) (*sandbox.Runner, string) {
	t.Helper()
	runner, err := sandbox.New(run, sandbox.Options{WorkspaceRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ws := runner.Workspace()
	t.Cleanup(func() { runner.Close() })
	return runner, ws
}

func eventCodes(store *harness.EventStore, runID string) []string {
	var codes []string
	for _, e := range store.Events(runID) {
		code := ""
		if e.DecisionOrStopCode != nil {
			code = *e.DecisionOrStopCode
		}
		codes = append(codes, e.EventType+":"+code)
	}
	return codes
}

func requireEventCode(t *testing.T, store *harness.EventStore, runID, eventType, code string) {
	t.Helper()
	for _, e := range store.Events(runID) {
		if e.EventType == eventType && e.DecisionOrStopCode != nil && *e.DecisionOrStopCode == code {
			return
		}
	}
	t.Fatalf("no %s event with code %q; events: %v", eventType, code, eventCodes(store, runID))
}

func TestExecuteAllowedRunsInWorkspaceAndRecordsEvidence(t *testing.T) {
	script := "printf done > out.txt; echo hello token=abc123"
	run, store := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", script}}},
		[]string{"."}, nil, 600)
	runner, ws := newRunner(t, run)

	res, err := runner.Execute(context.Background(), sandbox.Spec{
		Tool:      "/bin/sh",
		Arguments: []string{"-c", script},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Decision.Allowed {
		t.Fatalf("decision = %+v, want allowed", res.Decision)
	}
	if res.ExitStatus == nil || *res.ExitStatus != 0 {
		t.Fatalf("exit status = %v, want 0", res.ExitStatus)
	}
	if res.TimedOut || res.Canceled {
		t.Errorf("TimedOut=%v Canceled=%v, want both false", res.TimedOut, res.Canceled)
	}

	// The command ran inside the one-time workspace: cwd is the workspace.
	wrote, err := os.ReadFile(filepath.Join(ws, "out.txt"))
	if err != nil {
		t.Fatalf("workspace file: %v", err)
	}
	if string(wrote) != "done" {
		t.Errorf("workspace file = %q, want %q", wrote, "done")
	}

	// Output is redacted before it reaches the result or the digest.
	want := "hello token=[REDACTED]\n"
	if string(res.Output) != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
	if res.OutputDigest == nil || res.OutputDigest.Value != sha256Hex(want) {
		t.Errorf("digest = %+v, want sha256 of %q", res.OutputDigest, want)
	}
	if res.OutputBytes != int64(len("hello token=abc123\n")) {
		t.Errorf("OutputBytes = %d, want %d", res.OutputBytes, len("hello token=abc123\n"))
	}

	// Evidence: start transition, dispatch, completion — chained and
	// verifiable.
	events := store.Events(run.RunID)
	if len(events) != 4 {
		t.Fatalf("events = %d (%v), want 4", len(events), eventCodes(store, run.RunID))
	}
	if events[0].EventType != harness.EventTypeStateTransition ||
		events[0].ResultingState != harness.StateApproved {
		t.Errorf("event 0 = %+v, want approved transition", events[0])
	}
	if events[1].EventType != harness.EventTypeStateTransition ||
		events[1].PriorState != harness.StateApproved || events[1].ResultingState != harness.StateRunning {
		t.Errorf("event 1 = %+v, want approved -> running transition", events[1])
	}
	if events[2].ExitStatus != nil || events[2].OutputDigest != nil {
		t.Errorf("dispatch event must carry null exit/digest, got %+v", events[2])
	}
	if events[3].ExitStatus == nil || *events[3].ExitStatus != 0 {
		t.Errorf("completion exit = %v, want 0", events[3].ExitStatus)
	}
	if events[3].OutputDigest == nil || events[3].OutputDigest.Value != sha256Hex(want) {
		t.Errorf("completion digest = %+v, want sha256 of redacted output", events[3].OutputDigest)
	}
	if err := store.VerifyChain(run.RunID); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
	if run.State != harness.StateRunning {
		t.Errorf("state = %q, want %q", run.State, harness.StateRunning)
	}

	// Cleanup: Close removes exactly the one-time workspace.
	if err := runner.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(ws); !os.IsNotExist(err) {
		t.Errorf("workspace still exists after Close (stat err = %v)", err)
	}
}

func TestExecuteDeniesUnpermittedNetworkAndStopsRun(t *testing.T) {
	script := "true"
	run, store := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", script}}},
		[]string{"."}, nil /* no network destination is granted */, 600)
	runner, _ := newRunner(t, run)

	res, err := runner.Execute(context.Background(), sandbox.Spec{
		Tool:                "/bin/sh",
		Arguments:           []string{"-c", script},
		NetworkDestinations: []string{"exfil.attacker.example"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Decision.Allowed {
		t.Fatal("unpermitted network destination must be denied")
	}
	if res.Decision.Code != harness.DenyNetworkNotPermitted {
		t.Errorf("deny code = %q, want %q", res.Decision.Code, harness.DenyNetworkNotPermitted)
	}
	if res.ExitStatus != nil {
		t.Errorf("exit status = %v, want nil: no process may run after a denial", res.ExitStatus)
	}

	// The reason is recorded, and the out-of-grant stop condition fired.
	if run.State != harness.StateStopped {
		t.Errorf("state = %q, want %q after out-of-grant dispatch", run.State, harness.StateStopped)
	}
	requireEventCode(t, store, run.RunID, harness.EventTypeToolInvocation, harness.DenyNetworkNotPermitted)
	requireEventCode(t, store, run.RunID, harness.EventTypeStateTransition, harness.StopCodeOutOfGrant)
	if err := store.VerifyChain(run.RunID); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}

	// Further dispatch stays blocked and is itself evidenced.
	res2, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "/bin/sh", Arguments: []string{"-c", script}})
	if err != nil {
		t.Fatalf("second Execute: %v", err)
	}
	if res2.Decision.Allowed || res2.Decision.Code != harness.DenyGrantRevoked {
		t.Errorf("second decision = %+v, want denied %q", res2.Decision, harness.DenyGrantRevoked)
	}
	requireEventCode(t, store, run.RunID, harness.EventTypeToolInvocation, harness.DenyGrantRevoked)
}

func TestExecuteDeniesHostSensitivePaths(t *testing.T) {
	cases := []struct {
		name string
		path string
	}{
		{name: "absolute system path", path: "/etc/passwd"},
		{name: "parent escape to home keys", path: "../../.ssh/id_rsa"},
		{name: "nested parent escape", path: "harness/../../../root/.ssh/authorized_keys"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			script := "true"
			run, store := newApprovedRun(t,
				[]harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", script}}},
				[]string{"harness"}, nil, 600)
			runner, _ := newRunner(t, run)

			res, err := runner.Execute(context.Background(), sandbox.Spec{
				Tool:      "/bin/sh",
				Arguments: []string{"-c", script},
				Paths:     []string{tc.path},
			})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Decision.Allowed {
				t.Fatalf("path %q must be denied", tc.path)
			}
			if res.Decision.Code != harness.DenyPathNotPermitted {
				t.Errorf("deny code = %q, want %q", res.Decision.Code, harness.DenyPathNotPermitted)
			}
			if res.ExitStatus != nil {
				t.Errorf("exit status = %v, want nil: no process may run after a denial", res.ExitStatus)
			}
			requireEventCode(t, store, run.RunID, harness.EventTypeToolInvocation, harness.DenyPathNotPermitted)
			if run.State != harness.StateStopped {
				t.Errorf("state = %q, want %q", run.State, harness.StateStopped)
			}
		})
	}
}

func TestExecuteTimeoutTerminatesCleansAndPreservesEvidence(t *testing.T) {
	run, store := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "/bin/sleep", AllowedArguments: []string{"10"}}},
		[]string{"."}, nil, 1 /* one second of wall clock */)
	runner, ws := newRunner(t, run)

	start := time.Now()
	res, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "/bin/sleep", Arguments: []string{"10"}})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.TimedOut || res.Canceled {
		t.Fatalf("TimedOut=%v Canceled=%v, want timeout", res.TimedOut, res.Canceled)
	}
	if elapsed >= 5*time.Second {
		t.Errorf("execution ran %v, want termination near the 1s grant bound", elapsed)
	}
	if res.ExitStatus == nil || *res.ExitStatus != -1 {
		t.Errorf("exit status = %v, want -1 (killed)", res.ExitStatus)
	}
	if res.OutputDigest == nil || res.OutputDigest.Value != sha256Hex("") {
		t.Errorf("digest = %+v, want sha256 of empty output", res.OutputDigest)
	}

	if run.State != harness.StateTimedOut {
		t.Errorf("state = %q, want %q", run.State, harness.StateTimedOut)
	}
	requireEventCode(t, store, run.RunID, harness.EventTypeToolInvocation, sandbox.CodeExecutionTimedOut)
	requireEventCode(t, store, run.RunID, harness.EventTypeStateTransition, sandbox.CodeExecutionTimedOut)
	if err := store.VerifyChain(run.RunID); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}

	// The one-time environment is destroyed with the terminated execution.
	if _, err := os.Stat(ws); !os.IsNotExist(err) {
		t.Errorf("workspace still exists after timeout (stat err = %v)", err)
	}
	// The closed runner refuses further dispatch.
	if _, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "/bin/sleep", Arguments: []string{"10"}}); err == nil {
		t.Error("Execute after timeout cleanup: err = nil, want closed-runner error")
	}
}

func TestExecuteCancelTerminatesCleansAndPreservesEvidence(t *testing.T) {
	run, store := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "/bin/sleep", AllowedArguments: []string{"10"}}},
		[]string{"."}, nil, 600)
	runner, ws := newRunner(t, run)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	time.AfterFunc(100*time.Millisecond, cancel)

	start := time.Now()
	res, err := runner.Execute(ctx, sandbox.Spec{Tool: "/bin/sleep", Arguments: []string{"10"}})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Canceled || res.TimedOut {
		t.Fatalf("Canceled=%v TimedOut=%v, want cancellation", res.Canceled, res.TimedOut)
	}
	if elapsed >= 5*time.Second {
		t.Errorf("execution ran %v, want termination shortly after cancellation", elapsed)
	}
	if res.ExitStatus == nil || *res.ExitStatus != -1 {
		t.Errorf("exit status = %v, want -1 (killed)", res.ExitStatus)
	}

	if run.State != harness.StateCancelled {
		t.Errorf("state = %q, want %q", run.State, harness.StateCancelled)
	}
	requireEventCode(t, store, run.RunID, harness.EventTypeToolInvocation, sandbox.CodeExecutionCancelled)
	requireEventCode(t, store, run.RunID, harness.EventTypeStateTransition, sandbox.CodeExecutionCancelled)
	if err := store.VerifyChain(run.RunID); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
	if _, err := os.Stat(ws); !os.IsNotExist(err) {
		t.Errorf("workspace still exists after cancellation (stat err = %v)", err)
	}
}

func TestCloseRemovesOnlyOwnWorkspaceAndIsIdempotent(t *testing.T) {
	root := t.TempDir()
	sibling := filepath.Join(root, "shared-artifact")
	if err := os.WriteFile(sibling, []byte("keep"), 0o600); err != nil {
		t.Fatalf("seed sibling: %v", err)
	}

	run, _ := newApprovedRun(t, nil, []string{"."}, nil, 600)
	runner, err := sandbox.New(run, sandbox.Options{WorkspaceRoot: root})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ws := runner.Workspace()
	if !strings.HasPrefix(filepath.Base(ws), "autofixer-sandbox-") {
		t.Errorf("workspace %q lacks the run-owned prefix", ws)
	}
	if filepath.Dir(ws) != root {
		t.Errorf("workspace %q not under root %q", ws, root)
	}

	if err := runner.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(ws); !os.IsNotExist(err) {
		t.Errorf("workspace still exists after Close (stat err = %v)", err)
	}
	if got, err := os.ReadFile(sibling); err != nil || string(got) != "keep" {
		t.Errorf("sibling artifact damaged: content=%q err=%v", got, err)
	}
	if err := runner.Close(); err != nil {
		t.Errorf("second Close: %v, want nil (idempotent)", err)
	}
	if _, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "/bin/true"}); err == nil {
		t.Error("Execute after Close: err = nil, want closed-runner error")
	}
}

func TestExecuteEnvironmentIsolatesHomeAndCredentials(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "/tmp/host-agent.sock")
	t.Setenv("GITHUB_TOKEN", "ghp_host_secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws_host_secret")

	script := `printf '%s|%s|%s|%s' "$HOME" "$SSH_AUTH_SOCK" "$GITHUB_TOKEN" "$AWS_SECRET_ACCESS_KEY"`
	run, _ := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", script}}},
		[]string{"."}, nil, 600)
	runner, ws := newRunner(t, run)

	res, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "/bin/sh", Arguments: []string{"-c", script}})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Decision.Allowed {
		t.Fatalf("decision = %+v, want allowed", res.Decision)
	}
	// HOME is redirected into the workspace and no host credential
	// variable reaches the child.
	want := ws + "|||"
	if string(res.Output) != want {
		t.Errorf("output = %q, want %q (HOME redirected, credentials stripped)", res.Output, want)
	}
}

func TestExecuteRecordsNonZeroExitAsAllowedOutcome(t *testing.T) {
	run, store := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", "exit 3"}}},
		[]string{"."}, nil, 600)
	runner, _ := newRunner(t, run)

	res, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "/bin/sh", Arguments: []string{"-c", "exit 3"}})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Decision.Allowed {
		t.Fatalf("a failing tool is not a policy denial: %+v", res.Decision)
	}
	if res.ExitStatus == nil || *res.ExitStatus != 3 {
		t.Fatalf("exit status = %v, want 3", res.ExitStatus)
	}
	if run.State != harness.StateRunning {
		t.Errorf("state = %q, want %q: a tool failure is not a stop condition by itself", run.State, harness.StateRunning)
	}
	events := store.Events(run.RunID)
	completion := events[len(events)-1]
	if completion.ExitStatus == nil || *completion.ExitStatus != 3 {
		t.Errorf("completion exit = %v, want 3", completion.ExitStatus)
	}
	if err := store.VerifyChain(run.RunID); err != nil {
		t.Errorf("VerifyChain: %v", err)
	}
}

func TestExecuteResolvesBareToolNameOnSandboxPath(t *testing.T) {
	run, _ := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "true", AllowedArguments: nil}},
		[]string{"."}, nil, 600)
	runner, _ := newRunner(t, run)

	res, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "true"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Decision.Allowed {
		t.Fatalf("decision = %+v, want allowed", res.Decision)
	}
	if res.ExitStatus == nil || *res.ExitStatus != 0 {
		t.Errorf("exit status = %v, want 0", res.ExitStatus)
	}
}

func TestExecuteRefusesUnanchorableToolIdentity(t *testing.T) {
	run, store := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "tools/local", AllowedArguments: nil}},
		[]string{"."}, nil, 600)
	runner, _ := newRunner(t, run)

	res, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "tools/local"})
	if err == nil {
		t.Fatal("relative tool identity: err = nil, want refusal instead of a guessed binary")
	}
	if !res.Decision.Allowed {
		t.Fatalf("decision = %+v: policy allowed, runner refused to guess", res.Decision)
	}
	events := store.Events(run.RunID)
	last := events[len(events)-1]
	if last.EventType != harness.EventTypeToolInvocation || last.ExitStatus != nil {
		t.Errorf("last event = %+v, want dispatch evidence with no completion", last)
	}
	if run.State != harness.StateRunning {
		t.Errorf("state = %q, want %q", run.State, harness.StateRunning)
	}
}

func TestExecuteStartFailureLeavesNoCompletionRecord(t *testing.T) {
	nonExecutable := filepath.Join(t.TempDir(), "not-a-binary")
	if err := os.WriteFile(nonExecutable, []byte("data"), 0o600); err != nil {
		t.Fatalf("seed non-executable: %v", err)
	}
	run, store := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: nonExecutable, AllowedArguments: nil}},
		[]string{"."}, nil, 600)
	runner, _ := newRunner(t, run)

	res, err := runner.Execute(context.Background(), sandbox.Spec{Tool: nonExecutable})
	if err == nil {
		t.Fatal("start failure: err = nil, want error")
	}
	if !res.Decision.Allowed {
		t.Fatalf("decision = %+v, want allowed dispatch", res.Decision)
	}
	events := store.Events(run.RunID)
	last := events[len(events)-1]
	if last.EventType != harness.EventTypeToolInvocation || last.ExitStatus != nil {
		t.Errorf("last event = %+v, want dispatch evidence with null exit", last)
	}
	if run.State != harness.StateRunning {
		t.Errorf("state = %q, want %q", run.State, harness.StateRunning)
	}
}

func TestNewRejectsUnusableWorkspaceRoot(t *testing.T) {
	fileRoot := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(fileRoot, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed root file: %v", err)
	}
	run, _ := newApprovedRun(t, nil, []string{"."}, nil, 600)
	if _, err := sandbox.New(run, sandbox.Options{WorkspaceRoot: fileRoot}); err == nil {
		t.Error("New with a file as workspace root: err = nil, want error")
	}
	if _, err := sandbox.New(nil, sandbox.Options{}); err == nil {
		t.Error("New with nil run: err = nil, want error")
	}
}

func TestExecuteCapsRetainedOutputAndDigestsIt(t *testing.T) {
	script := "printf 0123456789abcdef"
	run, _ := newApprovedRun(t,
		[]harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", script}}},
		[]string{"."}, nil, 600)
	runner, err := sandbox.New(run, sandbox.Options{WorkspaceRoot: t.TempDir(), OutputLimit: 8})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { runner.Close() })

	res, err := runner.Execute(context.Background(), sandbox.Spec{Tool: "/bin/sh", Arguments: []string{"-c", script}})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.OutputTruncated {
		t.Fatal("OutputTruncated = false, want true for output beyond the cap")
	}
	if res.OutputBytes != 16 {
		t.Errorf("OutputBytes = %d, want 16 (full stream counted)", res.OutputBytes)
	}
	if !strings.HasPrefix(string(res.Output), "01234567") {
		t.Errorf("retained output = %q, want prefix 01234567", res.Output)
	}
	// The evidence digest always covers exactly the redacted output the
	// runner retained and returned.
	if res.OutputDigest == nil || res.OutputDigest.Value != sha256Hex(string(res.Output)) {
		t.Errorf("digest = %+v, want sha256 of retained redacted output", res.OutputDigest)
	}
}
