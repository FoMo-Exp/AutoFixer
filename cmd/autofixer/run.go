package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	"github.com/Luthiel/AutoFixer/agent/events"
	"github.com/Luthiel/AutoFixer/agent/loop"
	"github.com/Luthiel/AutoFixer/agent/planner"
	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
)

const (
	formatText = "text"
	formatJSON = "json"
)

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
	Summary           string                     `json:"summary,omitempty"`
	SourceReference   string                     `json:"source_reference,omitempty"`
	ElevatedApproval  *harness.ApprovalReference `json:"elevated_approval,omitempty"`
	Grant             loop.GrantInput            `json:"grant"`
	// Plan scripts the deterministic planner for this task. It is data, not
	// permission: the registry allow-list and the harness grant still
	// authorize every step.
	Plan    *planner.Plan `json:"plan,omitempty"`
	Review  *loop.Review  `json:"review,omitempty"`
	Timeout string        `json:"timeout,omitempty"`
}

type fileRepository struct {
	URL     string `json:"url"`
	BaseSHA string `json:"base_sha"`
}

func (f fileInput) summary(taskID string) string {
	if f.Summary != "" {
		return f.Summary
	}
	return "task " + taskID
}

func (f fileInput) sourceReference(issueID string) string {
	if f.SourceReference != "" {
		return f.SourceReference
	}
	return "issue://" + issueID
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
	Events      []eventSummary           `json:"events"`
	Timeline    *events.Timeline         `json:"timeline,omitempty"`
	Bundle      *delivery.EvidenceBundle `json:"evidence_bundle,omitempty"`
	BundleError string                   `json:"bundle_error,omitempty"`
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
	var timeoutOverride time.Duration
	if *timeout != "" {
		timeoutOverride, err = time.ParseDuration(*timeout)
		if err != nil {
			return writeError(stdout, *format, fmt.Errorf("--timeout: %w", err), loop.ExitInvalidInput, nil)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	return finishTask(ctx, file, timeoutOverride, *format, stdout, stderr)
}

// finishTask drives one composed task attempt and maps its terminal result to
// output and an exit code. It is shared by the run and demo commands.
func finishTask(ctx context.Context, file fileInput, timeoutOverride time.Duration, format string, stdout, stderr io.Writer) int {
	out := runTask(ctx, file, timeoutOverride)
	// An error with no run identity is an input or setup failure: the loop
	// never created a run, so there is no terminal result to report.
	if out.RunErr != nil && out.Result.RunID == "" {
		return writeError(stdout, format, out.RunErr, loop.ExitInvalidInput, nil)
	}
	if err := writeResult(stdout, format, out); err != nil {
		fmt.Fprintf(stderr, "write result: %v\n", err)
		return loop.ExitControlFailure
	}
	if out.RunErr != nil {
		// A control failure still emitted its terminal result above; surface
		// the error text on stderr for text mode diagnostics.
		if format != formatJSON {
			fmt.Fprintf(stderr, "error: %s\n", out.RunErr.Error())
		}
	}
	return out.Result.ExitCode
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

func writeResult(w io.Writer, format string, out taskRun) error {
	payload := resultOutput{
		Result:   out.Result,
		Events:   out.Events,
		Timeline: out.Timeline,
		Bundle:   out.Bundle,
	}
	if out.BundleErr != nil {
		payload.BundleError = out.BundleErr.Error()
	}
	if format == formatJSON {
		encoder := json.NewEncoder(w)
		encoder.SetIndent("", "  ")
		return encoder.Encode(payload)
	}
	res := out.Result
	fmt.Fprintf(w, "task_id: %s\n", res.TaskID)
	fmt.Fprintf(w, "run_id: %s\n", res.RunID)
	fmt.Fprintf(w, "outcome: %s\n", res.Outcome)
	fmt.Fprintf(w, "terminal_state: %s\n", res.State)
	fmt.Fprintf(w, "code: %s\n", res.Code)
	fmt.Fprintf(w, "reason: %s\n", res.Reason)
	fmt.Fprintf(w, "risk_class: %s\n", res.RiskClass)
	fmt.Fprintf(w, "risk_decision_code: %s\n", res.RiskDecisionCode)
	fmt.Fprintf(w, "actions_dispatched: %d\n", res.ActionsDispatched)
	fmt.Fprintf(w, "events: %d\n", len(out.Events))
	if out.Timeline != nil {
		fmt.Fprintf(w, "timeline_events: %d\n", len(out.Timeline.Events))
	}
	if out.Bundle != nil {
		fmt.Fprintf(w, "patch_status: %s\n", out.Bundle.PatchReport.PatchStatus)
		fmt.Fprintf(w, "evidence_references: %d\n", len(out.Bundle.EvidenceReferences))
	} else if out.BundleErr != nil {
		fmt.Fprintf(w, "bundle_error: %s\n", out.BundleErr.Error())
	}
	fmt.Fprintf(w, "exit_code: %d\n", res.ExitCode)
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
