package tools_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/agent/tools"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

const (
	testTaskID = "task-afp03"
	testRunID  = "run-afp03"
)

var fixedTime = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

// newRegistry wires a registry over a FakeDispatcher with two registered
// tools: the low-risk offline fake tool and an elevated writer scoped to
// src/ and one network destination.
func newRegistry(t *testing.T, opts ...tools.Option) (*tools.Registry, *tools.FakeDispatcher) {
	t.Helper()
	dispatcher := tools.NewFakeDispatcher()
	all := append([]tools.Option{
		tools.WithDispatcher(dispatcher),
		tools.WithClock(func() time.Time { return fixedTime }),
	}, opts...)
	reg := tools.NewRegistry(all...)
	registerTools(t, reg,
		append(tools.FakeToolPermissions(), tools.Permission{
			Identity:                   "writer",
			AllowedArguments:           []string{"--write"},
			AllowedPaths:               []string{"src"},
			AllowedNetworkDestinations: []string{"api.example.com"},
			MinimumRisk:                harness.RiskElevated,
		})...)
	return reg, dispatcher
}

func registerTools(t *testing.T, reg *tools.Registry, perms ...tools.Permission) {
	t.Helper()
	for _, p := range perms {
		if err := reg.Register(p); err != nil {
			t.Fatalf("Register(%q): %v", p.Identity, err)
		}
	}
}

func request(tool string, args ...string) tools.Request {
	return tools.Request{
		TaskID:    testTaskID,
		RunID:     testRunID,
		RiskClass: harness.RiskLow,
		Call:      tools.Call{Tool: tool, Arguments: args},
	}
}

func requireSingleEntry(t *testing.T, reg *tools.Registry, req tools.Request, wantCode string) {
	t.Helper()
	entries := reg.Entries()
	if len(entries) != 1 {
		t.Fatalf("audit entries = %d (%+v), want exactly 1", len(entries), entries)
	}
	e := entries[0]
	if e.TaskID != req.TaskID || e.RunID != req.RunID {
		t.Errorf("entry identity = %q/%q, want %q/%q", e.TaskID, e.RunID, req.TaskID, req.RunID)
	}
	if e.Tool != req.Call.Tool {
		t.Errorf("entry tool = %q, want %q", e.Tool, req.Call.Tool)
	}
	if e.Code != wantCode {
		t.Errorf("entry code = %q, want %q", e.Code, wantCode)
	}
	if e.Reason == "" {
		t.Error("entry carries no audit reason")
	}
	if !e.OccurredAt.Equal(fixedTime) {
		t.Errorf("entry OccurredAt = %v, want %v", e.OccurredAt, fixedTime)
	}
}

func TestRegisterRefusesUnusableMetadata(t *testing.T) {
	tests := []struct {
		name string
		perm tools.Permission
	}{
		{"empty identity", tools.Permission{Identity: "", MinimumRisk: harness.RiskLow}},
		{"missing risk class", tools.Permission{Identity: "t1", MinimumRisk: ""}},
		{"prohibited risk class", tools.Permission{Identity: "t1", MinimumRisk: harness.RiskProhibited}},
		{"absolute path root", tools.Permission{Identity: "t1", AllowedPaths: []string{"/etc"}, MinimumRisk: harness.RiskLow}},
		{"escaping path root", tools.Permission{Identity: "t1", AllowedPaths: []string{"src/../../secrets"}, MinimumRisk: harness.RiskLow}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := tools.NewRegistry()
			if err := reg.Register(tt.perm); err == nil {
				t.Fatalf("Register(%+v) = nil error, want refusal", tt.perm)
			}
		})
	}
}

func TestRegisterRefusesDuplicateInsteadOfWidening(t *testing.T) {
	reg := tools.NewRegistry()
	perm := tools.Permission{
		Identity:         "dup",
		AllowedArguments: []string{"--ok"},
		MinimumRisk:      harness.RiskLow,
	}
	registerTools(t, reg, perm)

	wider := perm
	wider.AllowedArguments = []string{"--ok", "--wide"}
	if err := reg.Register(wider); err == nil {
		t.Fatal("second Register = nil error, want refusal")
	}
	if d := reg.Authorize(request("dup", "--wide")); d.Allowed {
		t.Fatalf("duplicate registration widened the allow-list: %+v", d)
	}
}

