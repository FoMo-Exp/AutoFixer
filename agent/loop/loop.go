// Package loop orchestrates one controlled remediation task attempt for the
// local AutoFixer agent prototype (ADR 0002). It drives the existing
// harness run state machine, risk classification, and append-only audit
// evidence, and obtains tool execution only through an injected executor that
// sandbox.Runner satisfies. The loop performs no policy decisions of its own,
// executes no host command directly, and never talks to a network provider:
// deny-by-default stays with harness and sandbox.
package loop

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// Decision and stop codes the loop records on its own transitions. Codes for
// grant issuance, execution start, timeout, and cancellation are reused from
// harness and sandbox so the evidence chain carries one vocabulary.
const (
	CodePlanRejected    = "plan_rejected"
	CodeInvalidPlan     = "invalid_plan"
	CodeTaskCancelled   = "task_cancelled"
	CodeTaskTimedOut    = "task_timed_out"
	CodeReviewRequested = "review_requested"
	CodeControlFailure  = "control_failure"

	// StopCodeLocalReviewRequired ends a locally completed run that has no
	// PR binding: the ADR state table offers no terminal success state
	// without one, so the grant is revoked and a human decides next steps.
	StopCodeLocalReviewRequired = "stop_local_review_required"
	// StopCodeExecutionFailure stops the run when the executor factory or a
	// dispatch fails, because the remaining plan can no longer proceed.
	StopCodeExecutionFailure = "stop_execution_failure"
)

// Exit codes the CLI maps terminal results to.
const (
	ExitOK             = 0
	ExitControlFailure = 1
	ExitInvalidInput   = 2
	ExitRejected       = 3
	ExitCancelled      = 4
	ExitTimedOut       = 5
	ExitStopped        = 6
)

// Outcome is the structured result of one task attempt.
type Outcome string

const (
	OutcomeCompleted      Outcome = "completed"
	OutcomeRejected       Outcome = "rejected"
	OutcomeCancelled      Outcome = "cancelled"
	OutcomeTimedOut       Outcome = "timed_out"
	OutcomeDenied         Outcome = "denied"
	OutcomeFailed         Outcome = "failed"
	OutcomeControlFailure Outcome = "control_failure"
)

// ErrInvalidInput marks a refused task input: the CLI maps it to a non-zero
// exit without creating a run.
var ErrInvalidInput = errors.New("loop: invalid task input")

// Action is one planned dispatch the executor is asked to perform. It only
// declares scope; permission stays with the harness policy evaluated inside
// the executor.
type Action struct {
	Tool                string   `json:"tool"`
	Arguments           []string `json:"arguments,omitempty"`
	Paths               []string `json:"paths,omitempty"`
	NetworkDestinations []string `json:"network_destinations,omitempty"`
}

