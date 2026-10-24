package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/Luthiel/AutoFixer/agent/events"
	"github.com/Luthiel/AutoFixer/agent/loop"
	"github.com/Luthiel/AutoFixer/agent/planner"
	"github.com/Luthiel/AutoFixer/agent/session"
	"github.com/Luthiel/AutoFixer/agent/tools"
	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// goldenToolPermissions is the composition-owned allow-list the registry
// enforces as a second, independent gate in front of the harness grant. The
// controlled task input cannot widen it: a tool, argument, or path absent
// here is denied before any dispatch, regardless of what the grant permits.
var goldenToolPermissions = []tools.Permission{
	{
		Identity:         "echo",
		AllowedArguments: []string{"hello"},
		AllowedPaths:     []string{"."},
		MinimumRisk:      harness.RiskLow,
	},
	{
		Identity:         "sleep",
		AllowedArguments: []string{"5"},
		AllowedPaths:     []string{"."},
		MinimumRisk:      harness.RiskLow,
	},
}

// composition wires one task attempt's dependencies: the scripted planner,
// the registry-backed executor factory, the session timeline, and the
// delivery bundle assembly. It captures the harness run the loop creates so
// the terminal bundle can reference the authoritative risk assessment and
// capability grant.
type composition struct {
	capturedRun *harness.Run
}

// executorFactory builds the registry-backed executor once the harness run
// exists. It captures the run for later bundle assembly, then composes
// sandbox runner -> sandbox dispatcher -> tool registry so every dispatch
// passes the registry allow-list before the harness grant check inside the
// sandbox.
func (c *composition) executorFactory(run *harness.Run) (loop.Executor, error) {
	c.capturedRun = run
	runner, err := sandbox.New(run, sandbox.Options{})
	if err != nil {
		return nil, err
	}
	dispatcher := tools.NewSandboxDispatcher(runner)
	registry := tools.NewRegistry(tools.WithDispatcher(dispatcher))
	for _, perm := range goldenToolPermissions {
		if err := registry.Register(perm); err != nil {
			_ = runner.Close()
			return nil, fmt.Errorf("register tool %q: %w", perm.Identity, err)
		}
	}
	return &registryExecutor{run: run, registry: registry, runner: runner}, nil
}

// registryExecutor bridges tools.Registry to the loop's Executor interface.
// A registry denial becomes a non-allowed sandbox.Result so the loop stops
// the run with the registry's recorded decision code; an allowed request
// returns the sandbox result carrying the harness grant decision.
type registryExecutor struct {
	run      *harness.Run
	registry *tools.Registry
	runner   *sandbox.Runner
}

func (e *registryExecutor) Execute(ctx context.Context, spec sandbox.Spec) (sandbox.Result, error) {
	req := tools.Request{
		TaskID:    e.run.TaskID,
		RunID:     e.run.RunID,
		RiskClass: e.run.Assessment.RiskClass,
		Call: tools.Call{
			Tool:                spec.Tool,
			Arguments:           append([]string{}, spec.Arguments...),
			Paths:               append([]string{}, spec.Paths...),
			NetworkDestinations: append([]string{}, spec.NetworkDestinations...),
		},
	}
	outcome, err := e.registry.Execute(ctx, req)
	if err != nil {
		return sandbox.Result{}, err
	}
	if !outcome.Decision.Allowed {
		return sandbox.Result{Decision: harness.Decision{
			Allowed: false,
			Code:    outcome.Decision.Code,
		}}, nil
	}
	if outcome.Result == nil {
		return sandbox.Result{}, errors.New("registry allowed request but produced no dispatch result")
	}
	return *outcome.Result, nil
}

func (e *registryExecutor) Close() error {
	if e.runner == nil {
		return nil
	}
	return e.runner.Close()
}

// plannerAdapter bridges agent/planner to the loop's Planner interface: it
// maps the loop's task input to a planner task, runs the deterministic
// FakePlanner, validates the structured plan, and converts it to the loop's
// action list. An invalid plan becomes an invalid-plan rejection; an explicit
// no-action plan becomes a terminal no-action rejection. A valid plan is
// recorded on the session timeline before dispatch.
type plannerAdapter struct {
	inner   planner.Planner
	session *session.Session
	goal    string
}

