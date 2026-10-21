package harness

import (
	"testing"
	"time"
)

func testGrant() *CapabilityGrant {
	issued := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	return &CapabilityGrant{
		ContractVersion:        ContractVersion,
		TaskID:                 "task-1",
		RunID:                  "run-1",
		IssuedAt:               issued,
		ExpiresAt:              issued.Add(time.Hour),
		PolicyVersion:          DefaultPolicyVersion,
		CapabilityGrantVersion: "grant-1",
		RepositoryURL:          "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:                "abc123",
		PermittedPaths:         []string{"harness"},
		PermittedTools: []PermittedTool{
			{Identity: "go-test", AllowedArguments: []string{"./harness/"}},
			{Identity: "gofmt", AllowedArguments: []string{"-l"}},
		},
		NetworkDestinations: []string{},
		MaxWallClockSeconds: 600,
	}
}

func runningContext(now time.Time) ActionContext {
	return ActionContext{State: StateRunning, Grant: testGrant(), Now: now}
}

func withinGrantRequest() ActionRequest {
	return ActionRequest{
		Tool:          "go-test",
		Arguments:     []string{"./harness/"},
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
		Branch:        "autofixer/dat-171-fix",
		Paths:         []string{"harness/state.go"},
	}
}

func TestEvaluateActionAllowsRequestWithinGrant(t *testing.T) {
	now := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC)
	d := EvaluateAction(runningContext(now), withinGrantRequest())
	if !d.Allowed {
		t.Errorf("Allowed = false, want true (code %q)", d.Code)
	}
	if d.Code != AllowWithinGrant {
		t.Errorf("Code = %q, want %q", d.Code, AllowWithinGrant)
	}
	if d.StopCode != "" {
		t.Errorf("StopCode = %q, want empty", d.StopCode)
	}
}

func TestEvaluateActionAllowsNoBranchNoPathRequest(t *testing.T) {
	now := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC)
	req := withinGrantRequest()
	req.Branch = ""
	req.Paths = nil
	d := EvaluateAction(runningContext(now), req)
	if !d.Allowed {
		t.Errorf("Allowed = false, want true (code %q)", d.Code)
	}
}

func TestEvaluateActionDeniesEachOutOfGrantRequest(t *testing.T) {
	now := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC)
	cases := []struct {
		name     string
		mutate   func(*ActionRequest)
		code     string
		stopCode string
	}{
		{"wrong tool identity", func(r *ActionRequest) { r.Tool = "rm-rf" }, DenyToolNotPermitted, StopCodeOutOfGrant},
		{"empty tool", func(r *ActionRequest) { r.Tool = "" }, DenyToolNotPermitted, StopCodeOutOfGrant},
		{"unlisted argument", func(r *ActionRequest) { r.Arguments = []string{"-count=1"} }, DenyToolArgumentNotPermitted, StopCodeOutOfGrant},
		{"extra argument beyond allowlist", func(r *ActionRequest) { r.Arguments = []string{"./harness/", "-race"} }, DenyToolArgumentNotPermitted, StopCodeOutOfGrant},
		{"argument not in this tool's allowlist", func(r *ActionRequest) { r.Tool = "gofmt" }, DenyToolArgumentNotPermitted, StopCodeOutOfGrant},
		{"wrong repository", func(r *ActionRequest) { r.RepositoryURL = "https://github.com/evil/other.git" }, DenyRepositoryMismatch, StopCodeOutOfGrant},
		{"empty repository", func(r *ActionRequest) { r.RepositoryURL = "" }, DenyRepositoryMismatch, StopCodeOutOfGrant},
		{"wrong base sha", func(r *ActionRequest) { r.BaseSHA = "def456" }, DenyBaseSHAMismatch, StopCodeOutOfGrant},
		{"empty base sha", func(r *ActionRequest) { r.BaseSHA = "" }, DenyBaseSHAMismatch, StopCodeOutOfGrant},
		{"write main branch", func(r *ActionRequest) { r.Branch = "main" }, DenyBranchForbidden, StopCodeOutOfGrant},
		{"write non-autofixer branch", func(r *ActionRequest) { r.Branch = "feature/x" }, DenyBranchForbidden, StopCodeOutOfGrant},
		{"path outside grant", func(r *ActionRequest) { r.Paths = []string{"secrets/key"} }, DenyPathNotPermitted, StopCodeOutOfGrant},
		{"sibling directory prefix confusion", func(r *ActionRequest) { r.Paths = []string{"harness-evil/x"} }, DenyPathNotPermitted, StopCodeOutOfGrant},
		{"network destination not granted", func(r *ActionRequest) { r.NetworkDestinations = []string{"example.com"} }, DenyNetworkNotPermitted, StopCodeOutOfGrant},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := withinGrantRequest()
			tc.mutate(&req)
			d := EvaluateAction(runningContext(now), req)
			if d.Allowed {
				t.Fatalf("Allowed = true, want false (code %q)", tc.code)
			}
			if d.Code != tc.code {
				t.Errorf("Code = %q, want %q", d.Code, tc.code)
			}
			if d.StopCode != tc.stopCode {
				t.Errorf("StopCode = %q, want %q", d.StopCode, tc.stopCode)
			}
		})
	}
}

