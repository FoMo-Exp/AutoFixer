package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/delivery"
)

// decodeResult parses one CLI JSON result document.
func decodeResult(t *testing.T, out *bytes.Buffer) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, out.String())
	}
	return parsed
}

func bundleOf(t *testing.T, parsed map[string]any) map[string]any {
	t.Helper()
	bundle, ok := parsed["evidence_bundle"].(map[string]any)
	if !ok {
		t.Fatalf("evidence_bundle = %v, want a delivery evidence bundle", parsed["evidence_bundle"])
	}
	return bundle
}

func patchStatus(t *testing.T, bundle map[string]any) string {
	t.Helper()
	patch, ok := bundle["patch_report"].(map[string]any)
	if !ok {
		t.Fatalf("patch_report = %v, want a patch report", bundle["patch_report"])
	}
	status, _ := patch["patch_status"].(string)
	return status
}

func assertNoSecrets(t *testing.T, parsed map[string]any) {
	t.Helper()
	raw, err := json.Marshal(parsed)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	for _, marker := range []string{"token=", "password=", "secret=", "api_key=", "credential="} {
		if bytes.Contains(bytes.ToLower(raw), []byte(strings.ToLower(marker))) {
			t.Fatalf("result contains secret-looking marker %q:\n%s", marker, raw)
		}
	}
}

// TestGoldenDemoCompletesOffline runs the embedded golden-task fixture through
// the documented demo command: controlled input -> plan -> allow-listed tool ->
// evidence timeline -> not_created delivery bundle, entirely offline.
func TestGoldenDemoCompletesOffline(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exit := runCLI([]string{"demo", "--format", "json"}, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("exit = %d, want 0\nstdout: %s\nstderr: %s", exit, stdout.String(), stderr.String())
	}
	parsed := decodeResult(t, &stdout)
	if parsed["outcome"] != "completed" || parsed["terminal_state"] != "stopped" {
		t.Fatalf("outcome/terminal_state = %v/%v, want completed/stopped", parsed["outcome"], parsed["terminal_state"])
	}
	if parsed["task_id"] != "golden-localized-001" {
		t.Fatalf("task_id = %v, want golden-localized-001", parsed["task_id"])
	}
	if parsed["actions_dispatched"] != float64(1) {
		t.Fatalf("actions_dispatched = %v, want 1", parsed["actions_dispatched"])
	}
	if parsed["risk_class"] != "low" {
		t.Fatalf("risk_class = %v, want low", parsed["risk_class"])
	}

	bundle := bundleOf(t, parsed)
	if got := patchStatus(t, bundle); got != "not_created" {
		t.Fatalf("patch_status = %v, want not_created", got)
	}
	if bundle["capability_grant"] == nil {
		t.Fatalf("capability_grant = nil, want the issued grant")
	}
	risk, _ := bundle["risk_assessment"].(map[string]any)
	if risk == nil || risk["risk_class"] != "low" {
		t.Fatalf("risk_assessment = %v, want low", bundle["risk_assessment"])
	}
	events, _ := bundle["execution_events"].([]any)
	if len(events) < 5 {
		t.Fatalf("execution_events = %d, want the full dispatch chain", len(events))
	}

	timeline, ok := parsed["timeline"].(map[string]any)
	if !ok || timeline["task_id"] != "golden-localized-001" {
		t.Fatalf("timeline = %v, want the application timeline", parsed["timeline"])
	}
	timelineEvents, _ := timeline["events"].([]any)
	if len(timelineEvents) == 0 {
		t.Fatalf("timeline events = 0, want the recorded application timeline")
	}
	sawArtifact := false
	for _, item := range timelineEvents {
		event, _ := item.(map[string]any)
		if event["type"] == "artifact" {
			sawArtifact = true
		}
	}
	if !sawArtifact {
		t.Fatalf("timeline = %v, want an artifact event indexing the evidence bundle", timeline["events"])
	}
	assertNoSecrets(t, parsed)
}

