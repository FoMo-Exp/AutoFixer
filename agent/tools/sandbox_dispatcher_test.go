//go:build unix

package tools_test

import (
	"context"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/agent/tools"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

const (
	testRepoURL = "https://github.com/Luthiel/AutoFixer.git"
	testBaseSHA = "abc123"
	testScript  = "echo afp03"
)

// newApprovedRun builds a low-risk run with an issued grant, using real
// timestamps so the FP-03 policy's expiry check applies as in production.
func newApprovedRun(t *testing.T, permittedTools []harness.PermittedTool, paths, network []string) (*harness.Run, *harness.EventStore) {
	t.Helper()
	store := harness.NewEventStore()
	assessment, err := harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID:             "task-afp03",
		RunID:              "run-afp03",
		AssessedAt:         time.Now().UTC().Truncate(time.Second),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/task-afp03",
	}, harness.RiskLow, harness.DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatalf("NewRiskAssessment: %v", err)
	}
	run, err := harness.NewRun(harness.RunConfig{
		TaskID:            "task-afp03",
		RunID:             "run-afp03",
		IssueID:           "DAT-180",
		ActorIdentity:     "human:owner-1",
		ExecutionIdentity: "agent:backend-builder-ii",
		RepositoryURL:     testRepoURL,
		BaseSHA:           testBaseSHA,
	}, assessment, store)
	if err != nil {
		t.Fatalf("NewRun: %v", err)
	}
	now := time.Now().UTC()
	if err := run.Approve(harness.GrantParams{
		TaskID:                 "task-afp03",
		RunID:                  "run-afp03",
		IssuedAt:               now.Add(-time.Minute),
		ExpiresAt:              now.Add(time.Hour),
		CapabilityGrantVersion: "grant-1",
		RepositoryURL:          testRepoURL,
		BaseSHA:                testBaseSHA,
		PermittedPaths:         paths,
		PermittedTools:         permittedTools,
		NetworkDestinations:    network,
		MaxWallClockSeconds:    600,
	}); err != nil {
		t.Fatalf("Approve: %v", err)
	}
	return run, store
}

func newRunner(t *testing.T, run *harness.Run) *sandbox.Runner {
	t.Helper()
	runner, err := sandbox.New(run, sandbox.Options{WorkspaceRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { runner.Close() })
	return runner
}

// requireNoDispatchEvents asserts the harness boundary never saw a tool
// invocation for the run; the requested -> approved transition written at
// issuance is expected evidence, a dispatch event is not.
func requireNoDispatchEvents(t *testing.T, store *harness.EventStore, runID string) {
	t.Helper()
	for _, e := range store.Events(runID) {
		if e.EventType == harness.EventTypeToolInvocation {
			t.Fatalf("denied request reached the harness boundary: %+v", e)
		}
	}
}

// TestSandboxDispatcherForwardsScopesThroughHarnessPolicy proves the adapter
// converts a Call into the sandbox spec unchanged: the harness FP-03 policy
// inside the runner sees the declared arguments, paths, and network
// destinations and decides from the grant.
func TestSandboxDispatcherForwardsScopesThroughHarnessPolicy(t *testing.T) {
	grantTools := []harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", testScript}}}

	tests := []struct {
		name         string
		grantPaths   []string
		grantNetwork []string
		call         tools.Call
		wantAllowed  bool
		wantCode     string
	}{
		{
			name:        "declared call runs under the grant",
			grantPaths:  []string{"."},
			call:        tools.Call{Tool: "/bin/sh", Arguments: []string{"-c", testScript}},
			wantAllowed: true,
			wantCode:    harness.AllowWithinGrant,
		},
		{
			name:        "argument beyond the grant is denied",
			grantPaths:  []string{"."},
			call:        tools.Call{Tool: "/bin/sh", Arguments: []string{"-c", testScript, "extra"}},
			wantAllowed: false,
			wantCode:    harness.DenyToolArgumentNotPermitted,
		},
		{
			name:        "path outside the grant is denied",
			grantPaths:  []string{"src"},
			call:        tools.Call{Tool: "/bin/sh", Arguments: []string{"-c", testScript}, Paths: []string{"docs/report.md"}},
			wantAllowed: false,
			wantCode:    harness.DenyPathNotPermitted,
		},
		{
			name:        "network destination outside the grant is denied",
			grantPaths:  []string{"."},
			call:        tools.Call{Tool: "/bin/sh", Arguments: []string{"-c", testScript}, NetworkDestinations: []string{"api.example.com"}},
			wantAllowed: false,
			wantCode:    harness.DenyNetworkNotPermitted,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			run, store := newApprovedRun(t, grantTools, tt.grantPaths, tt.grantNetwork)
			dispatcher := tools.NewSandboxDispatcher(newRunner(t, run))

			res, err := dispatcher.Dispatch(context.Background(), tt.call)
			if err != nil {
				t.Fatalf("Dispatch: %v", err)
			}
			if res.Decision.Allowed != tt.wantAllowed {
				t.Fatalf("decision = %+v, allowed=%v", res.Decision, tt.wantAllowed)
			}
			if res.Decision.Code != tt.wantCode {
				t.Fatalf("code = %q, want %q", res.Decision.Code, tt.wantCode)
			}
			if tt.wantAllowed {
				if res.ExitStatus == nil || *res.ExitStatus != 0 {
					t.Fatalf("exit status = %v, want 0", res.ExitStatus)
				}
				if string(res.Output) != "afp03\n" {
					t.Fatalf("output = %q, want the declared script's output", res.Output)
				}
				if err := store.VerifyChain(run.RunID); err != nil {
					t.Fatalf("VerifyChain: %v", err)
				}
				if run.State != harness.StateRunning {
					t.Fatalf("state = %q, want %q", run.State, harness.StateRunning)
				}
			} else {
				if res.ExitStatus != nil || len(res.Output) != 0 {
					t.Fatalf("denied dispatch ran a process: %+v", res)
				}
				if run.State != harness.StateStopped {
					t.Fatalf("state = %q, want the stop condition applied (%q)", run.State, harness.StateStopped)
				}
			}
		})
	}
}