// Rejection is a planner's explicit refusal to plan a task.
type Rejection struct {
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

// Plan is the planner's structured result: declarative actions, or an
// explicit rejection. An invalid plan (for example an action without a tool
// identity) is terminal.
type Plan struct {
	Actions   []Action   `json:"actions,omitempty"`
	Rejection *Rejection `json:"rejection,omitempty"`
}

// Planner produces the structured plan for one task attempt. The prototype
// composes a deterministic implementation; production planning stays behind
// this interface.
type Planner interface {
	Plan(ctx context.Context, in TaskInput) (Plan, error)
}

// Executor dispatches one planned action. The method set is exactly
// sandbox.Runner's, so the sandbox is the production implementation and
// tests may inject a fake. An executor is expected to record the harness
// policy decision and execution outcome for every dispatch.
type Executor interface {
	Execute(ctx context.Context, spec sandbox.Spec) (sandbox.Result, error)
}

// ExecutorFactory builds the executor once the harness run exists (the
// sandbox binds its workspace to the run). A run with no planned actions
// never calls the factory.
type ExecutorFactory func(run *harness.Run) (Executor, error)

// GrantInput is the capability-grant scope declared by the controlled task
// input. The loop forwards it to harness.IssueGrant unchanged, except for
// capping the wall-clock bound by the task timeout.
type GrantInput struct {
	CapabilityGrantVersion string                  `json:"capability_grant_version"`
	PermittedPaths         []string                `json:"permitted_paths,omitempty"`
	PermittedTools         []harness.PermittedTool `json:"permitted_tools,omitempty"`
	NetworkDestinations    []string                `json:"network_destinations,omitempty"`
	MaxWallClockSeconds    int                     `json:"max_wall_clock_seconds"`
	ResourceLimits         harness.ResourceLimits  `json:"resource_limits,omitempty"`
	MayCreatePatch         bool                    `json:"may_create_patch,omitempty"`
	MayCreateOrUpdatePR    bool                    `json:"may_create_or_update_pr,omitempty"`
}

// Review is an existing pull request bound to the current commit; it is
// recorded, never created by the loop.
type Review struct {
	Branch  string `json:"branch"`
	HeadSHA string `json:"head_sha"`
	PRID    string `json:"pr_id"`
}

// TaskInput is the controlled, local input for one task attempt.
type TaskInput struct {
	TaskID            string
	RunID             string // optional; generated when empty
	IssueID           string
	RepositoryURL     string
	BaseSHA           string
	ActorIdentity     string
	ExecutionIdentity string

	// RequestedWork carries the FP-01 risk indicators.
	RequestedWork harness.ProposedWork

	// ElevatedApproval is required when RequestedWork classifies as elevated.
	ElevatedApproval *harness.ApprovalReference

	Grant GrantInput

	// Actions are the actions declared by the input for the composed planner.
	Actions []Action

	// Review, when present, binds an existing PR and completes the run in
	// awaiting_review; when absent the completed run stops for human
	// disposition.
	Review *Review

	// Timeout bounds the whole attempt, enforced at every phase boundary and
	// by capping the capability grant's wall clock. Zero disables it.
	Timeout time.Duration
}

// Result is the structured terminal result of one task attempt.
type Result struct {
	TaskID            string            `json:"task_id"`
	RunID             string            `json:"run_id"`
	Outcome           Outcome           `json:"outcome"`
	State             harness.State     `json:"terminal_state"`
	Code              string            `json:"code"`
	Reason            string            `json:"reason"`
	RiskClass         harness.RiskClass `json:"risk_class"`
	RiskDecisionCode  string            `json:"risk_decision_code"`
	ActionsDispatched int               `json:"actions_dispatched"`
	ExitCode          int               `json:"exit_code"`
}

// Runner drives one task attempt at a time against an injected planner and
// executor factory. It is not safe for concurrent use.
type Runner struct {
	Store    *harness.EventStore
	Planner  Planner
	Executor ExecutorFactory

	// Now supplies the clock; tests inject a deterministic one. Defaults to
	// time.Now.
	Now func() time.Time
}

// New builds a Runner over the shared append-only event store.
func New(store *harness.EventStore, planner Planner, factory ExecutorFactory) *Runner {
	return &Runner{Store: store, Planner: planner, Executor: factory}
}

type interrupt int

const (
	interruptNone interrupt = iota
	interruptCancel
	interruptTimeout
)

// Run performs one complete task attempt: validate input, classify risk,
// plan, issue the capability grant, dispatch every planned action through the
// executor, and finish in the state the ADR table allows. Terminal outcomes
// carry an ExitCode; only control failures and unexpected errors also return
// a non-nil error.
func (r *Runner) Run(ctx context.Context, in TaskInput) (Result, error) {
	if r == nil || r.Store == nil {
		return Result{}, errors.New("loop: runner requires an event store")
	}
	if r.Planner == nil {
		return Result{}, errors.New("loop: runner requires a planner")
	}
	if r.Executor == nil {
		return Result{}, errors.New("loop: runner requires an executor factory")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := r.Now
	if now == nil {
		now = time.Now
	}
	startedAt := now()

	if err := validateInput(in); err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	if in.RunID == "" {
		in.RunID = newRunID()
	}
	class, decisionCode := harness.AssessRisk(in.RequestedWork)
	if err := validateApproval(in, class, startedAt); err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	assessment, err := harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID:             in.TaskID,
		RunID:              in.RunID,
		AssessedAt:         startedAt,
		AssessorIdentity:   in.ActorIdentity,
		RationaleReference: "evidence://risk/" + in.TaskID,
	}, class, decisionCode, elevatedApproval(in, class))
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	run, err := harness.NewRun(harness.RunConfig{
		TaskID:            in.TaskID,
		RunID:             in.RunID,
		IssueID:           in.IssueID,
		ActorIdentity:     in.ActorIdentity,
		ExecutionIdentity: in.ExecutionIdentity,
		RepositoryURL:     in.RepositoryURL,
		BaseSHA:           in.BaseSHA,
	}, assessment, r.Store)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}

	res := Result{
		TaskID:           run.TaskID,
		RunID:            run.RunID,
		State:            run.State,
		RiskClass:        assessment.RiskClass,
		RiskDecisionCode: assessment.DecisionCode,
		ExitCode:         ExitControlFailure,
	}

	if kind := interruptOf(ctx, now(), startedAt, in.Timeout); kind != interruptNone {
		return r.finishInterrupted(run, &res, kind)
	}
	if class == harness.RiskProhibited {
		return r.stopWith(run, &res, harness.StateRejected, OutcomeRejected, decisionCode,
			ExitRejected, "prohibited work is rejected rather than downgraded")
	}

	plan, planErr := r.Planner.Plan(ctx, in)
	if kind := interruptOf(ctx, now(), startedAt, in.Timeout); kind != interruptNone {
		return r.finishInterrupted(run, &res, kind)
	}
	if planErr != nil {
		return r.stopWith(run, &res, harness.StateRejected, OutcomeRejected, CodePlanRejected,
			ExitRejected, "planner refused the task: "+planErr.Error())
	}
	if plan.Rejection != nil {
		code := plan.Rejection.Code
		if code == "" {
			code = CodePlanRejected
		}
		reason := plan.Rejection.Reason
		if reason == "" {
			reason = "planner rejected the task"
		}
		return r.stopWith(run, &res, harness.StateRejected, OutcomeRejected, code, ExitRejected, reason)
	}
	for _, action := range plan.Actions {
		if action.Tool == "" {
			return r.stopWith(run, &res, harness.StateRejected, OutcomeRejected, CodeInvalidPlan,
				ExitRejected, "planner returned an action without a tool identity")
		}
	}

	if err := run.Approve(r.grantParams(in, now())); err != nil {
		return r.controlFailure(run, &res, fmt.Errorf("issue capability grant: %w", err))
	}
	res.State = run.State
	if kind := interruptOf(ctx, now(), startedAt, in.Timeout); kind != interruptNone {
		return r.finishInterrupted(run, &res, kind)
	}
	if err := run.Transition(harness.StateRunning, sandbox.CodeExecutionStarted); err != nil {
		return r.controlFailure(run, &res, fmt.Errorf("enter running: %w", err))
	}
	res.State = run.State

	var exec Executor
	closeExec := func() {
		if closer, ok := exec.(io.Closer); ok && exec != nil {
			_ = closer.Close()
		}
	}
	defer closeExec()

	for _, action := range plan.Actions {
		if kind := interruptOf(ctx, now(), startedAt, in.Timeout); kind != interruptNone {
			return r.finishInterrupted(run, &res, kind)
		}
		if exec == nil {
			created, err := r.Executor(run)
			if err != nil {
				return r.stopWith(run, &res, harness.StateStopped, OutcomeFailed, StopCodeExecutionFailure,
					ExitStopped, "executor unavailable: "+err.Error())
			}
			exec = created
		}
		execResult, err := exec.Execute(ctx, sandbox.Spec{
			Tool:                action.Tool,
			Arguments:           action.Arguments,
			Paths:               action.Paths,
			NetworkDestinations: action.NetworkDestinations,
		})
		if err != nil {
			return r.stopWith(run, &res, harness.StateStopped, OutcomeFailed, StopCodeExecutionFailure,
				ExitStopped, "execution failed: "+err.Error())
		}
		// The sandbox already recorded timeout/cancellation itself when it
		// could; stopWith only transitions when the state does not match yet.
		if execResult.TimedOut {
			return r.stopWith(run, &res, harness.StateTimedOut, OutcomeTimedOut, sandbox.CodeExecutionTimedOut,
				ExitTimedOut, "execution exceeded the capability grant wall clock")
		}
		if execResult.Canceled {
			return r.stopWith(run, &res, harness.StateCancelled, OutcomeCancelled, sandbox.CodeExecutionCancelled,
				ExitCancelled, "execution cancelled")
		}
		if !execResult.Decision.Allowed {
			code := execResult.Decision.StopCode
			if code == "" {
				code = execResult.Decision.Code
			}
			if run.State == harness.StateRunning {
				if err := run.Transition(harness.StateStopped, code); err != nil {
					return r.controlFailure(run, &res, err)
				}
			}
			res.State = run.State
			res.Outcome = OutcomeDenied
			res.Code = code
			res.Reason = "dispatch denied by policy: " + execResult.Decision.Code
			res.ExitCode = ExitStopped
			return res, nil
		}
		res.ActionsDispatched++
	}
	if kind := interruptOf(ctx, now(), startedAt, in.Timeout); kind != interruptNone {
		return r.finishInterrupted(run, &res, kind)
	}

	if in.Review != nil {
		if err := run.SetPR(in.Review.Branch, in.Review.HeadSHA, in.Review.PRID); err != nil {
			return r.controlFailure(run, &res, fmt.Errorf("bind pull request: %w", err))
		}
		return r.stopWith(run, &res, harness.StateAwaitingReview, OutcomeCompleted, CodeReviewRequested,
			ExitOK, fmt.Sprintf("task completed; pull request %s is bound and awaiting review", in.Review.PRID))
	}
	return r.stopWith(run, &res, harness.StateStopped, OutcomeCompleted, StopCodeLocalReviewRequired,
		ExitOK, "task completed locally; no pull request is bound, human disposition required")
}