func TestAuthorizeAllowsRegisteredRequestAndRecordsNothing(t *testing.T) {
	reg, _ := newRegistry(t)
	req := request(tools.FakeToolIdentity, "--ok")
	req.Call.Paths = []string{"src/main.go"}

	for range 2 {
		d := reg.Authorize(req)
		if !d.Allowed || d.Code != tools.AllowWithinRegistry || d.Reason == "" {
			t.Fatalf("Authorize = %+v, want allowed within registry with a reason", d)
		}
	}
	if entries := reg.Entries(); len(entries) != 0 {
		t.Fatalf("Authorize recorded %d audit entries, want none", len(entries))
	}
}

func TestExecuteDeniedRequestsAreAuditedAndNeverDispatched(t *testing.T) {
	tests := []struct {
		name     string
		req      func() tools.Request
		wantCode string
	}{
		{
			name: "missing task identity",
			req: func() tools.Request {
				r := request(tools.FakeToolIdentity, "--ok")
				r.TaskID = ""
				return r
			},
			wantCode: tools.DenyRequestIncomplete,
		},
		{
			name: "missing run identity",
			req: func() tools.Request {
				r := request(tools.FakeToolIdentity, "--ok")
				r.RunID = ""
				return r
			},
			wantCode: tools.DenyRequestIncomplete,
		},
		{
			name:     "empty tool identity",
			req:      func() tools.Request { return request("", "--ok") },
			wantCode: tools.DenyActionMalformed,
		},
		{
			name:     "empty argument",
			req:      func() tools.Request { return request(tools.FakeToolIdentity, "--ok", "") },
			wantCode: tools.DenyActionMalformed,
		},
		{
			name:     "unregistered tool",
			req:      func() tools.Request { return request("curl", "--silent") },
			wantCode: tools.DenyToolUnregistered,
		},
		{
			name:     "argument beyond the allow-list",
			req:      func() tools.Request { return request(tools.FakeToolIdentity, "--boom") },
			wantCode: tools.DenyArgumentNotPermitted,
		},
		{
			name: "path escaping the repository",
			req: func() tools.Request {
				r := request(tools.FakeToolIdentity, "--ok")
				r.Call.Paths = []string{"src/../../etc/passwd"}
				return r
			},
			wantCode: tools.DenyPathNotPermitted,
		},
		{
			name: "absolute path",
			req: func() tools.Request {
				r := request(tools.FakeToolIdentity, "--ok")
				r.Call.Paths = []string{"/etc/passwd"}
				return r
			},
			wantCode: tools.DenyPathNotPermitted,
		},
		{
			name: "path outside the registered root",
			req: func() tools.Request {
				r := request("writer", "--write")
				r.RiskClass = harness.RiskElevated
				r.Call.Paths = []string{"docs/report.md"}
				return r
			},
			wantCode: tools.DenyPathNotPermitted,
		},
		{
			name: "network destination beyond the allow-list",
			req: func() tools.Request {
				r := request("writer", "--write")
				r.RiskClass = harness.RiskElevated
				r.Call.NetworkDestinations = []string{"evil.example.com"}
				return r
			},
			wantCode: tools.DenyNetworkNotPermitted,
		},
		{
			name:     "risk class below the tool requirement",
			req:      func() tools.Request { return request("writer", "--write") },
			wantCode: tools.DenyRiskClassMismatch,
		},
		{
			name: "prohibited run risk",
			req: func() tools.Request {
				r := request(tools.FakeToolIdentity, "--ok")
				r.RiskClass = harness.RiskProhibited
				return r
			},
			wantCode: tools.DenyRiskClassMismatch,
		},
		{
			name: "unknown run risk",
			req: func() tools.Request {
				r := request(tools.FakeToolIdentity, "--ok")
				r.RiskClass = "invented"
				return r
			},
			wantCode: tools.DenyRiskClassMismatch,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, dispatcher := newRegistry(t)
			req := tt.req()

			outcome, err := reg.Execute(context.Background(), req)
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if outcome.Decision.Allowed {
				t.Fatalf("decision = %+v, want denied", outcome.Decision)
			}
			if outcome.Decision.Code != tt.wantCode {
				t.Errorf("code = %q, want %q (reason %q)", outcome.Decision.Code, tt.wantCode, outcome.Decision.Reason)
			}
			if outcome.Decision.Reason == "" {
				t.Error("denial carries no audit reason")
			}
			if outcome.Result != nil {
				t.Errorf("Result = %+v, want nil: nothing was dispatched", outcome.Result)
			}
			if calls := dispatcher.Calls(); len(calls) != 0 {
				t.Fatalf("denied request reached the dispatcher: %+v", calls)
			}
			requireSingleEntry(t, reg, req, tt.wantCode)
		})
	}
}

