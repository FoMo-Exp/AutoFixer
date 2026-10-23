package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	"github.com/Luthiel/AutoFixer/agent/loop"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

const (
	formatText = "text"
	formatJSON = "json"
)

// declaredPlanner turns the actions declared by the controlled task input
// into the plan for this attempt. It is the composition placeholder until
// agent/planner lands (AFP-03/AFP-05); it plans nothing on its own.
type declaredPlanner struct{}

func (declaredPlanner) Plan(_ context.Context, in loop.TaskInput) (loop.Plan, error) {
	return loop.Plan{Actions: append([]loop.Action{}, in.Actions...)}, nil
}

// newSandboxExecutor is the production executor factory: the existing
// sandbox runner, bound to the run it dispatches for.
func newSandboxExecutor(run *harness.Run) (loop.Executor, error) {
	return sandbox.New(run, sandbox.Options{})
}

// workFlags mirrors harness.ProposedWork with the controlled input's JSON
// key names.
type workFlags struct {
	RequestsSecretAccess      bool `json:"requests_secret_access"`
	WritesToMain              bool `json:"writes_to_main"`
	EditsCIWorkflows          bool `json:"edits_ci_workflows"`
	EditsGovernance           bool `json:"edits_governance"`
	PublishesPackage          bool `json:"publishes_package"`
	Deploys                   bool `json:"deploys"`
	AltersInfrastructure      bool `json:"alters_infrastructure"`
	UnapprovedNetwork         bool `json:"unapproved_network"`
	BroadRefactor             bool `json:"broad_refactor"`
	DependencyChange          bool `json:"dependency_change"`
	DataShapeChange           bool `json:"data_shape_change"`
	Migration                 bool `json:"migration"`
	PermissionSensitive       bool `json:"permission_sensitive"`
	MaterialUncertainty       bool `json:"material_uncertainty"`
	LocalizedReversibleChange bool `json:"localized_reversible_change"`
}

func (f workFlags) proposed() harness.ProposedWork {
	return harness.ProposedWork{
		RequestsSecretAccess:      f.RequestsSecretAccess,
		WritesToMain:              f.WritesToMain,
		EditsCIWorkflows:          f.EditsCIWorkflows,
		EditsGovernance:           f.EditsGovernance,
		PublishesPackage:          f.PublishesPackage,
		Deploys:                   f.Deploys,
		AltersInfrastructure:      f.AltersInfrastructure,
		UnapprovedNetwork:         f.UnapprovedNetwork,
		BroadRefactor:             f.BroadRefactor,
		DependencyChange:          f.DependencyChange,
		DataShapeChange:           f.DataShapeChange,
		Migration:                 f.Migration,
		PermissionSensitive:       f.PermissionSensitive,
		MaterialUncertainty:       f.MaterialUncertainty,
		LocalizedReversibleChange: f.LocalizedReversibleChange,
	}
}

// fileInput is the on-disk controlled task input.
type fileInput struct {
	TaskID            string                     `json:"task_id"`
	RunID             string                     `json:"run_id,omitempty"`
	IssueID           string                     `json:"issue_id"`
	Repository        fileRepository             `json:"repository"`
	ActorIdentity     string                     `json:"actor_identity"`
	ExecutionIdentity string                     `json:"execution_identity"`
	RequestedWork     workFlags                  `json:"requested_work"`
	ElevatedApproval  *harness.ApprovalReference `json:"elevated_approval,omitempty"`
	Grant             loop.GrantInput            `json:"grant"`
	Actions           []loop.Action              `json:"actions"`
	Review            *loop.Review               `json:"review,omitempty"`
	Timeout           string                     `json:"timeout,omitempty"`
}

type fileRepository struct {
	URL     string `json:"url"`
	BaseSHA string `json:"base_sha"`
}

func (f fileInput) taskInput() (loop.TaskInput, error) {
	in := loop.TaskInput{
		TaskID:            f.TaskID,
		RunID:             f.RunID,
		IssueID:           f.IssueID,
		RepositoryURL:     f.Repository.URL,
		BaseSHA:           f.Repository.BaseSHA,
		ActorIdentity:     f.ActorIdentity,
		ExecutionIdentity: f.ExecutionIdentity,
		RequestedWork:     f.RequestedWork.proposed(),
		ElevatedApproval:  f.ElevatedApproval,
		Grant:             f.Grant,
		Actions:           f.Actions,
		Review:            f.Review,
	}
	if f.Timeout != "" {
		timeout, err := time.ParseDuration(f.Timeout)
		if err != nil {
			return loop.TaskInput{}, fmt.Errorf("timeout: %w", err)
		}
		in.Timeout = timeout
	}
	return in, nil
}

// eventSummary is one audit record in the CLI output.
type eventSummary struct {
	Sequence       int           `json:"sequence"`
	EventID        string        `json:"event_id"`
	EventType      string        `json:"event_type"`
	PriorState     harness.State `json:"prior_state"`
	ResultingState harness.State `json:"resulting_state"`
	Code           string        `json:"code,omitempty"`
}

type resultOutput struct {
	loop.Result
	Events []eventSummary `json:"events"`
}