// stopWith transitions run to state with code, then reports outcome. Any
// transition failure is an audit control failure and fails closed. A run that
// is already in the target state (the harness recorded the stop itself, as on
// a denial with a stop condition) keeps its existing evidence.
func (r *Runner) stopWith(run *harness.Run, res *Result, state harness.State, outcome Outcome, code string, exit int, reason string) (Result, error) {
	if run.State != state {
		if err := run.Transition(state, code); err != nil {
			return r.controlFailure(run, res, err)
		}
	}
	return r.report(run, res, outcome, code, reason, exit), nil
}

func (r *Runner) report(run *harness.Run, res *Result, outcome Outcome, code, reason string, exit int) Result {
	res.State = run.State
	res.Outcome = outcome
	res.Code = code
	res.Reason = reason
	res.ExitCode = exit
	return *res
}

// finishInterrupted records cancellation or timeout against the state the run
// is actually in, following the ADR transition table.
func (r *Runner) finishInterrupted(run *harness.Run, res *Result, kind interrupt) (Result, error) {
	switch run.State {
	case harness.StateRequested:
		if kind == interruptCancel {
			return r.stopWith(run, res, harness.StateCancelled, OutcomeCancelled, CodeTaskCancelled,
				ExitCancelled, "task cancelled before completion")
		}
		// The ADR table has no timed_out edge from requested, so a
		// planning-phase timeout ends cancelled with an explicit timeout
		// reason.
		return r.stopWith(run, res, harness.StateCancelled, OutcomeTimedOut, CodeTaskTimedOut,
			ExitTimedOut, "task timeout reached before completion")
	case harness.StateRunning:
		if kind == interruptCancel {
			return r.stopWith(run, res, harness.StateCancelled, OutcomeCancelled, CodeTaskCancelled,
				ExitCancelled, "task cancelled before completion")
		}
		return r.stopWith(run, res, harness.StateTimedOut, OutcomeTimedOut, CodeTaskTimedOut,
			ExitTimedOut, "task timeout reached before completion")
	case harness.StateApproved:
		if kind == interruptCancel {
			return r.stopWith(run, res, harness.StateCancelled, OutcomeCancelled, CodeTaskCancelled,
				ExitCancelled, "task cancelled before dispatch")
		}
		return r.stopWith(run, res, harness.StateExpired, OutcomeTimedOut, CodeTaskTimedOut,
			ExitTimedOut, "task timeout reached before dispatch")
	default:
		return r.controlFailure(run, res, fmt.Errorf("loop: interruption observed in state %q", run.State))
	}
}