func (a *plannerAdapter) Plan(ctx context.Context, in loop.TaskInput) (loop.Plan, error) {
	task := planner.Task{
		TaskID:        in.TaskID,
		RepositoryURL: in.RepositoryURL,
		BaseSHA:       in.BaseSHA,
		Goal:          a.goal,
	}
	plan, err := a.inner.Plan(ctx, task)
	if err != nil {
		return loop.Plan{}, err
	}
	if err := planner.Validate(task, plan); err != nil {
		return loop.Plan{Rejection: &loop.Rejection{
			Code:   loop.CodeInvalidPlan,
			Reason: err.Error(),
		}}, nil
	}
	if err := a.recordPlan(in.TaskID, plan); err != nil {
		return loop.Plan{}, err
	}
	switch plan.Disposition {
	case planner.DispositionNoAction:
		return loop.Plan{Rejection: &loop.Rejection{
			Code:   "planner_no_action",
			Reason: plan.NoActionReason,
		}}, nil
	case planner.DispositionActions:
		actions := make([]loop.Action, len(plan.Steps))
		for i, step := range plan.Steps {
			actions[i] = loop.Action{
				Tool:                step.Tool,
				Arguments:           append([]string{}, step.Arguments...),
				Paths:               append([]string{}, step.Paths...),
				NetworkDestinations: append([]string{}, step.NetworkDestinations...),
			}
		}
		return loop.Plan{Actions: actions}, nil
	default:
		return loop.Plan{}, fmt.Errorf("planner: unknown plan disposition %q", plan.Disposition)
	}
}

func (a *plannerAdapter) recordPlan(taskID string, plan planner.Plan) error {
	if a.session == nil {
		return nil
	}
	steps := make([]events.PlanStep, len(plan.Steps))
	for i, step := range plan.Steps {
		steps[i] = events.PlanStep{
			ID:        fmt.Sprintf("step-%d", i+1),
			Tool:      step.Tool,
			Arguments: append([]string{}, step.Arguments...),
		}
	}
	_, err := a.session.Append(events.NewPlanEvent(taskID, events.Plan{
		Summary: fmt.Sprintf("planner produced a %s plan", plan.Disposition),
		Steps:   steps,
	}, time.Now()))
	return err
}

// taskRun is one composed task attempt's complete observable result: the
// loop's terminal result, the harness audit summaries, the application
// timeline, and the delivery evidence bundle.
type taskRun struct {
	Result    loop.Result
	Events    []eventSummary
	Timeline  *events.Timeline
	Bundle    *delivery.EvidenceBundle
	BundleErr error
	RunErr    error
}

// runTask composes and drives one task attempt: it creates the session,
// scripts the deterministic planner from the input's plan, runs the loop
// through the registry-backed executor, replays the harness evidence into the
// session timeline, and assembles the delivery evidence bundle.
func runTask(ctx context.Context, file fileInput, timeoutOverride time.Duration) taskRun {
	in, err := file.taskInput()
	if err != nil {
		return taskRun{RunErr: err}
	}
	// The session keys every timeline event by task ID, so check it before
	// creating the session; the loop validates the remaining identity itself.
	if in.TaskID == "" {
		return taskRun{RunErr: fmt.Errorf("%w: task_id is required", loop.ErrInvalidInput)}
	}
	if timeoutOverride > 0 {
		in.Timeout = timeoutOverride
	}
	if in.RunID == "" {
		in.RunID = newRunID()
	}
	summary := file.summary(in.TaskID)
	sourceRef := file.sourceReference(in.IssueID)
	requestedAt := time.Now().UTC()

	harnessStore := harness.NewEventStore()
	eventStore := events.NewStore()
	sessionStore, err := session.NewStoreWithEvents(eventStore)
	if err != nil {
		return taskRun{RunErr: err}
	}
	sess, err := sessionStore.Create(session.TaskInput{
		TaskID:          in.TaskID,
		IssueID:         in.IssueID,
		RunID:           in.RunID,
		RequestedAt:     requestedAt,
		RepositoryURL:   in.RepositoryURL,
		BaseSHA:         in.BaseSHA,
		Summary:         summary,
		SourceReference: sourceRef,
	})
	if err != nil {
		return taskRun{RunErr: err}
	}

	script := map[string]planner.Plan{}
	if file.Plan != nil {
		script[in.TaskID] = *file.Plan
	}
	pAdapter := &plannerAdapter{
		inner:   planner.NewFakePlanner(script),
		session: sess,
		goal:    summary,
	}
	comp := &composition{}
	runner := loop.New(harnessStore, pAdapter, comp.executorFactory)

	res, runErr := runner.Run(ctx, in)

	out := taskRun{Result: res, RunErr: runErr}
	out.Events = summarizeEvents(harnessStore, res.RunID)

	if res.RunID != "" {
		if tlErr := replayTimeline(sess, harnessStore, res.RunID); tlErr != nil {
			out.RunErr = errors.Join(out.RunErr, tlErr)
		}
		bundle, bundleErr := buildBundle(in, res, harnessStore, comp.capturedRun, summary, sourceRef, requestedAt)
		out.BundleErr = bundleErr
		if bundleErr == nil {
			out.Bundle = &bundle
			if _, err := sess.Append(events.NewArtifactEvent(in.TaskID, []events.ArtifactReference{{
				Name:      "evidence_bundle",
				Reference: "delivery://bundles/" + res.RunID,
			}}, time.Now())); err != nil {
				out.RunErr = errors.Join(out.RunErr, err)
			}
		}
		// Export the timeline after the artifact event so it indexes the
		// produced evidence bundle too.
		timeline, tlErr := sess.Timeline()
		if tlErr != nil {
			out.RunErr = errors.Join(out.RunErr, tlErr)
		} else {
			out.Timeline = &timeline
		}
	}
	return out
}

