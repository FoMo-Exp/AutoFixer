package sandbox

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

// structuredFixture builds a runner whose workspace serves one fixed
// revision, with the given extra options applied.
func structuredFixture(t *testing.T, mods ...func(*Options)) (*Runner, *harness.Run) {
	t.Helper()
	return structuredFixtureWithPaths(t, []string{"web/src", "go.mod"}, mods...)
}

// structuredFixtureWithPaths is structuredFixture with an explicit grant
// path scope.
func structuredFixtureWithPaths(t *testing.T, permittedPaths []string, mods ...func(*Options)) (*Runner, *harness.Run) {
	t.Helper()
	return structuredFixtureFull(t, permittedPaths, harness.ResourceLimits{}, mods...)
}

// structuredFixtureFull is structuredFixture with an explicit grant path
// scope and declared resource limits.
func structuredFixtureFull(t *testing.T, permittedPaths []string, limits harness.ResourceLimits, mods ...func(*Options)) (*Runner, *harness.Run) {
	t.Helper()
	run := mustApprovedRunWithLimits(t, permittedPaths, limits)
	opts := Options{
		WorkspaceRoot:  t.TempDir(),
		RevisionSource: fixtureRevisionSource(),
	}
	for _, mod := range mods {
		mod(&opts)
	}
	runner, err := New(run, opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	return runner, run
}

func fixtureRevisionSource() RevisionSource {
	return NewStaticRevisionSource(StaticRevision{
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
		Files: map[string]string{
			"web/src/export.ts": "export const button = 1;\n",
			"web/src/.env":      "TOKEN=abc\n",
			"go.mod":            "module example.com/fixture\n",
		},
	})
}

// mustApprovedRun is a low-risk approved+running harness run over the
// fixture repository, matching the grant the dispatches are checked against.
func mustApprovedRun(t *testing.T) *harness.Run {
	t.Helper()
	return mustApprovedRunWithPaths(t, []string{"web/src", "go.mod"})
}

func mustApprovedRunWithPaths(t *testing.T, permittedPaths []string) *harness.Run {
	t.Helper()
	return mustApprovedRunWithLimits(t, permittedPaths, harness.ResourceLimits{})
}

func mustApprovedRunWithLimits(t *testing.T, permittedPaths []string, limits harness.ResourceLimits) *harness.Run {
	t.Helper()
	store := harness.NewEventStore()
	assessment, err := harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID: "task-1", RunID: "run-1",
		AssessorIdentity: "dsh", RationaleReference: "evidence://risk/task-1",
	}, harness.RiskLow, harness.DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatalf("assessment: %v", err)
	}
	run, err := harness.NewRun(harness.RunConfig{
		TaskID: "task-1", RunID: "run-1", IssueID: "issue-1",
		ActorIdentity: "human:owner-1", ExecutionIdentity: "dsh-control/v1",
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
	}, assessment, store)
	if err != nil {
		t.Fatalf("NewRun: %v", err)
	}
	grant := harness.GrantParams{
		TaskID: run.TaskID, RunID: run.RunID,
		IssuedAt:               time.Now().Add(-time.Minute),
		ExpiresAt:              time.Now().Add(time.Hour),
		CapabilityGrantVersion: "grant-1",
		RepositoryURL:          "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:                "abc123",
		PermittedPaths:         append([]string{}, permittedPaths...),
		PermittedTools: []harness.PermittedTool{
			{Identity: "repo.read", AllowedArguments: []string{"path:path"}},
			{Identity: "workspace.patch", AllowedArguments: []string{"path:path", "text:content"}},
			{Identity: "test.run", AllowedArguments: []string{"probe.test", "focused", "path:target"}},
			{Identity: "dep.prepare", AllowedArguments: []string{"probe.dep"}},
		},
		NetworkDestinations: []string{},
		MaxWallClockSeconds: 600,
		ResourceLimits:      limits,
		MayCreatePatch:      true,
	}
	if err := run.Approve(grant); err != nil {
		t.Fatalf("Approve: %v", err)
	}
	if err := run.Transition(harness.StateRunning, ""); err != nil {
		t.Fatalf("Transition(running): %v", err)
	}
	return run
}

func readSpec(path string) Spec {
	return Spec{
		Tool:              "repo.read",
		Arguments:         []string{"path:path"},
		EvidenceArguments: []string{path},
		Paths:             []string{path},
		Kind:              DispatchRead,
		Op:                &OpRequest{Path: path},
	}
}