func (r *Runner) controlFailure(run *harness.Run, res *Result, err error) (Result, error) {
	res.State = run.State
	res.Outcome = OutcomeControlFailure
	res.Code = CodeControlFailure
	res.Reason = err.Error()
	res.ExitCode = ExitControlFailure
	return *res, err
}

func (r *Runner) grantParams(in TaskInput, issuedAt time.Time) harness.GrantParams {
	wall := in.Grant.MaxWallClockSeconds
	if in.Timeout > 0 {
		// The capability grant must never outlive the task: cap the
		// wall-clock bound to the task timeout, rounded up to a whole second.
		if capped := int((in.Timeout + time.Second - 1) / time.Second); capped < wall {
			wall = capped
		}
	}
	return harness.GrantParams{
		TaskID:                 in.TaskID,
		RunID:                  in.RunID,
		IssuedAt:               issuedAt,
		ExpiresAt:              issuedAt.Add(time.Duration(wall) * time.Second),
		CapabilityGrantVersion: in.Grant.CapabilityGrantVersion,
		RepositoryURL:          in.RepositoryURL,
		BaseSHA:                in.BaseSHA,
		PermittedPaths:         append([]string{}, in.Grant.PermittedPaths...),
		PermittedTools:         append([]harness.PermittedTool{}, in.Grant.PermittedTools...),
		NetworkDestinations:    append([]string{}, in.Grant.NetworkDestinations...),
		MaxWallClockSeconds:    wall,
		ResourceLimits:         in.Grant.ResourceLimits,
		MayCreatePatch:         in.Grant.MayCreatePatch,
		MayCreateOrUpdatePR:    in.Grant.MayCreateOrUpdatePR,
	}
}

