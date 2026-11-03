package sandbox

import (
	"context"
	"errors"
	"os/exec"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

func TestLimitSupervisorKillsOnMemoryBreach(t *testing.T) {
	killed := false
	sup, err := newLimitSupervisor(4242, resourceLimits{MemoryBytes: 32 << 20, CPUSeconds: 60}, time.Millisecond,
		func(int) (int64, time.Duration, error) { return 64 << 20, 0, nil },
		func() { killed = true })
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.start()
	deadline := time.Now().Add(2 * time.Second)
	for !killed && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !killed {
		t.Fatal("supervisor did not kill on memory breach")
	}
	if breach := sup.stop(); breach != "memory" {
		t.Errorf("breach = %q, want memory", breach)
	}
}

func TestLimitSupervisorKillsOnCPUBreach(t *testing.T) {
	killed := false
	sup, err := newLimitSupervisor(4242, resourceLimits{MemoryBytes: 1 << 30, CPUSeconds: 1}, time.Millisecond,
		func(int) (int64, time.Duration, error) { return 1 << 20, 5 * time.Second, nil },
		func() { killed = true })
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.start()
	deadline := time.Now().Add(2 * time.Second)
	for !killed && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !killed {
		t.Fatal("supervisor did not kill on CPU breach")
	}
	if breach := sup.stop(); breach != "cpu" {
		t.Errorf("breach = %q, want cpu", breach)
	}
}

func TestLimitSupervisorFailsClosedWithoutAccounting(t *testing.T) {
	// A platform that cannot account for a process group cannot enforce the
	// grant's limits: the execution is blocked instead of running uncapped.
	_, err := newLimitSupervisor(4242, resourceLimits{MemoryBytes: 32 << 20}, time.Millisecond, nil, func() {})
	if !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("error = %v, want ErrIsolationUnavailable (fail closed)", err)
	}
}

func TestLimitSupervisorStopsExecutionWhenAccountingDies(t *testing.T) {
	// Accounting that keeps failing mid-run makes the caps unenforceable:
	// the execution is stopped rather than left to run uncapped.
	killed := false
	sup, err := newLimitSupervisor(4242, resourceLimits{MemoryBytes: 32 << 20}, time.Millisecond,
		func(int) (int64, time.Duration, error) { return 0, 0, errors.New("accounting gone") },
		func() { killed = true })
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.start()
	deadline := time.Now().Add(2 * time.Second)
	for !killed && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !killed {
		t.Fatal("supervisor did not stop the execution when accounting broke down")
	}
	if breach := sup.stop(); breach != "accounting" {
		t.Errorf("breach = %q, want accounting", breach)
	}
}

func TestLimitSupervisorIsAbsentWithoutLimits(t *testing.T) {
	sup, err := newLimitSupervisor(4242, resourceLimits{}, time.Millisecond,
		func(int) (int64, time.Duration, error) { return 0, 0, nil },
		func() {})
	if err != nil || sup != nil {
		t.Fatalf("supervisor = %v err = %v, want absent with no declared limits", sup, err)
	}
}

// TestExecuteProfileEnforcesResourceLimits runs a real memory-hog process
// under a declared cap and verifies the supervisor actually kills it: the
// limit is enforced, not merely declared.
func TestExecuteProfileEnforcesResourceLimits(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skipf("python3 not available for the hog probe: %v", err)
	}
	profiles := []ExecProfile{{
		ID:                  "probe.test",
		Kind:                ProfileTest,
		Command:             "/usr/bin/python3",
		Modes:               []string{"focused"},
		MaxWallClockSeconds: 60,
		OutputLimitBytes:    1 << 20,
		Build: func(mode, target string) ([]string, error) {
			// Allocate far beyond the granted cap, touch every page so the
			// footprint becomes resident, and then hold it: the supervisor
			// must kill the hog, not out-wait it.
			return []string{"-c", "x = bytearray(400*1024*1024)\nfor i in range(0, len(x), 4096): x[i] = 1\nprint('hog done', flush=True)\nimport time\ntime.sleep(30)"}, nil
		},
	}}
	runner, run := structuredFixtureFull(t, []string{"web/src"}, harness.ResourceLimits{MaxMemoryMB: 32, MaxCPUSeconds: 30},
		func(o *Options) { o.Profiles = profiles })
	res, err := runner.Execute(context.Background(), Spec{
		Tool:              "test.run",
		Arguments:         []string{"probe.test", "focused", "path:target"},
		EvidenceArguments: []string{"probe.test", "focused", "web/src/export.ts"},
		Paths:             []string{"web/src/export.ts"},
		Kind:              DispatchProfile,
		Process:           &ProcessRequest{ProfileID: "probe.test", Mode: "focused", Target: "web/src/export.ts"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.ResourceExceeded != "memory" {
		t.Fatalf("ResourceExceeded = %q, want memory (output %q)", res.ResourceExceeded, res.Output)
	}
	if run.State != harness.StateStopped {
		t.Errorf("run state = %v, want stopped after a resource violation", run.State)
	}
	if !run.Revoked {
		t.Error("resource violation must revoke the grant")
	}
}
