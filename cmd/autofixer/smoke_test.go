package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

var cliBinary string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "autofixer-cli-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "create build dir:", err)
		os.Exit(1)
	}
	cliBinary = filepath.Join(dir, "autofixer")
	build := exec.Command("go", "build", "-o", cliBinary, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "build autofixer:", err)
		os.RemoveAll(dir)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func runBinary(t *testing.T, input map[string]any) (stdout, stderr []byte, exitCode int) {
	t.Helper()
	path := writeInput(t, input)
	cmd := exec.Command(cliBinary, "run", "--input", path, "--format", "json")
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err := cmd.Run()
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	} else if err != nil {
		t.Fatalf("run binary: %v", err)
	}
	return out.Bytes(), errOut.Bytes(), code
}

// TestCLISmokeSuccess runs the built binary end to end, offline: controlled
// input, low risk, one permitted echo dispatch through the real sandbox, and
// a structured terminal result on stdout.
func TestCLISmokeSuccess(t *testing.T) {
	stdout, stderr, code := runBinary(t, baseInputJSON())
	if code != 0 {
		t.Fatalf("exit = %d, want 0\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	var parsed map[string]any
	if err := json.Unmarshal(stdout, &parsed); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout)
	}
	if parsed["outcome"] != "completed" || parsed["task_id"] != "task-cli-1" {
		t.Fatalf("outcome/task = %v/%v, want completed/task-cli-1", parsed["outcome"], parsed["task_id"])
	}
	events, _ := parsed["events"].([]any)
	if len(events) < 5 {
		t.Fatalf("events = %d, want audit evidence on stdout", len(events))
	}
}

// TestCLISmokeInvalidInput asserts the non-zero exit and structured reason
// for an illegal task input.
func TestCLISmokeInvalidInput(t *testing.T) {
	input := baseInputJSON()
	delete(input, "actor_identity")
	stdout, _, code := runBinary(t, input)
	if code != 2 {
		t.Fatalf("exit = %d, want 2\nstdout: %s", code, stdout)
	}
	var parsed map[string]any
	if err := json.Unmarshal(stdout, &parsed); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout)
	}
	message, _ := parsed["error"].(string)
	if message == "" {
		t.Fatalf("error = %v, want a structured reason", parsed["error"])
	}
}

// TestCLISmokeCancel sends SIGINT while a permitted sleep tool is running and
// expects the cancelled outcome with a non-zero exit.
func TestCLISmokeCancel(t *testing.T) {
	input := baseInputJSON()
	input["task_id"] = "task-cli-cancel"
	input["grant"] = map[string]any{
		"capability_grant_version": "cg-1",
		"permitted_paths":          []any{"."},
		"permitted_tools":          []any{map[string]any{"identity": "sleep", "allowed_arguments": []any{"5"}}},
		"max_wall_clock_seconds":   30,
	}
	input["actions"] = []any{map[string]any{"tool": "sleep", "arguments": []any{"5"}}}
	path := writeInput(t, input)

	cmd := exec.Command(cliBinary, "run", "--input", path, "--format", "json")
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Start(); err != nil {
		t.Fatalf("start binary: %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatalf("signal: %v", err)
	}
	err := cmd.Wait()
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("wait: %v", err)
	}
	if exitErr.ExitCode() != 4 {
		t.Fatalf("exit = %d, want 4\nstdout: %s", exitErr.ExitCode(), out.String())
	}
	var parsed map[string]any
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, out.String())
	}
	if parsed["outcome"] != "cancelled" || parsed["terminal_state"] != "cancelled" {
		t.Fatalf("outcome/terminal_state = %v/%v, want cancelled/cancelled", parsed["outcome"], parsed["terminal_state"])
	}
}