// TestE2EIllegalPlanIsRejectedTerminal feeds a plan whose step names an empty
// tool. The planner validation refuses it before any dispatch; the run ends
// rejected with an auditable bundle and no side effects.
func TestE2EIllegalPlanIsRejectedTerminal(t *testing.T) {
	input := baseInputJSON()
	input["task_id"] = "task-illegal-plan"
	input["plan"] = map[string]any{
		"version":     "1",
		"task_id":     "task-illegal-plan",
		"disposition": "actions",
		"steps":       []any{map[string]any{"tool": "", "arguments": []any{"hello"}}},
	}
	path := writeInput(t, input)
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json"}, &stdout, &stderr)
	if exit != 3 {
		t.Fatalf("exit = %d, want 3\nstdout: %s\nstderr: %s", exit, stdout.String(), stderr.String())
	}
	parsed := decodeResult(t, &stdout)
	if parsed["outcome"] != "rejected" || parsed["code"] != "invalid_plan" {
		t.Fatalf("outcome/code = %v/%v, want rejected/invalid_plan", parsed["outcome"], parsed["code"])
	}
	if parsed["actions_dispatched"] != float64(0) {
		t.Fatalf("actions_dispatched = %v, want 0 for a rejected plan", parsed["actions_dispatched"])
	}
	bundle := bundleOf(t, parsed)
	if got := patchStatus(t, bundle); got != "not_created" {
		t.Fatalf("patch_status = %v, want not_created", got)
	}
	if bundle["capability_grant"] != nil {
		t.Fatalf("capability_grant = %v, want null when no grant was issued", bundle["capability_grant"])
	}
}

// TestE2ERegistryDeniesUnregisteredTool demonstrates the independent registry
// gate: the grant permits the tool, but the composition-owned allow-list does
// not, so the dispatch is denied before any process runs and no dispatch is
// counted.
func TestE2ERegistryDeniesUnregisteredTool(t *testing.T) {
	input := baseInputJSON()
	input["task_id"] = "task-unregistered"
	input["grant"] = map[string]any{
		"capability_grant_version": "cg-1",
		"permitted_paths":          []any{"."},
		"permitted_tools":          []any{map[string]any{"identity": "uname", "allowed_arguments": []any{"-s"}}},
		"max_wall_clock_seconds":   30,
	}
	input["plan"] = map[string]any{
		"version":     "1",
		"task_id":     "task-unregistered",
		"disposition": "actions",
		"steps":       []any{map[string]any{"tool": "uname", "arguments": []any{"-s"}}},
	}
	path := writeInput(t, input)
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json"}, &stdout, &stderr)
	if exit != 6 {
		t.Fatalf("exit = %d, want 6 (stopped)\nstdout: %s\nstderr: %s", exit, stdout.String(), stderr.String())
	}
	parsed := decodeResult(t, &stdout)
	if parsed["outcome"] != "denied" {
		t.Fatalf("outcome = %v, want denied", parsed["outcome"])
	}
	if parsed["code"] != "deny_tool_unregistered" {
		t.Fatalf("code = %v, want deny_tool_unregistered", parsed["code"])
	}
	if parsed["actions_dispatched"] != float64(0) {
		t.Fatalf("actions_dispatched = %v, want 0: the registry denied before dispatch", parsed["actions_dispatched"])
	}
	events, _ := parsed["events"].([]any)
	for _, item := range events {
		event, _ := item.(map[string]any)
		if event["event_type"] == "tool_invocation" {
			t.Fatalf("registry denial must leave no tool_invocation evidence, got %v", event)
		}
	}
	bundle := bundleOf(t, parsed)
	if got := patchStatus(t, bundle); got != "not_created" {
		t.Fatalf("patch_status = %v, want not_created", got)
	}
}