type errorOutput struct {
	Error    string        `json:"error"`
	ExitCode int           `json:"exit_code"`
	Result   *resultOutput `json:"result,omitempty"`
}

func runCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	inputPath := fs.String("input", "", "controlled task input JSON file, or - for stdin")
	format := fs.String("format", formatText, "output format: text or json")
	timeout := fs.String("timeout", "", "task timeout as a Go duration, overrides the input file")
	if err := fs.Parse(args); err != nil {
		return loop.ExitInvalidInput
	}
	if *inputPath == "" {
		fmt.Fprintln(stderr, "run: --input is required")
		printUsage(stderr)
		return loop.ExitInvalidInput
	}
	if *format != formatText && *format != formatJSON {
		fmt.Fprintf(stderr, "run: unknown --format %q (want text or json)\n", *format)
		return loop.ExitInvalidInput
	}

	raw, err := readInput(*inputPath)
	if err != nil {
		return writeError(stdout, *format, err, loop.ExitInvalidInput, nil)
	}
	var file fileInput
	if err := json.Unmarshal(raw, &file); err != nil {
		return writeError(stdout, *format, fmt.Errorf("parse task input: %w", err), loop.ExitInvalidInput, nil)
	}
	in, err := file.taskInput()
	if err != nil {
		return writeError(stdout, *format, err, loop.ExitInvalidInput, nil)
	}
	if *timeout != "" {
		parsed, err := time.ParseDuration(*timeout)
		if err != nil {
			return writeError(stdout, *format, fmt.Errorf("--timeout: %w", err), loop.ExitInvalidInput, nil)
		}
		in.Timeout = parsed
	}

	store := harness.NewEventStore()
	runner := loop.New(store, declaredPlanner{}, newSandboxExecutor)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	res, runErr := runner.Run(ctx, in)
	if runErr != nil {
		if errors.Is(runErr, loop.ErrInvalidInput) {
			return writeError(stdout, *format, runErr, loop.ExitInvalidInput, nil)
		}
		return writeError(stdout, *format, runErr, res.ExitCode, &res)
	}

	out := resultOutput{Result: res, Events: summarizeEvents(store, res.RunID)}
	if err := writeResult(stdout, *format, out); err != nil {
		fmt.Fprintf(stderr, "write result: %v\n", err)
		return loop.ExitControlFailure
	}
	return res.ExitCode
}

func readInput(path string) ([]byte, error) {
	if path == "-" {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil, fmt.Errorf("read task input from stdin: %w", err)
		}
		return raw, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read task input: %w", err)
	}
	return raw, nil
}

func summarizeEvents(store *harness.EventStore, runID string) []eventSummary {
	events := store.Events(runID)
	out := make([]eventSummary, 0, len(events))
	for _, ev := range events {
		summary := eventSummary{
			Sequence:       ev.Sequence,
			EventID:        ev.EventID,
			EventType:      ev.EventType,
			PriorState:     ev.PriorState,
			ResultingState: ev.ResultingState,
		}
		if ev.DecisionOrStopCode != nil {
			summary.Code = *ev.DecisionOrStopCode
		}
		out = append(out, summary)
	}
	return out
}

func writeResult(w io.Writer, format string, out resultOutput) error {
	if format == formatJSON {
		encoder := json.NewEncoder(w)
		encoder.SetIndent("", "  ")
		return encoder.Encode(out)
	}
	fmt.Fprintf(w, "task_id: %s\n", out.TaskID)
	fmt.Fprintf(w, "run_id: %s\n", out.RunID)
	fmt.Fprintf(w, "outcome: %s\n", out.Outcome)
	fmt.Fprintf(w, "terminal_state: %s\n", out.State)
	fmt.Fprintf(w, "code: %s\n", out.Code)
	fmt.Fprintf(w, "reason: %s\n", out.Reason)
	fmt.Fprintf(w, "risk_class: %s\n", out.RiskClass)
	fmt.Fprintf(w, "risk_decision_code: %s\n", out.RiskDecisionCode)
	fmt.Fprintf(w, "actions_dispatched: %d\n", out.ActionsDispatched)
	fmt.Fprintf(w, "events: %d\n", len(out.Events))
	fmt.Fprintf(w, "exit_code: %d\n", out.ExitCode)
	return nil
}

func writeError(w io.Writer, format string, err error, exitCode int, res *loop.Result) int {
	if format == formatJSON {
		out := errorOutput{Error: err.Error(), ExitCode: exitCode}
		if res != nil {
			result := resultOutput{Result: *res}
			out.Result = &result
		}
		encoder := json.NewEncoder(w)
		encoder.SetIndent("", "  ")
		if encodeErr := encoder.Encode(out); encodeErr != nil {
			fmt.Fprintf(os.Stderr, "write error: %v\n", encodeErr)
		}
		return exitCode
	}
	fmt.Fprintf(w, "error: %s\n", err.Error())
	if res != nil {
		fmt.Fprintf(w, "outcome: %s\nexit_code: %d\n", res.Outcome, res.ExitCode)
	}
	return exitCode
}