// replayTimeline mirrors the authoritative harness evidence into the
// application session timeline. Each harness state change becomes a session
// state transition, each harness tool event becomes a session tool
// invocation, and every mirrored event carries a typed reference to the
// harness record it reflects. Refusal events (prior state equal to resulting
// state) are indexed as evidence rather than transitions, because the session
// state machine only accepts real changes.
func replayTimeline(sess *session.Session, store *harness.EventStore, runID string) error {
	harnessEvents := store.Events(runID)
	refs := make([]events.EvidenceReference, 0, len(harnessEvents))
	for _, ev := range harnessEvents {
		ref, err := events.NewHarnessEvidenceReference(ev)
		if err != nil {
			return fmt.Errorf("reference harness event %d: %w", ev.Sequence, err)
		}
		refs = append(refs, ref)

		switch {
		case ev.EventType == harness.EventTypeStateTransition && ev.PriorState != ev.ResultingState:
			if _, err := sess.Transition(ev.ResultingState, ev.OccurredAt, ref); err != nil {
				return fmt.Errorf("replay state transition %d: %w", ev.Sequence, err)
			}
		case ev.EventType == harness.EventTypeToolInvocation:
			invocation := events.ToolInvocation{
				RequestedTool: toolIdentity(ev.RequestedTool),
				ActualTool:    toolIdentity(ev.ActualTool),
				Arguments:     toolArguments(ev.RequestedTool),
				ExitStatus:    copyExitStatus(ev.ExitStatus),
				OutputDigest:  copyDigest(ev.OutputDigest),
			}
			if _, err := sess.Append(events.NewToolInvocationEvent(sess.TaskID(), invocation, ev.OccurredAt, ref)); err != nil {
				return fmt.Errorf("replay tool invocation %d: %w", ev.Sequence, err)
			}
		default:
			// Refusal events and any other record keep their evidence
			// reference without forcing a session state change.
		}
	}
	if len(refs) > 0 {
		if _, err := sess.Append(events.NewEvidenceEvent(sess.TaskID(), refs, time.Now())); err != nil {
			return fmt.Errorf("record evidence index: %w", err)
		}
	}
	return nil
}

