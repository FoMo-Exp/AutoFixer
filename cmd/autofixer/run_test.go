package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Luthiel/AutoFixer/delivery"
)

// baseInputJSON is the controlled task input for an offline echo run: low
// risk, one allow-listed tool, no network, no provider credentials. The
// repository is the one delivery allows so the evidence bundle validates.
func baseInputJSON() map[string]any {
	return map[string]any{
		"task_id":            "task-cli-1",
		"issue_id":           "issue-cli-1",
		"repository":         map[string]any{"url": delivery.AllowedRepositoryURL, "base_sha": "base111"},
		"actor_identity":     "human:tester",
		"execution_identity": "agent:runner",
		"requested_work":     map[string]any{"localized_reversible_change": true},
		"summary":            "CLI echo run over the allow-listed tool.",
		"source_reference":   "issue://issue-cli-1",
		"grant": map[string]any{
			"capability_grant_version": "cg-1",
			"permitted_paths":          []any{"."},
			"permitted_tools":          []any{map[string]any{"identity": "echo", "allowed_arguments": []any{"hello"}}},
			"max_wall_clock_seconds":   30,
		},
		"plan": map[string]any{
			"version":     "1",
			"task_id":     "task-cli-1",
			"disposition": "actions",
			"steps":       []any{map[string]any{"tool": "echo", "arguments": []any{"hello"}}},
		},
	}
}

func writeInput(t *testing.T, input map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	path := filepath.Join(t.TempDir(), "task.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write input: %v", err)
	}
	return path
}

func decodeJSON(t *testing.T, out *bytes.Buffer) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, out.String())
	}
	return parsed
}

func TestRunCommandCompletesTaskAndEmitsJSONResult(t *testing.T) {
	path := writeInput(t, baseInputJSON())
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json"}, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("exit = %d, want 0\nstdout: %s\nstderr: %s", exit, stdout.String(), stderr.String())
	}
	parsed := decodeJSON(t, &stdout)
	if parsed["outcome"] != "completed" || parsed["terminal_state"] != "stopped" {
		t.Fatalf("outcome/terminal_state = %v/%v, want completed/stopped", parsed["outcome"], parsed["terminal_state"])
	}
	if parsed["task_id"] != "task-cli-1" || parsed["run_id"] == "" {
		t.Fatalf("task linkage = %v/%v, want task-cli-1 and a generated run id", parsed["task_id"], parsed["run_id"])
	}
	if parsed["exit_code"] != float64(0) {
		t.Fatalf("exit_code = %v, want 0", parsed["exit_code"])
	}
	events, ok := parsed["events"].([]any)
	if !ok || len(events) < 5 {
		t.Fatalf("events = %v, want at least 5 audit records", parsed["events"])
	}
	if parsed["actions_dispatched"] != float64(1) {
		t.Fatalf("actions_dispatched = %v, want 1", parsed["actions_dispatched"])
	}
	timeline, ok := parsed["timeline"].(map[string]any)
	if !ok || timeline["task_id"] != "task-cli-1" {
		t.Fatalf("timeline = %v, want a task-cli-1 application timeline", parsed["timeline"])
	}
	bundle, ok := parsed["evidence_bundle"].(map[string]any)
	if !ok {
		t.Fatalf("evidence_bundle = %v, want a delivery evidence bundle", parsed["evidence_bundle"])
	}
	if bundle["contract_version"] != "1.0.0" {
		t.Fatalf("bundle contract_version = %v, want 1.0.0", bundle["contract_version"])
	}
	patch, ok := bundle["patch_report"].(map[string]any)
	if !ok || patch["patch_status"] != "not_created" {
		t.Fatalf("patch_report = %v, want not_created", bundle["patch_report"])
	}
	if bundle["capability_grant"] == nil {
		t.Fatalf("capability_grant = nil, want the issued grant retained in the bundle")
	}
	if refs, ok := bundle["evidence_references"].([]any); !ok || len(refs) == 0 {
		t.Fatalf("evidence_references = %v, want resolvable references", bundle["evidence_references"])
	}
	if parsed["bundle_error"] != nil {
		t.Fatalf("bundle_error = %v, want no bundle error on the success path", parsed["bundle_error"])
	}
}

