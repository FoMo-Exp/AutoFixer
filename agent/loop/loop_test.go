package loop_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/agent/loop"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

type fakeClock struct {
	now time.Time
}

func (c *fakeClock) Now() time.Time          { return c.now }
func (c *fakeClock) advance(d time.Duration) { c.now = c.now.Add(d) }

type fakePlanner struct {
	plan  loop.Plan
	err   error
	calls int
	fn    func(ctx context.Context, in loop.TaskInput)
}

func (p *fakePlanner) Plan(ctx context.Context, in loop.TaskInput) (loop.Plan, error) {
	p.calls++
	if p.fn != nil {
		p.fn(ctx, in)
	}
	return p.plan, p.err
}

// fakeExecutor stands in for sandbox.Runner: it records dispatch and outcome
// evidence through the same harness calls the sandbox uses, but leaves
// cancel/timeout state transitions to the loop under test.
type fakeExecutor struct {
	run   *harness.Run
	clock *fakeClock
	calls []sandbox.Spec
	fn    func(ctx context.Context, ex *fakeExecutor, spec sandbox.Spec) (sandbox.Result, error)
}

func (ex *fakeExecutor) Execute(ctx context.Context, spec sandbox.Spec) (sandbox.Result, error) {
	ex.calls = append(ex.calls, spec)
	if ex.fn != nil {
		return ex.fn(ctx, ex, spec)
	}
	return ex.recordAllow(spec)
}

func (ex *fakeExecutor) actionRequest(spec sandbox.Spec) harness.ActionRequest {
	return harness.ActionRequest{
		Tool:                spec.Tool,
		Arguments:           append([]string{}, spec.Arguments...),
		RepositoryURL:       ex.run.RepositoryURL,
		BaseSHA:             ex.run.BaseSHA,
		Paths:               append([]string{}, spec.Paths...),
		NetworkDestinations: append([]string{}, spec.NetworkDestinations...),
	}
}

// recordAllow emulates an allowed sandbox dispatch: policy decision first,
// then the observed completion record.
func (ex *fakeExecutor) recordAllow(spec sandbox.Spec) (sandbox.Result, error) {
	req := ex.actionRequest(spec)
	decision := ex.run.EvaluateAndRecordAction(req)
	result := sandbox.Result{Decision: decision}
	if !decision.Allowed {
		return result, nil
	}
	status := 0
	if err := ex.run.RecordExecutionOutcome(req, harness.ExecutionOutcome{
		ExitStatus:   &status,
		OutputDigest: &harness.Digest{Algorithm: harness.DigestAlgorithmSHA256, Value: "fake-output"},
		Code:         harness.AllowWithinGrant,
	}); err != nil {
		return result, err
	}
	return result, nil
}

type fakeFactory struct {
	executor *fakeExecutor
	err      error
	calls    int
}

func (f *fakeFactory) make(run *harness.Run) (loop.Executor, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	f.executor.run = run
	return f.executor, nil
}

func baseInput() loop.TaskInput {
	return loop.TaskInput{
		TaskID:            "task-1",
		RunID:             "run-1",
		IssueID:           "issue-1",
		RepositoryURL:     "https://github.com/example/repo.git",
		BaseSHA:           "base111",
		ActorIdentity:     "human:tester",
		ExecutionIdentity: "agent:runner",
		RequestedWork: harness.ProposedWork{
			LocalizedReversibleChange: true,
		},
		Grant: loop.GrantInput{
			CapabilityGrantVersion: "cg-1",
			PermittedPaths:         []string{"."},
			PermittedTools: []harness.PermittedTool{{
				Identity:         "echo",
				AllowedArguments: []string{"hello"},
			}},
			MaxWallClockSeconds: 30,
		},
		Actions: []loop.Action{{
			Tool:      "echo",
			Arguments: []string{"hello"},
		}},
	}
}

type runHarness struct {
	runner   *loop.Runner
	store    *harness.EventStore
	planner  *fakePlanner
	factory  *fakeFactory
	executor *fakeExecutor
	clock    *fakeClock
}

