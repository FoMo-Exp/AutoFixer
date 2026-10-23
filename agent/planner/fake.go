package planner

import (
	"context"
	"errors"
	"fmt"

	"github.com/Luthiel/AutoFixer/agent/tools"
)

// ErrUnknownTask is returned when the script holds no plan for a task.
var ErrUnknownTask = errors.New("planner: no scripted plan for task")

// FakePlanner is the deterministic planner the prototype and tests use. It
// replays plans from a fixed script keyed by task ID: same task, same plan,
// no model, clock, or I/O. Plans are returned exactly as scripted — a
// malformed one included — so callers can exercise Validate themselves.
type FakePlanner struct {
	script map[string]Plan
}

var _ Planner = (*FakePlanner)(nil)

// NewFakePlanner builds a fake planner over a copy of the given script; the
// caller's map is not retained.
func NewFakePlanner(script map[string]Plan) *FakePlanner {
	copyScript := make(map[string]Plan, len(script))
	for taskID, plan := range script {
		copyScript[taskID] = copyPlan(plan)
	}
	return &FakePlanner{script: copyScript}
}

// Plan returns the scripted plan for the task, honoring cancellation first.
// Unknown tasks fail with ErrUnknownTask. Returned plans are deep copies, so
// a caller cannot rewrite the script through them.
func (p *FakePlanner) Plan(ctx context.Context, task Task) (Plan, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Plan{}, err
	}
	plan, ok := p.script[task.TaskID]
	if !ok {
		return Plan{}, fmt.Errorf("%w: %q", ErrUnknownTask, task.TaskID)
	}
	return copyPlan(plan), nil
}

// copyPlan returns a deep copy: steps and their argument, path, and
// destination slices are recreated so no shared backing array leaks between
// the script and its consumers.
func copyPlan(plan Plan) Plan {
	out := Plan{
		Version:        plan.Version,
		TaskID:         plan.TaskID,
		Disposition:    plan.Disposition,
		NoActionReason: plan.NoActionReason,
	}
	if plan.Steps != nil {
		out.Steps = make([]tools.Call, len(plan.Steps))
		for i, step := range plan.Steps {
			out.Steps[i] = tools.Call{
				Tool:                step.Tool,
				Arguments:           copySlice(step.Arguments),
				Paths:               copySlice(step.Paths),
				NetworkDestinations: copySlice(step.NetworkDestinations),
			}
		}
	}
	return out
}

// copySlice copies a string slice, preserving the nil/empty distinction.
func copySlice(in []string) []string {
	if in == nil {
		return nil
	}
	return append([]string{}, in...)
}