func TestExecuteReadOpBindsResultToRevision(t *testing.T) {
	runner, run := structuredFixture(t)
	res, err := runner.Execute(context.Background(), readSpec("web/src/export.ts"))
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Decision.Allowed {
		t.Fatalf("decision = %+v, want allowed", res.Decision)
	}
	if !strings.Contains(string(res.Output), "export const button") {
		t.Errorf("output = %q, want the file content", res.Output)
	}
	if res.Record == nil {
		t.Fatal("structured result record is nil")
	}
	if res.Record.Revision == nil || res.Record.Revision.BaseSHA != run.BaseSHA {
		t.Errorf("record revision = %+v, want base SHA %q", res.Record.Revision, run.BaseSHA)
	}
	if res.Record.Environment != nil {
		t.Errorf("fs-op environment = %+v, want nil (no test environment ran)", res.Record.Environment)
	}
	if err := res.Record.VerifyDigest(); err != nil {
		t.Errorf("VerifyDigest: %v", err)
	}
	if res.OutputDigest == nil {
		t.Error("output digest is nil")
	}
}

func TestExecuteOpRefusalsStopTheRun(t *testing.T) {
	runner, run := structuredFixture(t)

	// A secret-looking path is refused even inside the granted paths — the
	// policy class gate, not the tool, decides — and the refusal stops the
	// run like an out-of-grant dispatch.
	spec := readSpec("web/src/.env")
	res, err := runner.Execute(context.Background(), spec)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Decision.Allowed || res.Decision.Code != harness.DenyPathClassForbidden {
		t.Fatalf("decision = %+v, want deny %q", res.Decision, harness.DenyPathClassForbidden)
	}
	if run.State != harness.StateStopped {
		t.Errorf("run state = %q, want stopped", run.State)
	}
}

func TestExecuteEditOpRefusesSymlinkWrite(t *testing.T) {
	runner, run := structuredFixture(t)
	// Prepare the workspace first so the symlink lands in the checkout.
	if _, err := runner.Execute(context.Background(), readSpec("web/src/export.ts")); err != nil {
		t.Fatalf("prepare read: %v", err)
	}
	outside := t.TempDir()
	target := outside + "/hijack.txt"
	if err := os.Symlink(target, runner.tree.Root()+"/web/src/linked.txt"); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	spec := Spec{
		Tool:              "workspace.patch",
		Arguments:         []string{"path:path", "text:content"},
		EvidenceArguments: []string{"web/src/linked.txt", "sha256:deadbeef"},
		Paths:             []string{"web/src/linked.txt"},
		WantsPatch:        true,
		Kind:              DispatchEdit,
		Op:                &OpRequest{Path: "web/src/linked.txt", Content: "hijack\n"},
	}
	res, err := runner.Execute(context.Background(), spec)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Gate == nil || !strings.Contains(res.Gate.Code, "symlink") {
		t.Fatalf("gate = %+v, want a symlink refusal", res.Gate)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Errorf("symlink target was written through the link: %v", err)
	}
	if run.State != harness.StateStopped {
		t.Errorf("run state = %q, want stopped after a gate refusal", run.State)
	}
	if !run.Revoked {
		t.Error("gate refusal must revoke the grant")
	}
}