func interruptOf(ctx context.Context, now, startedAt time.Time, timeout time.Duration) interrupt {
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return interruptTimeout
		}
		return interruptCancel
	}
	if timeout > 0 && !now.Before(startedAt.Add(timeout)) {
		return interruptTimeout
	}
	return interruptNone
}

func validateInput(in TaskInput) error {
	switch {
	case in.TaskID == "":
		return errors.New("task_id is required")
	case in.IssueID == "":
		return errors.New("issue_id is required")
	case in.RepositoryURL == "":
		return errors.New("repository.url is required")
	case in.BaseSHA == "":
		return errors.New("repository.base_sha is required")
	case in.ActorIdentity == "":
		return errors.New("actor_identity is required")
	case in.ExecutionIdentity == "":
		return errors.New("execution_identity is required")
	case in.Grant.CapabilityGrantVersion == "":
		return errors.New("grant.capability_grant_version is required")
	case in.Grant.MaxWallClockSeconds <= 0:
		return errors.New("grant.max_wall_clock_seconds must be positive")
	case in.Timeout < 0:
		return errors.New("timeout must not be negative")
	}
	if in.Review != nil {
		switch {
		case !strings.HasPrefix(in.Review.Branch, harness.BranchPrefix):
			return fmt.Errorf("review.branch %q must start with %q", in.Review.Branch, harness.BranchPrefix)
		case in.Review.HeadSHA == "":
			return errors.New("review.head_sha is required when review is set")
		case in.Review.PRID == "":
			return errors.New("review.pr_id is required when review is set")
		}
	}
	return nil
}

func validateApproval(in TaskInput, class harness.RiskClass, startedAt time.Time) error {
	switch class {
	case harness.RiskElevated:
		if in.ElevatedApproval == nil {
			return errors.New("elevated work requires a named pre-grant approval reference")
		}
	case harness.RiskLow, harness.RiskProhibited:
		if in.ElevatedApproval != nil {
			return fmt.Errorf("%s work must not carry an elevated approval reference", class)
		}
	}
	if in.ElevatedApproval != nil {
		switch {
		case in.ElevatedApproval.Reference == "":
			return errors.New("elevated_approval.reference is required")
		case in.ElevatedApproval.ApproverIdentity == "":
			return errors.New("elevated_approval.approver_identity is required")
		case in.ElevatedApproval.ApprovedAt.IsZero():
			return errors.New("elevated_approval.approved_at is required")
		case !in.ElevatedApproval.ApprovedAt.Before(startedAt):
			return errors.New("elevated_approval.approved_at must precede the run")
		}
	}
	return nil
}

func elevatedApproval(in TaskInput, class harness.RiskClass) *harness.ApprovalReference {
	if class == harness.RiskElevated {
		return in.ElevatedApproval
	}
	return nil
}

func newRunID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("run-%d", time.Now().UnixNano())
	}
	return "run-" + hex.EncodeToString(buf[:])
}