func newRunHarness(t *testing.T, planner *fakePlanner, executor *fakeExecutor, factory *fakeFactory) runHarness {
	t.Helper()
	if planner == nil {
		planner = &fakePlanner{plan: loop.Plan{Actions: []loop.Action{{
			Tool:      "echo",
			Arguments: []string{"hello"},
		}}}}
	}
	if executor == nil {
		executor = &fakeExecutor{}
	}
	if factory == nil {
		factory = &fakeFactory{executor: executor}
	}
	store := harness.NewEventStore()
	clock := &fakeClock{now: time.Now()}
	runner := loop.New(store, planner, factory.make)
	runner.Now = clock.Now
	return runHarness{runner: runner, store: store, planner: planner, factory: factory, executor: executor, clock: clock}
}

func stateCodes(t *testing.T, store *harness.EventStore, runID string) []string {
	t.Helper()
	var out []string
	for _, ev := range store.Events(runID) {
		if ev.EventType != harness.EventTypeStateTransition {
			continue
		}
		code := ""
		if ev.DecisionOrStopCode != nil {
			code = *ev.DecisionOrStopCode
		}
		if ev.PriorState == ev.ResultingState {
			out = append(out, "refused:"+code)
			continue
		}
		out = append(out, string(ev.PriorState)+"->"+string(ev.ResultingState)+":"+code)
	}
	return out
}

func requireEqual(t *testing.T, got, want []string, label string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s = %v, want %v", label, got, want)
		}
	}
}