func TestExecuteProfileRunsIsolatedAndBindsEnvironment(t *testing.T) {
	if err := NewIsolator().Available(); err != nil {
		t.Skipf("isolation backend unavailable on this host: %v", err)
	}
	profiles := []ExecProfile{{
		ID:                  "probe.test",
		Kind:                ProfileTest,
		Command:             "/bin/echo",
		Modes:               []string{"focused"},
		MaxWallClockSeconds: 60,
		OutputLimitBytes:    1 << 20,
		Build: func(mode, target string) ([]string, error) {
			return []string{"isolated-ok"}, nil
		},
	}}
	runner, run := structuredFixture(t, func(o *Options) { o.Profiles = profiles })
	res, err := runner.Execute(context.Background(), Spec{
		Tool:              "test.run",
		Arguments:         []string{"probe.test", "focused", "path:target"},
		EvidenceArguments: []string{"probe.test", "focused", "web/src/export.ts"},
		Paths:             []string{"web/src/export.ts"},
		Kind:              DispatchProfile,
		Process:           &ProcessRequest{ProfileID: "probe.test", Mode: "focused", Target: "web/src/export.ts"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Decision.Allowed {
		t.Fatalf("decision = %+v", res.Decision)
	}
	if !strings.Contains(string(res.Output), "isolated-ok") {
		t.Errorf("output = %q, want the profile command output", res.Output)
	}
	if res.Record == nil || res.Record.Environment == nil {
		t.Fatalf("record = %+v, want a bound test environment", res.Record)
	}
	if res.Record.Environment.Network != "denied" {
		t.Errorf("environment network = %q, want denied", res.Record.Environment.Network)
	}
	if res.Record.Revision == nil || res.Record.Revision.BaseSHA != run.BaseSHA {
		t.Errorf("record revision = %+v, want the run's base SHA", res.Record.Revision)
	}
	if err := res.Record.VerifyDigest(); err != nil {
		t.Errorf("VerifyDigest: %v", err)
	}
}

type unavailableIsolatorStub struct{}

func (unavailableIsolatorStub) Name() string { return "unavailable-stub" }
func (unavailableIsolatorStub) Available() error {
	return errors.New("stub: isolation unavailable")
}
func (unavailableIsolatorStub) Wrap(*exec.Cmd, IsolationRequest) (EnvironmentIdentity, error) {
	return EnvironmentIdentity{}, ErrIsolationUnavailable
}

func TestExecuteProfileBlocksWhenIsolationIsUnavailable(t *testing.T) {
	profiles := []ExecProfile{{
		ID:      "probe.test",
		Kind:    ProfileTest,
		Command: "/bin/echo",
		Modes:   []string{"focused"},
		Build:   func(mode, target string) ([]string, error) { return []string{"never"}, nil },
	}}
	runner, _ := structuredFixture(t,
		func(o *Options) { o.Profiles = profiles },
		func(o *Options) { o.Isolator = unavailableIsolatorStub{} },
	)
	res, err := runner.Execute(context.Background(), Spec{
		Tool:    "test.run",
		Paths:   []string{"web/src/export.ts"},
		Kind:    DispatchProfile,
		Process: &ProcessRequest{ProfileID: "probe.test", Mode: "focused", Target: "web/src/export.ts"},
	})
	if !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("Execute error = %v, want ErrIsolationUnavailable (blocked)", err)
	}
	if strings.Contains(string(res.Output), "never") {
		t.Errorf("command ran despite unavailable isolation: %q", res.Output)
	}
}

func TestSandboxSetupRetriesOnlyWithoutChanges(t *testing.T) {
	// Transient sandbox failures retry while the workspace has no changes.
	flaky := &flakyRevisionSource{failures: 2}
	runner, _ := structuredFixture(t, func(o *Options) { o.RevisionSource = flaky })
	if _, err := runner.Execute(context.Background(), readSpec("web/src/export.ts")); err != nil {
		t.Fatalf("Execute with transient failures: %v", err)
	}
	if got := flaky.calls(); got != 3 {
		t.Errorf("materialize attempts = %d, want 3 (bounded retry before any change)", got)
	}

	// Once execution has changed the workspace, a failing sandbox blocks
	// instead of retrying into uncertainty.
	profiles := []ExecProfile{{
		ID:      "probe.test",
		Kind:    ProfileTest,
		Command: "/bin/echo",
		Modes:   []string{"focused"},
		Build:   func(mode, target string) ([]string, error) { return []string{"ok"}, nil },
	}}
	iso := &toggleIsolator{}
	runner2, _ := structuredFixture(t,
		func(o *Options) { o.Isolator = iso },
		func(o *Options) { o.Profiles = profiles },
	)
	profileSpec := func() Spec {
		return Spec{
			Tool:    "test.run",
			Paths:   []string{"web/src/export.ts"},
			Kind:    DispatchProfile,
			Process: &ProcessRequest{ProfileID: "probe.test", Mode: "focused", Target: "web/src/export.ts"},
		}
	}
	if _, err := runner2.Execute(context.Background(), profileSpec()); err != nil {
		t.Fatalf("warm-up profile run: %v", err)
	}
	iso.fail.Store(true)
	before := iso.calls()
	if _, err := runner2.Execute(context.Background(), profileSpec()); !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("Execute with failing isolation: error = %v, want ErrIsolationUnavailable", err)
	}
	if got := iso.calls() - before; got != 1 {
		t.Errorf("isolation attempts after changes = %d, want 1 (no retry once changes exist)", got)
	}
}

// toggleIsolator is a stub backend that reports an environment identity
// without wrapping until fail is set.
type toggleIsolator struct {
	fail  atomic.Bool
	count atomic.Int32
}

func (t *toggleIsolator) Name() string { return "toggle-stub" }

func (t *toggleIsolator) Available() error {
	if t.fail.Load() {
		return ErrIsolationUnavailable
	}
	return nil
}

func (t *toggleIsolator) Wrap(cmd *exec.Cmd, req IsolationRequest) (EnvironmentIdentity, error) {
	t.count.Add(1)
	if t.fail.Load() {
		return EnvironmentIdentity{}, ErrIsolationUnavailable
	}
	return isolationIdentity("toggle-stub", "stub", req), nil
}

func (t *toggleIsolator) calls() int32 { return t.count.Load() }

func editSpec(path, content string) Spec {
	return Spec{
		Tool:              "workspace.patch",
		Arguments:         []string{"path:path", "text:content"},
		EvidenceArguments: []string{path, "sha256:edit"},
		Paths:             []string{path},
		WantsPatch:        true,
		Kind:              DispatchEdit,
		Op:                &OpRequest{Path: path, Content: content},
	}
}

// flakyRevisionSource fails the first N materializations, then delegates.
type flakyRevisionSource struct {
	inner    RevisionSource
	failures int
	count    atomic.Int32
	closed   atomic.Bool
}

func (f *flakyRevisionSource) calls() int32 { return f.count.Load() }

func (f *flakyRevisionSource) close() { f.closed.Store(true) }

func (f *flakyRevisionSource) Materialize(ctx context.Context, repoDir, repositoryURL, baseSHA string) (RevisionIdentity, error) {
	f.count.Add(1)
	if f.closed.Load() || int(f.count.Load()) <= f.failures {
		return RevisionIdentity{}, errors.New("flaky: materialize failed")
	}
	if f.inner == nil {
		f.inner = fixtureRevisionSource()
	}
	return f.inner.Materialize(ctx, repoDir, repositoryURL, baseSHA)
}

func TestExecuteProfileRejectsScopeBeyondGrant(t *testing.T) {
	profiles := []ExecProfile{{
		ID:      "probe.test",
		Kind:    ProfileTest,
		Command: "/bin/echo",
		Modes:   []string{"focused", "suite"},
		Build: func(mode, target string) ([]string, error) {
			return []string{"ran", mode, target}, nil
		},
	}}
	runner, run := structuredFixture(t, func(o *Options) { o.Profiles = profiles })

	// A focused target outside the granted paths is refused: the target and
	// its execution directory face the grant even when the declared path
	// scope looks narrow and honest.
	res, err := runner.Execute(context.Background(), Spec{
		Tool:    "test.run",
		Paths:   []string{"web/src/export.ts"},
		Kind:    DispatchProfile,
		Process: &ProcessRequest{ProfileID: "probe.test", Mode: "focused", Target: "outside/evil_test.go"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Decision.Allowed {
		t.Fatalf("decision = %+v, want a scope denial", res.Decision)
	}
	if run.State != harness.StateStopped {
		t.Errorf("run state = %q, want stopped", run.State)
	}
}

func TestExecuteSuiteRequiresTreeWideGrant(t *testing.T) {
	profiles := []ExecProfile{{
		ID:      "probe.test",
		Kind:    ProfileTest,
		Command: "/bin/echo",
		Modes:   []string{"focused", "suite"},
		Build:   func(mode, target string) ([]string, error) { return []string{"ran"}, nil },
	}}
	suiteSpec := func() Spec {
		return Spec{
			Tool:    "test.run",
			Paths:   []string{"web/src/export.ts"},
			Kind:    DispatchProfile,
			Process: &ProcessRequest{ProfileID: "probe.test", Mode: "suite"},
		}
	}

	// A narrow grant cannot run the repository-wide suite: the profile's
	// real execution scope is checked against the grant and refused.
	runner, run := structuredFixture(t, func(o *Options) { o.Profiles = profiles })
	res, err := runner.Execute(context.Background(), suiteSpec())
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Gate == nil || res.Gate.Code != CodeGrantScopeExceeded {
		t.Fatalf("gate = %+v, want %q", res.Gate, CodeGrantScopeExceeded)
	}
	if run.State != harness.StateStopped {
		t.Errorf("run state = %q, want stopped", run.State)
	}

	// A repository-wide grant admits the suite.
	rootRunner, _ := structuredFixtureWithPaths(t, []string{"."}, func(o *Options) { o.Profiles = profiles })
	res, err = rootRunner.Execute(context.Background(), suiteSpec())
	if err != nil {
		t.Fatalf("Execute under root grant: %v", err)
	}
	if !res.Decision.Allowed || res.Gate != nil {
		t.Fatalf("suite under root grant: decision = %+v gate = %+v, want allowed", res.Decision, res.Gate)
	}
}
