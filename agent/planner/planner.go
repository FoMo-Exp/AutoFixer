// Package planner defines the replaceable planning boundary of the agent
// prototype: a Planner turns controlled task input into a structured,
// versioned Plan of tool calls, and Validate gives the task loop a
// deterministic check before any step is considered for dispatch.
//
// The prototype ships only the deterministic FakePlanner: no production
// model, network call, or credential is wired in this package. A plan is
// data, not permission — it names tools and declares their scopes; execution
// authorization lives in agent/tools and the existing harness/sandbox
// policy.
package planner

import (
	"context"
	"errors"
	"fmt"

	"github.com/Luthiel/AutoFixer/agent/tools"
)

// PlanVersion is the only plan format version this prototype produces and
// validates; a plan carrying anything else is refused before its steps are
// considered.
const PlanVersion = "1"

// Disposition is a plan's explicit result kind: a plan either carries
// declarative action steps or an explicit no-action decision with its
// reason, never both.
type Disposition string

const (
	// DispositionActions marks a plan that carries at least one action step.
	DispositionActions Disposition = "actions"
	// DispositionNoAction marks an explicit planner decision to do nothing;
	// the run must treat it as terminal, not as an empty success.
	DispositionNoAction Disposition = "no_action"
)

// Task is the controlled input a planner plans for: the task identity the
// plan is validated against and the repository state the work is scoped to.
type Task struct {
	TaskID        string `json:"task_id"`
	RepositoryURL string `json:"repository_url"`
	BaseSHA       string `json:"base_sha"`
	Goal          string `json:"goal"`
}

// Plan is a planner's structured output bound to one task. A plan is data,
// not permission: Validate must pass before a step is handed to the tool
// registry, and each step is still authorized against the allow-list and the
// harness grant.
type Plan struct {
	Version string `json:"version"`
	TaskID  string `json:"task_id"`
	// Disposition marks whether the plan carries action steps or an
	// explicit no-action decision.
	Disposition Disposition `json:"disposition"`
	// NoActionReason states why a no-action plan does nothing; it must be
	// empty on an actions plan.
	NoActionReason string       `json:"no_action_reason,omitempty"`
	Steps          []tools.Call `json:"steps"`
}

// Planner is the replaceable planning boundary: implementations are injected
// by the composition root, and the prototype ships only the deterministic
// FakePlanner.
type Planner interface {
	Plan(ctx context.Context, task Task) (Plan, error)
}

// Validate checks a plan's structure and its binding to the task that asked
// for it: supported version, task identity present and matching, an explicit
// disposition, and consistent steps. Checks run in order and the first
// failure is returned, so malformed plans are rejected deterministically.
// Scope and permission checks are not this function's job — they belong to
// agent/tools at dispatch time.
func Validate(task Task, plan Plan) error {
	if plan.Version != PlanVersion {
		return fmt.Errorf("planner: unsupported plan version %q, want %q", plan.Version, PlanVersion)
	}
	if task.TaskID == "" {
		return errors.New("planner: task identity is empty; a plan cannot be validated against it")
	}
	if plan.TaskID != task.TaskID {
		return fmt.Errorf("planner: plan is bound to task %q, want %q", plan.TaskID, task.TaskID)
	}
	switch plan.Disposition {
	case DispositionActions:
		if plan.NoActionReason != "" {
			return errors.New("planner: an actions plan must not carry a no-action reason")
		}
		if len(plan.Steps) == 0 {
			return errors.New("planner: an actions plan has no steps")
		}
		for i, step := range plan.Steps {
			if step.Tool == "" {
				return fmt.Errorf("planner: step %d names an empty tool", i)
			}
		}
		return nil
	case DispositionNoAction:
		if len(plan.Steps) != 0 {
			return errors.New("planner: a no-action plan must not carry steps")
		}
		if plan.NoActionReason == "" {
			return errors.New("planner: a no-action plan requires an explicit reason")
		}
		return nil
	default:
		return fmt.Errorf("planner: unknown plan disposition %q", plan.Disposition)
	}
}