// TestE2EHarnessDeniesOutOfGrantTool demonstrates the authoritative harness
// gate: the registry permits the tool, but the capability grant does not name
// it, so FP-03 denies the dispatch and stops the run with out-of-grant
// evidence.
func TestE2EHarnessDeniesOutOfGrantTool(t *testing.T) {
	input := baseInputJSON()
	input["task_id"] = "task-out-of-grant"
	// The grant permits only sleep; the plan asks for the registry-permitted
	// echo, so the harness grant check is the gate that denies.
	input["grant"] = map[string]any{
		"capability_grant_version": "cg-1",
		"permitted_paths":          []any{"."},
		"permitted_tools":          []any{map[string]any{"identity": "sleep", "allowed_arguments": []any{"5"}}},
		"max_wall_clock_seconds":   30,
	}
	input["plan"] = map[string]any{
		"version":     "1",
		"task_id":     "task-out-of-grant",
		"disposition": "actions",
		"steps":       []any{map[string]any{"tool": "echo", "arguments": []any{"hello"}}},
	}
	path := writeInput(t, input)
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json"}, &stdout, &stderr)
	if exit != 6 {
		t.Fatalf("exit = %d, want 6 (stopped)\nstdout: %s\nstderr: %s", exit, stdout.String(), stderr.String())
	}
	parsed := decodeResult(t, &stdout)
	if parsed["outcome"] != "denied" {
		t.Fatalf("outcome = %v, want denied", parsed["outcome"])
	}
	if parsed["code"] != "stop_out_of_grant" {
		t.Fatalf("code = %v, want stop_out_of_grant", parsed["code"])
	}
	if parsed["actions_dispatched"] != float64(0) {
		t.Fatalf("actions_dispatched = %v, want 0 for a grant denial", parsed["actions_dispatched"])
	}
	bundle := bundleOf(t, parsed)
	if got := patchStatus(t, bundle); got != "not_created" {
		t.Fatalf("patch_status = %v, want not_created", got)
	}
	if bundle["capability_grant"] == nil {
		t.Fatalf("capability_grant = nil, want the issued grant retained")
	}
}

// TestE2ETimesOutDuringDispatch runs a permitted sleep under a one-second
// task timeout and expects a terminal timed_out outcome with an auditable
// bundle.
func TestE2ETimesOutDuringDispatch(t *testing.T) {
	input := baseInputJSON()
	input["task_id"] = "task-timeout"
	input["grant"] = map[string]any{
		"capability_grant_version": "cg-1",
		"permitted_paths":          []any{"."},
		"permitted_tools":          []any{map[string]any{"identity": "sleep", "allowed_arguments": []any{"5"}}},
		"max_wall_clock_seconds":   30,
	}
	input["plan"] = map[string]any{
		"version":     "1",
		"task_id":     "task-timeout",
		"disposition": "actions",
		"steps":       []any{map[string]any{"tool": "sleep", "arguments": []any{"5"}}},
	}
	path := writeInput(t, input)
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json", "--timeout", "1s"}, &stdout, &stderr)
	if exit != 5 {
		t.Fatalf("exit = %d, want 5 (timed out)\nstdout: %s\nstderr: %s", exit, stdout.String(), stderr.String())
	}
	parsed := decodeResult(t, &stdout)
	if parsed["outcome"] != "timed_out" {
		t.Fatalf("outcome = %v, want timed_out", parsed["outcome"])
	}
	if parsed["terminal_state"] != "timed_out" {
		t.Fatalf("terminal_state = %v, want timed_out", parsed["terminal_state"])
	}
	bundle := bundleOf(t, parsed)
	if got := patchStatus(t, bundle); got != "not_created" {
		t.Fatalf("patch_status = %v, want not_created", got)
	}
}