// buildBundle assembles the delivery evidence bundle for a terminal run. The
// risk assessment and capability grant come from the captured harness run
// when one was created; a run rejected before the executor factory ran has no
// captured run, so the deterministic risk assessment is reconstructed from
// the same input the loop classified. The patch report is not_created for the
// local demo and is bound to the terminal harness event.
func buildBundle(in loop.TaskInput, res loop.Result, store *harness.EventStore, captured *harness.Run, summary, sourceRef string, now time.Time) (delivery.EvidenceBundle, error) {
	executionEvents := store.Events(res.RunID)
	if len(executionEvents) == 0 {
		return delivery.EvidenceBundle{}, errors.New("delivery: no harness events recorded for the run")
	}

	assessment, err := bundleRiskAssessment(in, res, captured, now)
	if err != nil {
		return delivery.EvidenceBundle{}, err
	}

	terminal := executionEvents[len(executionEvents)-1]
	terminalRef := fmt.Sprintf("evidence://events/%s/%d", res.RunID, terminal.Sequence)
	patchReport, err := delivery.NewPatchReport(delivery.PatchReport{
		TaskID:        res.TaskID,
		RunID:         res.RunID,
		IssuedAt:      now,
		RepositoryURL: in.RepositoryURL,
		BaseSHA:       in.BaseSHA,
		PatchStatus:   delivery.PatchNotCreated,
		ChangeSummary: summary,
		EvidenceReferences: []string{
			terminalRef,
		},
	})
	if err != nil {
		return delivery.EvidenceBundle{}, fmt.Errorf("build patch report: %w", err)
	}

	snapshot := harness.ApprovalSnapshot{
		ContractVersion: harness.ContractVersion,
		TaskID:          res.TaskID,
		RunID:           res.RunID,
		ObservedAt:      now,
		QA:              harness.QAObservation{Status: "not_requested"},
		ReviewDiscussions: harness.DiscussionsObservation{
			Status:     "not_applicable",
			ObservedAt: now,
		},
		ApprovalQuorum:      harness.QuorumObservation{Status: "not_requested"},
		EvidenceReference:   fmt.Sprintf("evidence://approvals/%s/no-pr", res.RunID),
		MergeQueueAvailable: false,
	}
	snapshot.Evaluate()

	bundle := delivery.EvidenceBundle{
		ContractVersion: harness.ContractVersion,
		TaskInput: delivery.TaskInput{
			ContractVersion: harness.ContractVersion,
			TaskID:          res.TaskID,
			IssueID:         in.IssueID,
			RequestedAt:     now,
			Repository: delivery.TaskRepository{
				URL:     in.RepositoryURL,
				BaseSHA: in.BaseSHA,
			},
			RequestedWork: delivery.RequestedWork{
				Summary:         summary,
				SourceReference: sourceRef,
			},
		},
		RiskAssessment:   assessment,
		CapabilityGrant:  bundleGrant(captured),
		ExecutionEvents:  executionEvents,
		PatchReport:      patchReport,
		ApprovalSnapshot: snapshot,
		EvidenceReferences: []string{
			"evidence://events/" + res.RunID,
			assessment.RationaleReference,
			snapshot.EvidenceReference,
		},
	}
	if err := bundle.Validate(); err != nil {
		return delivery.EvidenceBundle{}, fmt.Errorf("validate evidence bundle: %w", err)
	}
	return bundle, nil
}

// bundleRiskAssessment returns the run's risk assessment: the captured
// harness run's authoritative record when dispatch was reached, or a
// deterministic reconstruction from the same controlled input the loop
// classified for a run rejected before the executor factory ran.
func bundleRiskAssessment(in loop.TaskInput, res loop.Result, captured *harness.Run, now time.Time) (harness.RiskAssessment, error) {
	if captured != nil {
		return captured.Assessment, nil
	}
	class, code := harness.AssessRisk(in.RequestedWork)
	var approval *harness.ApprovalReference
	if class == harness.RiskElevated {
		approval = in.ElevatedApproval
	}
	return harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID:             in.TaskID,
		RunID:              res.RunID,
		AssessedAt:         now,
		AssessorIdentity:   in.ActorIdentity,
		RationaleReference: "evidence://risk/" + in.TaskID,
	}, class, code, approval)
}

func bundleGrant(captured *harness.Run) *harness.CapabilityGrant {
	if captured == nil || captured.Grant == nil {
		return nil
	}
	return captured.Grant
}

func toolIdentity(record *harness.ToolRecord) string {
	if record == nil {
		return ""
	}
	return record.Identity
}

func toolArguments(record *harness.ToolRecord) []string {
	if record == nil {
		return nil
	}
	return append([]string{}, record.Arguments...)
}

func copyExitStatus(status *int) *int {
	if status == nil {
		return nil
	}
	value := *status
	return &value
}

func copyDigest(digest *harness.Digest) *events.Digest {
	if digest == nil {
		return nil
	}
	return &events.Digest{Algorithm: digest.Algorithm, Value: digest.Value}
}

func newRunID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("run-%d", time.Now().UnixNano())
	}
	return "run-" + hex.EncodeToString(buf[:])
}