func TestExecuteDeniesWithoutDispatcherInsteadOfRunning(t *testing.T) {
	reg := tools.NewRegistry(tools.WithClock(func() time.Time { return fixedTime }))
	registerTools(t, reg, tools.FakeToolPermissions()...)
	req := request(tools.FakeToolIdentity, "--ok")

	outcome, err := reg.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if outcome.Decision.Allowed || outcome.Decision.Code != tools.DenyNoDispatcher {
		t.Fatalf("decision = %+v, want deny_no_dispatcher", outcome.Decision)
	}
	if outcome.Result != nil {
		t.Errorf("Result = %+v, want nil", outcome.Result)
	}
	requireSingleEntry(t, reg, req, tools.DenyNoDispatcher)
}

func TestExecuteDeliversAllowlistedRequestWithDeclaredScopes(t *testing.T) {
	reg, dispatcher := newRegistry(t)
	req := request(tools.FakeToolIdentity, "--ok")
	req.Call.Paths = []string{"src/main.go"}

	outcome, err := reg.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !outcome.Decision.Allowed || outcome.Decision.Code != tools.AllowWithinRegistry {
		t.Fatalf("decision = %+v, want allowed", outcome.Decision)
	}
	if outcome.Result == nil {
		t.Fatal("Result = nil, want dispatch evidence")
	}
	if !outcome.Result.Decision.Allowed || outcome.Result.ExitStatus == nil || *outcome.Result.ExitStatus != 0 {
		t.Fatalf("dispatch result = %+v, want the fake tool's allowed zero-exit result", outcome.Result)
	}

	calls := dispatcher.Calls()
	if len(calls) != 1 {
		t.Fatalf("dispatched calls = %d, want 1", len(calls))
	}
	got := calls[0]
	if got.Tool != req.Call.Tool ||
		!equalStrings(got.Arguments, req.Call.Arguments) ||
		!equalStrings(got.Paths, req.Call.Paths) {
		t.Fatalf("dispatched call = %+v, want the declared scopes %+v", got, req.Call)
	}

	// The dispatcher holds a copy: mutating the request afterwards cannot
	// rewrite what was dispatched.
	req.Call.Arguments[0] = "--rewritten"
	if dispatcher.Calls()[0].Arguments[0] != "--ok" {
		t.Fatal("dispatched call aliases the caller's request")
	}
	requireSingleEntry(t, reg, request(tools.FakeToolIdentity, "--ok"), tools.AllowWithinRegistry)
}

func TestExecuteSurfacesDispatchFailure(t *testing.T) {
	reg, dispatcher := newRegistry(t)
	dispatcher.SetResult(tools.FakeToolIdentity, sandbox.Result{}, errors.New("runner is closed"))

	outcome, err := reg.Execute(context.Background(), request(tools.FakeToolIdentity, "--ok"))
	if err == nil || !strings.Contains(err.Error(), "runner is closed") {
		t.Fatalf("Execute error = %v, want the dispatch failure", err)
	}
	if outcome.Result == nil {
		t.Fatal("Result = nil, want the attempted dispatch's evidence")
	}
	if calls := dispatcher.Calls(); len(calls) != 1 {
		t.Fatalf("dispatched calls = %d, want 1", len(calls))
	}
	// The authorization decision is still the audited layer output.
	entries := reg.Entries()
	if len(entries) != 1 || entries[0].Code != tools.AllowWithinRegistry {
		t.Fatalf("audit entries = %+v, want the allow_within_registry decision", entries)
	}
}