func TestEvaluateActionDeniesOutsideRunningState(t *testing.T) {
	now := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC)
	for _, state := range []State{StateRequested, StateApproved, StateAwaitingReview, StateCancelled, StateStopped, StateMerged} {
		ctx := runningContext(now)
		ctx.State = state
		d := EvaluateAction(ctx, withinGrantRequest())
		if d.Allowed || d.Code != DenyStateNotRunning {
			t.Errorf("state %q: Allowed=%v Code=%q, want false/%q", state, d.Allowed, d.Code, DenyStateNotRunning)
		}
		if d.StopCode != "" {
			t.Errorf("state %q: StopCode = %q, want empty", state, d.StopCode)
		}
	}
}

func TestEvaluateActionDeniesWithoutOrWithRevokedGrant(t *testing.T) {
	now := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC)

	ctx := runningContext(now)
	ctx.Grant = nil
	d := EvaluateAction(ctx, withinGrantRequest())
	if d.Allowed || d.Code != DenyGrantMissing {
		t.Errorf("nil grant: Allowed=%v Code=%q, want false/%q", d.Allowed, d.Code, DenyGrantMissing)
	}

	ctx = runningContext(now)
	ctx.Revoked = true
	d = EvaluateAction(ctx, withinGrantRequest())
	if d.Allowed || d.Code != DenyGrantRevoked {
		t.Errorf("revoked grant: Allowed=%v Code=%q, want false/%q", d.Allowed, d.Code, DenyGrantRevoked)
	}
}

func TestEvaluateActionDeniesExpiredGrant(t *testing.T) {
	issued := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	afterExpiry := issued.Add(2 * time.Hour)
	d := EvaluateAction(runningContext(afterExpiry), withinGrantRequest())
	if d.Allowed || d.Code != DenyGrantExpired {
		t.Errorf("Allowed=%v Code=%q, want false/%q", d.Allowed, d.Code, DenyGrantExpired)
	}
	if d.StopCode != StopCodeGrantExpired {
		t.Errorf("StopCode = %q, want %q", d.StopCode, StopCodeGrantExpired)
	}

	// exactly at expiry is expired (fail closed)
	atExpiry := issued.Add(time.Hour)
	d = EvaluateAction(runningContext(atExpiry), withinGrantRequest())
	if d.Allowed || d.Code != DenyGrantExpired {
		t.Errorf("at expiry: Allowed=%v Code=%q, want false/%q", d.Allowed, d.Code, DenyGrantExpired)
	}
}

func TestEvaluateActionDeniesDeterministicallyOnFirstFailedCheck(t *testing.T) {
	now := time.Date(2026, 10, 21, 9, 30, 0, 0, time.UTC)
	req := withinGrantRequest()
	req.RepositoryURL = "https://github.com/evil/other.git"
	req.Tool = "rm-rf"
	d := EvaluateAction(runningContext(now), req)
	if d.Code != DenyRepositoryMismatch {
		t.Errorf("Code = %q, want %q (repository checked before tool)", d.Code, DenyRepositoryMismatch)
	}
}
