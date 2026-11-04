package dsh

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"testing"

	"github.com/Luthiel/AutoFixer/sandbox"
)

// structuredSource serves the pinned checkout the low-risk fixture run
// names, with one source file and one dependency manifest.
func structuredSource() sandbox.RevisionSource {
	return sandbox.NewStaticRevisionSource(sandbox.StaticRevision{
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "ab12cd3ef456789012345678901234567890abcd",
		Files: map[string]string{
			"web/src/export.ts": "export const button = 1;\n",
			"go.mod":            "module example.com/fixture\n",
		},
	})
}

func structuredCreate(taskID string, tools ...string) createRequest {
	req := lowRiskCreate(taskID, tools...)
	req.RequestedScope.PathHints = []string{"web/src/**", "go.mod"}
	return req
}

func structuredAction(actionID, toolID string, args map[string]any, pathScope ...string) actionRequest {
	raw, err := json.Marshal(args)
	if err != nil {
		panic(err)
	}
	return actionRequest{
		ActionID: actionID,
		Agent:    actionAgent{Runtime: "pi", SessionID: "pis_01", TurnID: "turn_1"},
		Intent: actionIntent{
			ToolID:    toolID,
			Arguments: raw,
			PathScope: pathScope,
			Rationale: "Structured operation for the task.",
		},
	}
}

// requireCompleteExecutionDomain skips a test that runs an untrusted profile
// when the host's backend cannot own the execution domain: the sandbox
// refuses those executions by design (DAT-253).
func requireCompleteExecutionDomain(t *testing.T) {
	t.Helper()
	isolator := sandbox.NewIsolator()
	if err := isolator.Available(); err != nil {
		t.Skipf("isolation backend unavailable on this host: %v", err)
	}
	if domain := isolator.ExecutionDomain(); domain != sandbox.DomainComplete {
		t.Skipf("backend %q provides only %q execution-domain containment on this host", isolator.Name(), domain)
	}
}

// bestEffortIsolatorStub reports a backend that confines what a process can
// reach but cannot guarantee the execution domain (macOS Seatbelt).
type bestEffortIsolatorStub struct{}

func (bestEffortIsolatorStub) Name() string     { return "best-effort-stub" }
func (bestEffortIsolatorStub) Available() error { return nil }
func (bestEffortIsolatorStub) ExecutionDomain() sandbox.ExecutionDomain {
	return sandbox.DomainBestEffort
}

func (bestEffortIsolatorStub) Wrap(*exec.Cmd, sandbox.IsolationRequest) (sandbox.EnvironmentIdentity, error) {
	return sandbox.EnvironmentIdentity{}, sandbox.ErrIsolationUnavailable
}

// TestTestRunRefusedWithoutCompleteExecutionDomain pins the operator-facing
// 503: a host whose backend cannot guarantee a complete execution domain
// refuses the untrusted run and names the reason, instead of downgrading to
// best-effort lifecycle control (DAT-253).
func TestTestRunRefusedWithoutCompleteExecutionDomain(t *testing.T) {
	env := startEnv(t,
		func(c *Config) { c.RevisionSource = structuredSource() },
		func(c *Config) { c.Isolator = bestEffortIsolatorStub{} },
	)
	status, raw := env.do("POST", "/v1/runs", structuredCreate("tsk_domain", "test.run"))
	wantStatus(t, status, raw, http.StatusCreated)
	created := decodeInto[createRunResponse](t, raw)

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions",
		structuredAction("act_domain_1", "test.run", map[string]any{"profile": "go.test", "mode": "focused", "target": "web/src/export.ts"}, "web/src/export.ts"))
	body := wantError(t, status, raw, http.StatusServiceUnavailable, CodeSandboxUnavailable)
	if body.Error.Details["reason"] != "execution_domain_incomplete" {
		t.Errorf("details = %v, want execution_domain_incomplete", body.Error.Details)
	}
}