func TestAuditEntriesAreRedactedAndProtectedCopies(t *testing.T) {
	reg, _ := newRegistry(t)
	req := request(tools.FakeToolIdentity, "--ok", "token=abc123")

	outcome, err := reg.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if strings.Contains(outcome.Decision.Reason, "abc123") || !strings.Contains(outcome.Decision.Reason, "[REDACTED]") {
		t.Fatalf("denial reason leaks the raw argument: %q", outcome.Decision.Reason)
	}

	entries := reg.Entries()
	if len(entries) != 1 {
		t.Fatalf("audit entries = %d, want 1", len(entries))
	}
	if entries[0].Arguments[0] != "--ok" || entries[0].Arguments[1] != "token=[REDACTED]" {
		t.Fatalf("stored arguments = %v, want redacted copies", entries[0].Arguments)
	}

	// Entries returns copies: mutating them cannot rewrite stored evidence.
	entries[0].Tool = "rewritten"
	entries[0].Arguments[0] = "rewritten"
	if again := reg.Entries(); again[0].Tool != tools.FakeToolIdentity || again[0].Arguments[0] != "--ok" {
		t.Fatalf("stored entry was rewritten through the returned copy: %+v", again[0])
	}
}

func TestRiskRequirementMatrix(t *testing.T) {
	reg, _ := newRegistry(t)
	tests := []struct {
		name      string
		tool      string
		runRisk   harness.RiskClass
		wantAllow bool
	}{
		{"low tool under low run", tools.FakeToolIdentity, harness.RiskLow, true},
		{"low tool under elevated run", tools.FakeToolIdentity, harness.RiskElevated, true},
		{"low tool under prohibited run", tools.FakeToolIdentity, harness.RiskProhibited, false},
		{"low tool under missing run risk", tools.FakeToolIdentity, "", false},
		{"elevated tool under low run", "writer", harness.RiskLow, false},
		{"elevated tool under elevated run", "writer", harness.RiskElevated, true},
		{"elevated tool under prohibited run", "writer", harness.RiskProhibited, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := request(tt.tool)
			req.RiskClass = tt.runRisk
			d := reg.Authorize(req)
			if d.Allowed != tt.wantAllow {
				t.Fatalf("Authorize = %+v, allowed=%v", d, tt.wantAllow)
			}
			if d.Allowed && d.Code != tools.AllowWithinRegistry {
				t.Errorf("code = %q, want %q", d.Code, tools.AllowWithinRegistry)
			}
			if !d.Allowed && d.Code != tools.DenyRiskClassMismatch {
				t.Errorf("code = %q, want %q", d.Code, tools.DenyRiskClassMismatch)
			}
		})
	}
}

func TestFakeDispatcherDefaultsScriptsAndCopies(t *testing.T) {
	d := tools.NewFakeDispatcher()

	call := tools.Call{Tool: "t1", Arguments: []string{"a"}}
	res, err := d.Dispatch(context.Background(), call)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if !res.Decision.Allowed || res.ExitStatus == nil || *res.ExitStatus != 0 {
		t.Fatalf("default result = %+v, want an allowed zero-exit result", res)
	}

	call.Arguments[0] = "mutated"
	calls := d.Calls()
	if calls[0].Arguments[0] != "a" {
		t.Fatal("recorded call aliases the caller's slice")
	}
	calls[0].Arguments[0] = "rewritten"
	if d.Calls()[0].Arguments[0] != "a" {
		t.Fatal("Calls returned an aliased copy")
	}

	denial := sandbox.Result{Decision: harness.Decision{Allowed: false, Code: harness.DenyToolNotPermitted}}
	d.SetResult("denied", denial, nil)
	res, err = d.Dispatch(context.Background(), tools.Call{Tool: "denied"})
	if err != nil {
		t.Fatalf("Dispatch scripted denial: %v", err)
	}
	if res.Decision.Allowed || res.Decision.Code != harness.DenyToolNotPermitted {
		t.Fatalf("scripted denial = %+v, want it returned verbatim", res)
	}

	d.SetResult("boom", sandbox.Result{}, errors.New("boom"))
	if _, err := d.Dispatch(context.Background(), tools.Call{Tool: "boom"}); err == nil {
		t.Fatal("scripted failure = nil error, want it returned")
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