func TestRunCommandRejectsInvalidInputWithNonZeroExit(t *testing.T) {
	input := baseInputJSON()
	delete(input, "task_id")
	path := writeInput(t, input)
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json"}, &stdout, &stderr)
	if exit != 2 {
		t.Fatalf("exit = %d, want 2\nstdout: %s", exit, stdout.String())
	}
	parsed := decodeJSON(t, &stdout)
	message, _ := parsed["error"].(string)
	if !strings.Contains(message, "task_id") {
		t.Fatalf("error = %q, want it to name task_id", message)
	}
	if parsed["exit_code"] != float64(2) {
		t.Fatalf("exit_code = %v, want 2", parsed["exit_code"])
	}
}

func TestRunCommandRejectsProhibitedWork(t *testing.T) {
	input := baseInputJSON()
	input["requested_work"] = map[string]any{"requests_secret_access": true}
	path := writeInput(t, input)
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json"}, &stdout, &stderr)
	if exit != 3 {
		t.Fatalf("exit = %d, want 3\nstdout: %s", exit, stdout.String())
	}
	parsed := decodeJSON(t, &stdout)
	if parsed["outcome"] != "rejected" || parsed["terminal_state"] != "rejected" {
		t.Fatalf("outcome/terminal_state = %v/%v, want rejected/rejected", parsed["outcome"], parsed["terminal_state"])
	}
	if parsed["code"] != "prohibited_secret_access" {
		t.Fatalf("code = %v, want prohibited_secret_access", parsed["code"])
	}
	bundle, ok := parsed["evidence_bundle"].(map[string]any)
	if !ok {
		t.Fatalf("evidence_bundle = %v, want an auditable bundle for the refusal", parsed["evidence_bundle"])
	}
	if bundle["capability_grant"] != nil {
		t.Fatalf("capability_grant = %v, want null for a refused run", bundle["capability_grant"])
	}
	risk, ok := bundle["risk_assessment"].(map[string]any)
	if !ok || risk["risk_class"] != "prohibited" {
		t.Fatalf("risk_assessment = %v, want prohibited", bundle["risk_assessment"])
	}
}

func TestRunCommandReportsMalformedInputFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "task.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write input: %v", err)
	}
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "json"}, &stdout, &stderr)
	if exit != 2 {
		t.Fatalf("exit = %d, want 2", exit)
	}
	if parsed := decodeJSON(t, &stdout); parsed["error"] == nil || parsed["error"] == "" {
		t.Fatalf("error = %v, want a structured reason", parsed["error"])
	}
}

func TestRunCommandRejectsUnknownFormat(t *testing.T) {
	path := writeInput(t, baseInputJSON())
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path, "--format", "yaml"}, &stdout, &stderr)
	if exit != 2 {
		t.Fatalf("exit = %d, want 2", exit)
	}
}

func TestRunCommandRequiresInputAndRunCommand(t *testing.T) {
	cases := map[string][]string{
		"no arguments":       {},
		"unknown command":    {"frobnicate"},
		"missing input flag": {"run", "--format", "json"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if exit := runCLI(args, &stdout, &stderr); exit != 2 {
				t.Fatalf("exit = %d, want 2", exit)
			}
		})
	}
}

func TestRunCommandPrintsHumanReadableText(t *testing.T) {
	path := writeInput(t, baseInputJSON())
	var stdout, stderr bytes.Buffer

	exit := runCLI([]string{"run", "--input", path}, &stdout, &stderr)
	if exit != 0 {
		t.Fatalf("exit = %d, want 0\nstdout: %s", exit, stdout.String())
	}
	for _, want := range []string{
		"task_id: task-cli-1",
		"outcome: completed",
		"terminal_state: stopped",
		"risk_class: low",
		"patch_status: not_created",
		"exit_code: 0",
	} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("stdout missing %q:\n%s", want, stdout.String())
		}
	}
}
