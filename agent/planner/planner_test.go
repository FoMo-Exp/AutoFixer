package planner_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/Luthiel/AutoFixer/agent/planner"
	"github.com/Luthiel/AutoFixer/agent/tools"
)

func testTask() planner.Task {
	return planner.Task{
		TaskID:        "task-afp03",
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
		Goal:          "run the golden task",
	}
}

func testPlan() planner.Plan {
	return planner.Plan{
		Version:     planner.PlanVersion,
		TaskID:      "task-afp03",
		Disposition: planner.DispositionActions,
		Steps: []tools.Call{{
			Tool:      tools.FakeToolIdentity,
			Arguments: []string{"--ok"},
			Paths:     []string{"src"},
		}},
	}
}

func TestValidateAcceptsActionAndNoActionPlans(t *testing.T) {
	task := testTask()
	if err := planner.Validate(task, testPlan()); err != nil {
		t.Fatalf("valid actions plan rejected: %v", err)
	}

	noAction := planner.Plan{
		Version:        planner.PlanVersion,
		TaskID:         task.TaskID,
		Disposition:    planner.DispositionNoAction,
		NoActionReason: "the task requires no repository change",
	}
	if err := planner.Validate(task, noAction); err != nil {
		t.Fatalf("valid no-action plan rejected: %v", err)
	}
}

func TestValidateRejectsMalformedPlans(t *testing.T) {
	tests := []struct {
		name   string
		task   planner.Task
		mutate func(*planner.Plan)
	}{
		{
			name:   "empty plan version",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.Version = "" },
		},
		{
			name:   "unsupported plan version",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.Version = "0" },
		},
		{
			name:   "empty task identity",
			task:   planner.Task{},
			mutate: func(p *planner.Plan) {},
		},
		{
			name:   "plan bound to another task",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.TaskID = "task-other" },
		},
		{
			name:   "unknown disposition",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.Disposition = "maybe" },
		},
		{
			name:   "missing disposition",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.Disposition = "" },
		},
		{
			name:   "actions plan without steps",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.Steps = nil },
		},
		{
			name:   "actions plan with empty tool",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.Steps[0].Tool = "" },
		},
		{
			name:   "actions plan carrying a no-action reason",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.NoActionReason = "nonsense" },
		},
		{
			name: "no-action plan with steps",
			task: testTask(),
			mutate: func(p *planner.Plan) {
				p.Disposition = planner.DispositionNoAction
				p.NoActionReason = "nothing to do"
			},
		},
		{
			name:   "no-action plan without a reason",
			task:   testTask(),
			mutate: func(p *planner.Plan) { p.Disposition = planner.DispositionNoAction },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plan := testPlan()
			tt.mutate(&plan)
			if err := planner.Validate(tt.task, plan); err == nil {
				t.Fatalf("Validate(task, %+v) = nil error, want rejection", plan)
			}
		})
	}
}

func TestFakePlannerReplaysDeterministicallyAndCopies(t *testing.T) {
	task := testTask()
	p := planner.NewFakePlanner(map[string]planner.Plan{task.TaskID: testPlan()})

	first, err := p.Plan(context.Background(), task)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	second, err := p.Plan(context.Background(), task)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("same task produced different plans:\n%+v\n%+v", first, second)
	}
	if !reflect.DeepEqual(first, testPlan()) {
		t.Fatalf("planner altered the scripted plan:\ngot  %+v\nwant %+v", first, testPlan())
	}
	if err := planner.Validate(task, first); err != nil {
		t.Fatalf("scripted plan does not validate: %v", err)
	}

	// A consumer cannot rewrite the script through a returned plan.
	first.Steps[0].Arguments[0] = "--rewritten"
	third, err := p.Plan(context.Background(), task)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if third.Steps[0].Arguments[0] != "--ok" {
		t.Fatalf("script rewritten through a returned plan: %+v", third.Steps[0])
	}
}

func TestFakePlannerUnknownTaskFails(t *testing.T) {
	p := planner.NewFakePlanner(map[string]planner.Plan{})
	if _, err := p.Plan(context.Background(), testTask()); !errors.Is(err, planner.ErrUnknownTask) {
		t.Fatalf("Plan = %v, want ErrUnknownTask", err)
	}
}

func TestFakePlannerHonorsCancellation(t *testing.T) {
	task := testTask()
	p := planner.NewFakePlanner(map[string]planner.Plan{task.TaskID: testPlan()})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.Plan(ctx, task); !errors.Is(err, context.Canceled) {
		t.Fatalf("Plan = %v, want context.Canceled", err)
	}
}

func TestFakePlannerReturnsScriptedMalformedPlanVerbatim(t *testing.T) {
	task := testTask()
	malformed := planner.Plan{
		Version:     "0",
		TaskID:      task.TaskID,
		Disposition: planner.DispositionActions,
		Steps:       []tools.Call{{Tool: tools.FakeToolIdentity}},
	}
	p := planner.NewFakePlanner(map[string]planner.Plan{task.TaskID: malformed})

	got, err := p.Plan(context.Background(), task)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if !reflect.DeepEqual(got, malformed) {
		t.Fatalf("malformed plan was not returned verbatim:\ngot  %+v\nwant %+v", got, malformed)
	}
	if err := planner.Validate(task, got); err == nil {
		t.Fatal("Validate accepted the malformed plan, want rejection")
	}
}