func TestStructuredReadActionReturnsRevisionBoundResult(t *testing.T) {
	env := startEnv(t, func(c *Config) { c.RevisionSource = structuredSource() })
	status, raw := env.do("POST", "/v1/runs", structuredCreate("tsk_read", "repo.read"))
	wantStatus(t, status, raw, http.StatusCreated)
	created := decodeInto[createRunResponse](t, raw)

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions",
		structuredAction("act_read_1", "repo.read", map[string]any{"path": "web/src/export.ts"}, "web/src/export.ts"))
	wantStatus(t, status, raw, http.StatusAccepted)
	accepted := decodeInto[actionResponse](t, raw)
	if accepted.Result == nil {
		t.Fatal("structured read returned no bound result")
	}
	if accepted.Result.Revision == nil || accepted.Result.Revision.BaseSHA != "ab12cd3ef456789012345678901234567890abcd" {
		t.Errorf("result revision = %+v, want the run's exact base SHA", accepted.Result.Revision)
	}
	if accepted.Result.Digest == "" {
		t.Error("result digest is empty")
	}
	if err := accepted.Result.VerifyDigest(); err != nil {
		t.Errorf("VerifyDigest: %v", err)
	}
}

func TestStructuredEditOfDependencyPathRejectedUnderLowRisk(t *testing.T) {
	env := startEnv(t, func(c *Config) { c.RevisionSource = structuredSource() })
	status, raw := env.do("POST", "/v1/runs", structuredCreate("tsk_edit_dep", "workspace.patch"))
	wantStatus(t, status, raw, http.StatusCreated)
	created := decodeInto[createRunResponse](t, raw)

	// Registering an edit tool never widens what a low-risk run may change:
	// a dependency manifest keeps its elevated class and is refused.
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions",
		structuredAction("act_edit_1", "workspace.patch", map[string]any{"path": "go.mod", "content": "module changed\n"}, "go.mod"))
	body := wantError(t, status, raw, http.StatusForbidden, CodeScopeDenied)
	if body.Error.Details["decision"] != "deny_path_class_requires_elevated" {
		t.Errorf("details = %v, want a dependency-class denial", body.Error.Details)
	}

	status, raw = env.do("GET", "/v1/runs/"+created.RunID, nil)
	wantStatus(t, status, raw, http.StatusOK)
	runBody := decodeInto[runResponse](t, raw)
	if runBody.State != "stopped" {
		t.Errorf("run state = %q, want stopped after the out-of-class edit", runBody.State)
	}
}

func TestOverprivilegedTestCommandRejected(t *testing.T) {
	env := startEnv(t, func(c *Config) { c.RevisionSource = structuredSource() })
	status, raw := env.do("POST", "/v1/runs", structuredCreate("tsk_overpriv", "test.run"))
	wantStatus(t, status, raw, http.StatusCreated)
	created := decodeInto[createRunResponse](t, raw)

	// A focused run without a target is over-privileged: the profile
	// vocabulary refuses it with a recorded rejection that stops the run.
	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions",
		structuredAction("act_over_1", "test.run", map[string]any{"profile": "go.test", "mode": "focused"}, "web/src/export.ts"))
	wantError(t, status, raw, http.StatusForbidden, CodeToolNotAllowlisted)

	// An unknown mode never leaves the schema: the request is refused
	// before any state or dispatch work.
	status, raw = env.do("POST", "/v1/runs", structuredCreate("tsk_overpriv_2", "test.run"))
	wantStatus(t, status, raw, http.StatusCreated)
	second := decodeInto[createRunResponse](t, raw)
	status, raw = env.do("POST", "/v1/runs/"+second.RunID+"/actions",
		structuredAction("act_over_2", "test.run", map[string]any{"profile": "go.test", "mode": "shell"}, "web/src/export.ts"))
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidToolArguments)
}

func TestStructuredDispatchBlockedWithoutSandbox(t *testing.T) {
	// With no revision source the sandbox cannot materialize anything, so
	// execution is blocked rather than run against an empty workspace.
	env := startEnv(t)
	status, raw := env.do("POST", "/v1/runs", structuredCreate("tsk_blocked", "repo.read"))
	wantStatus(t, status, raw, http.StatusCreated)
	created := decodeInto[createRunResponse](t, raw)

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions",
		structuredAction("act_read_1", "repo.read", map[string]any{"path": "web/src/export.ts"}, "web/src/export.ts"))
	wantError(t, status, raw, http.StatusServiceUnavailable, CodeSandboxUnavailable)
}