// TestRegistryAndSandboxEnforceBothGates covers the acceptance matrix: a
// request the registry denies never reaches the harness boundary (no event,
// no state change), a request both gates allow executes with an intact
// evidence chain, and a registry allow can never substitute for a missing
// harness grant.
func TestRegistryAndSandboxEnforceBothGates(t *testing.T) {
	grantTools := []harness.PermittedTool{{Identity: "/bin/sh", AllowedArguments: []string{"-c", testScript}}}
	allowedCall := tools.Request{
		TaskID:    "task-afp03",
		RunID:     "run-afp03",
		RiskClass: harness.RiskLow,
		Call:      tools.Call{Tool: "/bin/sh", Arguments: []string{"-c", testScript}},
	}

	t.Run("unregistered tool is denied before dispatch", func(t *testing.T) {
		run, store := newApprovedRun(t, grantTools, []string{"."}, nil)
		reg := tools.NewRegistry(tools.WithDispatcher(tools.NewSandboxDispatcher(newRunner(t, run))))

		outcome, err := reg.Execute(context.Background(), allowedCall)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if outcome.Decision.Allowed || outcome.Decision.Code != tools.DenyToolUnregistered {
			t.Fatalf("decision = %+v, want deny_tool_unregistered", outcome.Decision)
		}
		if outcome.Result != nil {
			t.Fatalf("Result = %+v, want nil: nothing was dispatched", outcome.Result)
		}
		requireNoDispatchEvents(t, store, run.RunID)
		if run.State != harness.StateApproved {
			t.Fatalf("state = %q, want %q: no dispatch happened", run.State, harness.StateApproved)
		}
	})

	t.Run("over-privileged argument is denied before dispatch", func(t *testing.T) {
		run, store := newApprovedRun(t, grantTools, []string{"."}, nil)
		reg := tools.NewRegistry(tools.WithDispatcher(tools.NewSandboxDispatcher(newRunner(t, run))))
		registerTools(t, reg, tools.Permission{
			Identity:         "/bin/sh",
			AllowedArguments: []string{"-c", testScript},
			AllowedPaths:     []string{"."},
			MinimumRisk:      harness.RiskLow,
		})

		req := allowedCall
		req.Call.Arguments = []string{"-c", "echo something-else"}
		outcome, err := reg.Execute(context.Background(), req)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if outcome.Decision.Allowed || outcome.Decision.Code != tools.DenyArgumentNotPermitted {
			t.Fatalf("decision = %+v, want deny_argument_not_permitted", outcome.Decision)
		}
		requireNoDispatchEvents(t, store, run.RunID)
		if run.State != harness.StateApproved {
			t.Fatalf("state = %q, want %q: no dispatch happened", run.State, harness.StateApproved)
		}
	})

	t.Run("risk-incompatible tool is denied before dispatch", func(t *testing.T) {
		run, store := newApprovedRun(t, grantTools, []string{"."}, nil)
		reg := tools.NewRegistry(tools.WithDispatcher(tools.NewSandboxDispatcher(newRunner(t, run))))
		registerTools(t, reg, tools.Permission{
			Identity:         "/bin/sh",
			AllowedArguments: []string{"-c", testScript},
			AllowedPaths:     []string{"."},
			MinimumRisk:      harness.RiskElevated,
		})

		outcome, err := reg.Execute(context.Background(), allowedCall)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if outcome.Decision.Allowed || outcome.Decision.Code != tools.DenyRiskClassMismatch {
			t.Fatalf("decision = %+v, want deny_risk_class_mismatch", outcome.Decision)
		}
		requireNoDispatchEvents(t, store, run.RunID)
		if run.State != harness.StateApproved {
			t.Fatalf("state = %q, want %q: no dispatch happened", run.State, harness.StateApproved)
		}
	})

	t.Run("both gates allow and the evidence chain is intact", func(t *testing.T) {
		run, store := newApprovedRun(t, grantTools, []string{"."}, nil)
		reg := tools.NewRegistry(tools.WithDispatcher(tools.NewSandboxDispatcher(newRunner(t, run))))
		registerTools(t, reg, tools.Permission{
			Identity:         "/bin/sh",
			AllowedArguments: []string{"-c", testScript},
			AllowedPaths:     []string{"."},
			MinimumRisk:      harness.RiskLow,
		})

		outcome, err := reg.Execute(context.Background(), allowedCall)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if !outcome.Decision.Allowed || outcome.Result == nil || !outcome.Result.Decision.Allowed {
			t.Fatalf("outcome = %+v, want both gates allowed", outcome)
		}
		if string(outcome.Result.Output) != "afp03\n" {
			t.Fatalf("output = %q, want the declared script's output", outcome.Result.Output)
		}
		if err := store.VerifyChain(run.RunID); err != nil {
			t.Fatalf("VerifyChain: %v", err)
		}
		if run.State != harness.StateRunning {
			t.Fatalf("state = %q, want %q", run.State, harness.StateRunning)
		}
	})

	t.Run("registry allow cannot substitute for the harness grant", func(t *testing.T) {
		run, store := newApprovedRun(t, nil /* no tool is granted */, []string{"."}, nil)
		reg := tools.NewRegistry(tools.WithDispatcher(tools.NewSandboxDispatcher(newRunner(t, run))))
		registerTools(t, reg, tools.Permission{
			Identity:         "/bin/sh",
			AllowedArguments: []string{"-c", testScript},
			AllowedPaths:     []string{"."},
			MinimumRisk:      harness.RiskLow,
		})

		outcome, err := reg.Execute(context.Background(), allowedCall)
		if err != nil {
			t.Fatalf("Execute: %v", err)
		}
		if !outcome.Decision.Allowed {
			t.Fatalf("registry decision = %+v, want allowed so the harness gate is exercised", outcome.Decision)
		}
		if outcome.Result == nil || outcome.Result.Decision.Code != harness.DenyToolNotPermitted {
			t.Fatalf("harness decision = %+v, want deny_tool_not_permitted from the grant", outcome.Result)
		}
		if run.State != harness.StateStopped {
			t.Fatalf("state = %q, want the stop condition applied (%q)", run.State, harness.StateStopped)
		}
		if err := store.VerifyChain(run.RunID); err != nil {
			t.Fatalf("VerifyChain: %v", err)
		}
	})
}