func TestRunCompletesWithoutReviewBindingAndStopsForHumanDisposition(t *testing.T) {
	h := newRunHarness(t, nil, nil, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeCompleted || res.ExitCode != loop.ExitOK {
		t.Fatalf("outcome = %q exit %d, want completed/0", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateStopped {
		t.Fatalf("state = %q, want stopped", res.State)
	}
	if res.Code != loop.StopCodeLocalReviewRequired {
		t.Fatalf("code = %q, want %q", res.Code, loop.StopCodeLocalReviewRequired)
	}
	if res.RiskClass != harness.RiskLow || res.RiskDecisionCode != harness.DecisionRiskLowApproved {
		t.Fatalf("risk = %q/%q, want low/risk_low_approved", res.RiskClass, res.RiskDecisionCode)
	}
	if res.ActionsDispatched != 1 {
		t.Fatalf("actions dispatched = %d, want 1", res.ActionsDispatched)
	}
	if res.TaskID != "task-1" || res.RunID != "run-1" {
		t.Fatalf("result linkage = %q/%q, want task-1/run-1", res.TaskID, res.RunID)
	}
	if h.planner.calls != 1 {
		t.Fatalf("planner calls = %d, want 1", h.planner.calls)
	}
	if h.factory.calls != 1 {
		t.Fatalf("factory calls = %d, want 1", h.factory.calls)
	}
	if err := h.store.VerifyChain("run-1"); err != nil {
		t.Fatalf("evidence chain: %v", err)
	}
	requireEqual(t, stateCodes(t, h.store, "run-1"), []string{
		"requested->approved:" + harness.DecisionGrantIssued,
		"approved->running:" + sandbox.CodeExecutionStarted,
		"running->stopped:" + loop.StopCodeLocalReviewRequired,
	}, "state transitions")

	var toolEvents int
	for _, ev := range h.store.Events("run-1") {
		if ev.EventType == harness.EventTypeToolInvocation {
			toolEvents++
			if ev.DecisionOrStopCode == nil || *ev.DecisionOrStopCode != harness.AllowWithinGrant {
				t.Fatalf("tool event decision = %v, want allow_within_grant", ev.DecisionOrStopCode)
			}
		}
	}
	if toolEvents != 2 {
		t.Fatalf("tool invocation events = %d, want 2 (dispatch + outcome)", toolEvents)
	}
}

func TestRunHandsOffToAwaitingReviewWhenBindingProvided(t *testing.T) {
	h := newRunHarness(t, nil, nil, nil)
	in := baseInput()
	in.Review = &loop.Review{
		Branch:  "autofixer/task-1",
		HeadSHA: "head222",
		PRID:    "pr-42",
	}

	res, err := h.runner.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeCompleted || res.ExitCode != loop.ExitOK {
		t.Fatalf("outcome = %q exit %d, want completed/0", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateAwaitingReview || res.Code != loop.CodeReviewRequested {
		t.Fatalf("state/code = %q/%q, want awaiting_review/%q", res.State, res.Code, loop.CodeReviewRequested)
	}
	if err := h.store.VerifyChain("run-1"); err != nil {
		t.Fatalf("evidence chain: %v", err)
	}
	requireEqual(t, stateCodes(t, h.store, "run-1"), []string{
		"requested->approved:" + harness.DecisionGrantIssued,
		"approved->running:" + sandbox.CodeExecutionStarted,
		"running->awaiting_review:" + loop.CodeReviewRequested,
	}, "state transitions")
}

func TestRunRejectsProhibitedWorkWithoutGrantOrDispatch(t *testing.T) {
	h := newRunHarness(t, nil, nil, nil)
	in := baseInput()
	in.RequestedWork.RequestsSecretAccess = true

	res, err := h.runner.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeRejected || res.ExitCode != loop.ExitRejected {
		t.Fatalf("outcome = %q exit %d, want rejected/3", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateRejected {
		t.Fatalf("state = %q, want rejected", res.State)
	}
	if res.Code != harness.DecisionProhibitedSecretAccess {
		t.Fatalf("code = %q, want %q", res.Code, harness.DecisionProhibitedSecretAccess)
	}
	if h.planner.calls != 0 {
		t.Fatalf("planner calls = %d, want 0", h.planner.calls)
	}
	if h.factory.calls != 0 {
		t.Fatalf("factory calls = %d, want 0", h.factory.calls)
	}
	if err := h.store.VerifyChain("run-1"); err != nil {
		t.Fatalf("evidence chain: %v", err)
	}
	requireEqual(t, stateCodes(t, h.store, "run-1"), []string{
		"requested->rejected:" + harness.DecisionProhibitedSecretAccess,
	}, "state transitions")
}

func TestRunRefusesElevatedWorkWithoutApproval(t *testing.T) {
	h := newRunHarness(t, nil, nil, nil)
	in := baseInput()
	in.RequestedWork = harness.ProposedWork{BroadRefactor: true}

	// harness.NewRiskAssessment cannot record an elevated assessment without a
	// named pre-grant approval, so there is no run to reject: the input itself
	// is refused before any run exists.
	_, err := h.runner.Run(context.Background(), in)
	if !errors.Is(err, loop.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if events := h.store.All(); len(events) != 0 {
		t.Fatalf("events = %d, want 0", len(events))
	}
	if h.planner.calls != 0 {
		t.Fatalf("planner calls = %d, want 0", h.planner.calls)
	}
}

func TestRunApprovesElevatedWorkWithPreGrantApproval(t *testing.T) {
	h := newRunHarness(t, nil, nil, nil)
	in := baseInput()
	in.RequestedWork = harness.ProposedWork{BroadRefactor: true}
	in.ElevatedApproval = &harness.ApprovalReference{
		Reference:        "evidence://grant-approvals/run-1",
		ApproverIdentity: "human:reviewer",
		ApprovedAt:       h.clock.now.Add(-time.Hour),
	}

	res, err := h.runner.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeCompleted || res.RiskClass != harness.RiskElevated {
		t.Fatalf("outcome/risk = %q/%q, want completed/elevated", res.Outcome, res.RiskClass)
	}
	if h.planner.calls != 1 {
		t.Fatalf("planner calls = %d, want 1", h.planner.calls)
	}
}

func TestRunRejectsWhenPlannerRejects(t *testing.T) {
	planner := &fakePlanner{plan: loop.Plan{Rejection: &loop.Rejection{
		Code:   "planner_refused_task",
		Reason: "task is out of planner scope",
	}}}
	h := newRunHarness(t, planner, nil, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeRejected || res.ExitCode != loop.ExitRejected {
		t.Fatalf("outcome = %q exit %d, want rejected/3", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateRejected || res.Code != "planner_refused_task" {
		t.Fatalf("state/code = %q/%q, want rejected/planner_refused_task", res.State, res.Code)
	}
	if h.factory.calls != 0 {
		t.Fatalf("factory calls = %d, want 0", h.factory.calls)
	}
	requireEqual(t, stateCodes(t, h.store, "run-1"), []string{
		"requested->rejected:planner_refused_task",
	}, "state transitions")
}

func TestRunRejectsWhenPlannerErrors(t *testing.T) {
	planner := &fakePlanner{err: errors.New("planner exploded")}
	h := newRunHarness(t, planner, nil, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeRejected || res.State != harness.StateRejected {
		t.Fatalf("outcome/state = %q/%q, want rejected/rejected", res.Outcome, res.State)
	}
	if res.Code != loop.CodePlanRejected {
		t.Fatalf("code = %q, want %q", res.Code, loop.CodePlanRejected)
	}
}

func TestRunRejectsMalformedPlan(t *testing.T) {
	planner := &fakePlanner{plan: loop.Plan{Actions: []loop.Action{{Tool: ""}}}}
	h := newRunHarness(t, planner, nil, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeRejected || res.Code != loop.CodeInvalidPlan {
		t.Fatalf("outcome/code = %q/%q, want rejected/%q", res.Outcome, res.Code, loop.CodeInvalidPlan)
	}
	if h.factory.calls != 0 {
		t.Fatalf("factory calls = %d, want 0", h.factory.calls)
	}
}

func TestRunCancelsWhilePlanning(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	planner := &fakePlanner{plan: loop.Plan{Actions: []loop.Action{{
		Tool: "echo", Arguments: []string{"hello"},
	}}}, fn: func(context.Context, loop.TaskInput) { cancel() }}
	h := newRunHarness(t, planner, nil, nil)

	res, err := h.runner.Run(ctx, baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeCancelled || res.ExitCode != loop.ExitCancelled {
		t.Fatalf("outcome = %q exit %d, want cancelled/4", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateCancelled || res.Code != loop.CodeTaskCancelled {
		t.Fatalf("state/code = %q/%q, want cancelled/%q", res.State, res.Code, loop.CodeTaskCancelled)
	}
	if h.factory.calls != 0 {
		t.Fatalf("factory calls = %d, want 0", h.factory.calls)
	}
	requireEqual(t, stateCodes(t, h.store, "run-1"), []string{
		"requested->cancelled:" + loop.CodeTaskCancelled,
	}, "state transitions")
}

func TestRunCancelsAtEntry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h := newRunHarness(t, nil, nil, nil)

	res, err := h.runner.Run(ctx, baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeCancelled || res.State != harness.StateCancelled {
		t.Fatalf("outcome/state = %q/%q, want cancelled/cancelled", res.Outcome, res.State)
	}
	if res.Code != loop.CodeTaskCancelled {
		t.Fatalf("code = %q, want %q", res.Code, loop.CodeTaskCancelled)
	}
}

func TestRunTimesOutWhilePlanning(t *testing.T) {
	planner := &fakePlanner{plan: loop.Plan{Actions: []loop.Action{{
		Tool: "echo", Arguments: []string{"hello"},
	}}}}
	h := newRunHarness(t, planner, nil, nil)
	in := baseInput()
	in.Timeout = 10 * time.Second
	planner.fn = func(context.Context, loop.TaskInput) { h.clock.advance(11 * time.Second) }

	res, err := h.runner.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeTimedOut || res.ExitCode != loop.ExitTimedOut {
		t.Fatalf("outcome = %q exit %d, want timed_out/5", res.Outcome, res.ExitCode)
	}
	// The ADR state table has no timed_out edge from requested, so the
	// attempt ends cancelled with an explicit timeout reason.
	if res.State != harness.StateCancelled || res.Code != loop.CodeTaskTimedOut {
		t.Fatalf("state/code = %q/%q, want cancelled/%q", res.State, res.Code, loop.CodeTaskTimedOut)
	}
	if h.factory.calls != 0 {
		t.Fatalf("factory calls = %d, want 0", h.factory.calls)
	}
}

func TestRunTimesOutAfterDispatchByDeadline(t *testing.T) {
	executor := &fakeExecutor{}
	h := newRunHarness(t, nil, executor, nil)
	executor.clock = h.clock
	executor.fn = func(_ context.Context, ex *fakeExecutor, spec sandbox.Spec) (sandbox.Result, error) {
		result, err := ex.recordAllow(spec)
		ex.clock.advance(11 * time.Second)
		return result, err
	}
	in := baseInput()
	in.Timeout = 10 * time.Second

	res, err := h.runner.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeTimedOut || res.ExitCode != loop.ExitTimedOut {
		t.Fatalf("outcome = %q exit %d, want timed_out/5", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateTimedOut || res.Code != loop.CodeTaskTimedOut {
		t.Fatalf("state/code = %q/%q, want timed_out/%q", res.State, res.Code, loop.CodeTaskTimedOut)
	}
	if err := h.store.VerifyChain("run-1"); err != nil {
		t.Fatalf("evidence chain: %v", err)
	}
}

func TestRunRecordsGrantWallClockTimeout(t *testing.T) {
	executor := &fakeExecutor{fn: func(_ context.Context, ex *fakeExecutor, spec sandbox.Spec) (sandbox.Result, error) {
		result, err := ex.recordAllow(spec)
		result.TimedOut = true
		return result, err
	}}
	h := newRunHarness(t, nil, executor, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeTimedOut || res.ExitCode != loop.ExitTimedOut {
		t.Fatalf("outcome = %q exit %d, want timed_out/5", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateTimedOut || res.Code != sandbox.CodeExecutionTimedOut {
		t.Fatalf("state/code = %q/%q, want timed_out/%q", res.State, res.Code, sandbox.CodeExecutionTimedOut)
	}
}

func TestRunRecordsCancellationDuringDispatch(t *testing.T) {
	executor := &fakeExecutor{fn: func(_ context.Context, ex *fakeExecutor, spec sandbox.Spec) (sandbox.Result, error) {
		result, err := ex.recordAllow(spec)
		result.Canceled = true
		return result, err
	}}
	h := newRunHarness(t, nil, executor, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeCancelled || res.ExitCode != loop.ExitCancelled {
		t.Fatalf("outcome = %q exit %d, want cancelled/4", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateCancelled || res.Code != sandbox.CodeExecutionCancelled {
		t.Fatalf("state/code = %q/%q, want cancelled/%q", res.State, res.Code, sandbox.CodeExecutionCancelled)
	}
	if err := h.store.VerifyChain("run-1"); err != nil {
		t.Fatalf("evidence chain: %v", err)
	}
}

func TestRunStopsRunOnPolicyDenial(t *testing.T) {
	executor := &fakeExecutor{}
	planner := &fakePlanner{plan: loop.Plan{Actions: []loop.Action{
		{Tool: "echo", Arguments: []string{"hello"}},
		// "goodbye" is outside the grant's argument allowlist.
		{Tool: "echo", Arguments: []string{"goodbye"}},
		{Tool: "echo", Arguments: []string{"hello"}},
	}}}
	h := newRunHarness(t, planner, executor, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeDenied || res.ExitCode != loop.ExitStopped {
		t.Fatalf("outcome = %q exit %d, want denied/6", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateStopped || res.Code != harness.StopCodeOutOfGrant {
		t.Fatalf("state/code = %q/%q, want stopped/%q", res.State, res.Code, harness.StopCodeOutOfGrant)
	}
	if len(executor.calls) != 2 {
		t.Fatalf("executor calls = %d, want 2 (the denied dispatch is the second; no third call)", len(executor.calls))
	}
	if err := h.store.VerifyChain("run-1"); err != nil {
		t.Fatalf("evidence chain: %v", err)
	}
}

func TestRunStopsWhenDispatchDeniedWithoutStopCondition(t *testing.T) {
	executor := &fakeExecutor{fn: func(_ context.Context, _ *fakeExecutor, spec sandbox.Spec) (sandbox.Result, error) {
		return sandbox.Result{Decision: harness.Decision{
			Allowed: false,
			Code:    harness.DenyGrantRevoked,
		}}, nil
	}}
	h := newRunHarness(t, nil, executor, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeDenied || res.ExitCode != loop.ExitStopped {
		t.Fatalf("outcome = %q exit %d, want denied/6", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateStopped || res.Code != harness.DenyGrantRevoked {
		t.Fatalf("state/code = %q/%q, want stopped/%q", res.State, res.Code, harness.DenyGrantRevoked)
	}
}

func TestRunStopsRunWhenExecutorFails(t *testing.T) {
	executor := &fakeExecutor{fn: func(context.Context, *fakeExecutor, sandbox.Spec) (sandbox.Result, error) {
		return sandbox.Result{}, errors.New("tool failed to start")
	}}
	h := newRunHarness(t, nil, executor, nil)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeFailed || res.ExitCode != loop.ExitStopped {
		t.Fatalf("outcome = %q exit %d, want failed/6", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateStopped || res.Code != loop.StopCodeExecutionFailure {
		t.Fatalf("state/code = %q/%q, want stopped/%q", res.State, res.Code, loop.StopCodeExecutionFailure)
	}
}

func TestRunStopsWhenExecutorFactoryFails(t *testing.T) {
	factory := &fakeFactory{err: errors.New("cannot create workspace")}
	h := newRunHarness(t, nil, nil, factory)

	res, err := h.runner.Run(context.Background(), baseInput())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeFailed || res.ExitCode != loop.ExitStopped {
		t.Fatalf("outcome = %q exit %d, want failed/6", res.Outcome, res.ExitCode)
	}
	if res.State != harness.StateStopped {
		t.Fatalf("state = %q, want stopped", res.State)
	}
}

func TestRunRejectsInvalidInput(t *testing.T) {
	cases := map[string]func(h runHarness, in *loop.TaskInput){
		"missing task id":        func(_ runHarness, in *loop.TaskInput) { in.TaskID = "" },
		"missing issue id":       func(_ runHarness, in *loop.TaskInput) { in.IssueID = "" },
		"missing repository url": func(_ runHarness, in *loop.TaskInput) { in.RepositoryURL = "" },
		"missing base sha":       func(_ runHarness, in *loop.TaskInput) { in.BaseSHA = "" },
		"missing actor":          func(_ runHarness, in *loop.TaskInput) { in.ActorIdentity = "" },
		"missing execution id":   func(_ runHarness, in *loop.TaskInput) { in.ExecutionIdentity = "" },
		"missing grant version":  func(_ runHarness, in *loop.TaskInput) { in.Grant.CapabilityGrantVersion = "" },
		"zero wall clock":        func(_ runHarness, in *loop.TaskInput) { in.Grant.MaxWallClockSeconds = 0 },
		"negative timeout":       func(_ runHarness, in *loop.TaskInput) { in.Timeout = -time.Second },
		"review branch escapes namespace": func(_ runHarness, in *loop.TaskInput) {
			in.Review = &loop.Review{Branch: "main", HeadSHA: "head", PRID: "pr-1"}
		},
		"review missing head": func(_ runHarness, in *loop.TaskInput) {
			in.Review = &loop.Review{Branch: "autofixer/task-1", PRID: "pr-1"}
		},
		"approval not before issuance": func(h runHarness, in *loop.TaskInput) {
			in.RequestedWork = harness.ProposedWork{BroadRefactor: true}
			in.ElevatedApproval = &harness.ApprovalReference{
				Reference:        "ref",
				ApproverIdentity: "human:reviewer",
				ApprovedAt:       h.clock.now.Add(time.Hour),
			}
		},
		"low work with approval reference": func(h runHarness, in *loop.TaskInput) {
			in.ElevatedApproval = &harness.ApprovalReference{
				Reference:        "ref",
				ApproverIdentity: "human:reviewer",
				ApprovedAt:       h.clock.now.Add(-time.Hour),
			}
		},
		"prohibited work with approval reference": func(h runHarness, in *loop.TaskInput) {
			in.RequestedWork = harness.ProposedWork{RequestsSecretAccess: true}
			in.ElevatedApproval = &harness.ApprovalReference{
				Reference:        "ref",
				ApproverIdentity: "human:reviewer",
				ApprovedAt:       h.clock.now.Add(-time.Hour),
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			h := newRunHarness(t, nil, nil, nil)
			in := baseInput()
			mutate(h, &in)

			res, err := h.runner.Run(context.Background(), in)
			if !errors.Is(err, loop.ErrInvalidInput) {
				t.Fatalf("err = %v, want ErrInvalidInput", err)
			}
			if res.State != "" {
				// Validation happens before a run exists.
				t.Fatalf("state = %q, want no run recorded", res.State)
			}
			if events := h.store.All(); len(events) != 0 {
				t.Fatalf("events = %d, want 0", len(events))
			}
		})
	}
}

func TestRunCapsGrantWallClockByTaskTimeout(t *testing.T) {
	executor := &fakeExecutor{}
	h := newRunHarness(t, nil, executor, nil)
	var issuedAt, expiresAt time.Time
	executor.fn = func(_ context.Context, ex *fakeExecutor, spec sandbox.Spec) (sandbox.Result, error) {
		issuedAt = ex.run.Grant.IssuedAt
		expiresAt = ex.run.Grant.ExpiresAt
		return ex.recordAllow(spec)
	}
	in := baseInput()
	in.Timeout = 10 * time.Second // grant wall clock in the input is 30s

	res, err := h.runner.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != loop.OutcomeCompleted {
		t.Fatalf("outcome = %q, want completed", res.Outcome)
	}
	if got := expiresAt.Sub(issuedAt); got != 10*time.Second {
		t.Fatalf("grant validity = %s, want 10s (capped by the task timeout)", got)
	}
}