// TestE2ECancelDuringDispatch cancels the context while a permitted sleep is
// running and expects a terminal cancelled outcome with an auditable bundle
// and no surviving workspace side effects.
func TestE2ECancelDuringDispatch(t *testing.T) {
	input := baseInputJSON()
	input["task_id"] = "task-cancel"
	input["grant"] = map[string]any{
		"capability_grant_version": "cg-1",
		"permitted_paths":          []any{"."},
		"permitted_tools":          []any{map[string]any{"identity": "sleep", "allowed_arguments": []any{"5"}}},
		"max_wall_clock_seconds":   30,
	}
	input["plan"] = map[string]any{
		"version":     "1",
		"task_id":     "task-cancel",
		"disposition": "actions",
		"steps":       []any{map[string]any{"tool": "sleep", "arguments": []any{"5"}}},
	}

	file, err := parseInputMap(t, input)
	if err != nil {
		t.Fatalf("parse input: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		time.Sleep(400 * time.Millisecond)
		cancel()
	}()

	out := runTask(ctx, file, 0)
	if out.Result.ExitCode != 4 {
		t.Fatalf("exit = %d, want 4 (cancelled)\nresult: %+v\nerr: %v", out.Result.ExitCode, out.Result, out.RunErr)
	}
	if out.Result.Outcome != "cancelled" || out.Result.State != "cancelled" {
		t.Fatalf("outcome/state = %v/%v, want cancelled/cancelled", out.Result.Outcome, out.Result.State)
	}
	if out.Bundle == nil {
		t.Fatalf("bundle = nil, want an auditable bundle for the cancellation (err: %v)", out.BundleErr)
	}
	if got := out.Bundle.PatchReport.PatchStatus; got != delivery.PatchNotCreated {
		t.Fatalf("patch_status = %v, want not_created", got)
	}
}

// TestE2EBundleAndTimelineReferenceCurrentEvidence checks that the emitted
// artifacts reference the run's own task/session/audit evidence: the bundle
// and timeline share the run's identifiers, and every patch-report evidence
// reference points into the run's event chain.
func TestE2EBundleAndTimelineReferenceCurrentEvidence(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exit := runCLI([]string{"demo", "--format", "json"}, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("exit = %d, want 0\nstdout: %s", exit, stdout.String())
	}
	parsed := decodeResult(t, &stdout)
	runID, _ := parsed["run_id"].(string)
	taskID, _ := parsed["task_id"].(string)
	if runID == "" || taskID == "" {
		t.Fatalf("task/run identity = %v/%v, want both set", taskID, runID)
	}

	bundle := bundleOf(t, parsed)
	bundleTask, _ := bundle["task_input"].(map[string]any)
	if bundleTask["task_id"] != taskID {
		t.Fatalf("bundle task_id = %v, want %v", bundleTask["task_id"], taskID)
	}
	events, _ := bundle["execution_events"].([]any)
	last, _ := events[len(events)-1].(map[string]any)
	seq, _ := last["sequence"].(float64)
	terminalRef := "evidence://events/" + runID + "/" + strconv.Itoa(int(seq))
	patch, _ := bundle["patch_report"].(map[string]any)
	refs, _ := patch["evidence_references"].([]any)
	found := false
	for _, ref := range refs {
		if ref == terminalRef {
			found = true
		}
	}
	if !found {
		t.Fatalf("patch report evidence_references = %v, want the terminal reference %v", refs, terminalRef)
	}

	timeline, _ := parsed["timeline"].(map[string]any)
	if timeline["task_id"] != taskID {
		t.Fatalf("timeline task_id = %v, want %v", timeline["task_id"], taskID)
	}
	state, _ := timeline["state"].(string)
	if state != "stopped" {
		t.Fatalf("timeline state = %v, want stopped", state)
	}
	assertNoSecrets(t, parsed)
}

func parseInputMap(t *testing.T, input map[string]any) (fileInput, error) {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		return fileInput{}, err
	}
	var file fileInput
	if err := json.Unmarshal(raw, &file); err != nil {
		return fileInput{}, err
	}
	return file, nil
}