func TestDepPreparePrimesApprovedSourceThenInstallsIsolated(t *testing.T) {
	requireCompleteExecutionDomain(t)
	primed := false
	profiles := []sandbox.ExecProfile{{
		ID:                  "go.mod",
		Kind:                sandbox.ProfileDependency,
		Command:             "/usr/bin/true",
		MaxWallClockSeconds: 60,
		OutputLimitBytes:    1 << 20,
		Build:               func(mode, target string) ([]string, error) { return []string{}, nil },
		FetchArgv:           []string{"fetch-from-approved-registry"},
		FetchEnv:            map[string]string{"GOPROXY": "https://proxy.golang.org,direct"},
	}}
	env := startEnv(t,
		func(c *Config) { c.RevisionSource = structuredSource() },
		func(c *Config) {
			c.DependencySource = sandbox.StaticDependencySource{
				Primed: func(layout sandbox.DependencyLayout, profile sandbox.ExecProfile) error {
					primed = true
					return nil
				},
			}
		},
		func(c *Config) { c.Profiles = profiles },
	)
	depCreate := structuredCreate("tsk_dep", "dep.prepare")
	// Dependency preparation is repository-wide work: it needs a
	// repository-wide grant, and a narrow one is refused at dispatch.
	depCreate.RequestedScope.PathHints = []string{"."}
	status, raw := env.do("POST", "/v1/runs", depCreate)
	wantStatus(t, status, raw, http.StatusCreated)
	created := decodeInto[createRunResponse](t, raw)

	status, raw = env.do("POST", "/v1/runs/"+created.RunID+"/actions",
		structuredAction("act_dep_1", "dep.prepare", map[string]any{"profile": "go.mod"}, "go.mod"))
	wantStatus(t, status, raw, http.StatusAccepted)
	accepted := decodeInto[actionResponse](t, raw)
	if !primed {
		t.Error("dependency cache was not primed from the approved source")
	}
	if accepted.Result == nil || accepted.Result.Environment == nil {
		t.Fatalf("result = %+v, want an isolated install bound to its environment", accepted.Result)
	}
	if accepted.Result.Environment.Network != "denied" {
		t.Errorf("environment network = %q, want denied", accepted.Result.Environment.Network)
	}
}

func TestRootScopeHintCreatesRepositoryWideGrant(t *testing.T) {
	env := startEnv(t, func(c *Config) { c.RevisionSource = structuredSource() })
	req := structuredCreate("tsk_root", "repo.read")
	req.RequestedScope.PathHints = []string{"."}
	status, raw := env.do("POST", "/v1/runs", req)
	wantStatus(t, status, raw, http.StatusCreated)
	created := decodeInto[createRunResponse](t, raw)
	if created.Grant == nil || len(created.Grant.PermittedPaths) != 1 || created.Grant.PermittedPaths[0] != "." {
		t.Fatalf("grant permitted_paths = %+v, want the repository-wide root", created.Grant)
	}

	// A suite run is refused under any narrower grant, so the root hint is
	// the only way to authorize one.
	narrow := structuredCreate("tsk_narrow", "test.run")
	status, raw = env.do("POST", "/v1/runs", narrow)
	wantStatus(t, status, raw, http.StatusCreated)
	narrowRun := decodeInto[createRunResponse](t, raw)
	status, raw = env.do("POST", "/v1/runs/"+narrowRun.RunID+"/actions",
		structuredAction("act_suite_1", "test.run", map[string]any{"profile": "go.test", "mode": "suite"}, "web/src/export.ts"))
	body := wantError(t, status, raw, http.StatusForbidden, CodeScopeDenied)
	if body.Error.Details["gate_code"] != "grant_scope_exceeded" {
		t.Errorf("details = %v, want grant_scope_exceeded", body.Error.Details)
	}
}
