package sandbox

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

// fakeWorld is a mutable process table with a recording kill, so supervisor
// tests exercise tracking, sweeping, draining, and recycling guards without
// ever signaling a real process.
type fakeWorld struct {
	mu     sync.Mutex
	procs  map[int]procInfo
	killed []int
}

func newFakeWorld(procs ...procInfo) *fakeWorld {
	w := &fakeWorld{procs: map[int]procInfo{}}
	for _, p := range procs {
		w.procs[p.pid] = p
	}
	return w
}

func (w *fakeWorld) snapshot() ([]procInfo, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]procInfo, 0, len(w.procs))
	for _, p := range w.procs {
		out = append(out, p)
	}
	return out, nil
}

func (w *fakeWorld) kill(pid int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.killed = append(w.killed, pid)
	delete(w.procs, pid)
}

func (w *fakeWorld) set(procs ...procInfo) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.procs = map[int]procInfo{}
	for _, p := range procs {
		w.procs[p.pid] = p
	}
}

func (w *fakeWorld) killedPids() []int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]int{}, w.killed...)
}

// useWorld installs the world's kill as the platform kill for one test.
func useWorld(t *testing.T, w *fakeWorld) {
	t.Helper()
	old := killProc
	killProc = w.kill
	t.Cleanup(func() { killProc = old })
	oldTimeout := drainTimeout
	drainTimeout = 2 * time.Second
	t.Cleanup(func() { drainTimeout = oldTimeout })
}

func waitKilled(t *testing.T, w *fakeWorld, pid int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, killed := range w.killedPids() {
			if killed == pid {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("pid %d was never killed; killed=%v", pid, w.killedPids())
}

func TestLimitSupervisorKillsOnMemoryBreach(t *testing.T) {
	w := newFakeWorld(procInfo{pid: 4242, pgid: 4242, start: 1, resident: 64 << 20})
	useWorld(t, w)
	sup, err := newLimitSupervisor(4242, resourceLimits{MemoryBytes: 32 << 20, CPUSeconds: 60}, time.Millisecond, w.snapshot, func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.start()
	waitKilled(t, w, 4242)
	if breach := sup.finish(); breach != BreachMemory {
		t.Errorf("breach = %q, want %q", breach, BreachMemory)
	}
}

func TestLimitSupervisorKillsOnCPUBreach(t *testing.T) {
	w := newFakeWorld(procInfo{pid: 4242, pgid: 4242, start: 1, cpu: 5 * time.Second})
	useWorld(t, w)
	sup, err := newLimitSupervisor(4242, resourceLimits{MemoryBytes: 1 << 30, CPUSeconds: 1}, time.Millisecond, w.snapshot, func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.start()
	waitKilled(t, w, 4242)
	if breach := sup.finish(); breach != BreachCPU {
		t.Errorf("breach = %q, want %q", breach, BreachCPU)
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
	useWorld(t, newFakeWorld())
	oldTimeout := drainTimeout
	drainTimeout = 100 * time.Millisecond
	t.Cleanup(func() { drainTimeout = oldTimeout })
	sup, err := newLimitSupervisor(4242, resourceLimits{MemoryBytes: 32 << 20}, time.Millisecond,
		func() ([]procInfo, error) { return nil, errors.New("accounting gone") },
		func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.start()
	if breach := sup.finish(); breach != BreachAccounting {
		t.Errorf("breach = %q, want %q", breach, BreachAccounting)
	}
}

func TestLimitSupervisorWithoutLimitsStillCleansUp(t *testing.T) {
	// No declared caps: nothing is enforced, but the execution's process
	// lifecycle is still owned — leftovers die with the execution.
	w := newFakeWorld(procInfo{pid: 4242, pgid: 4242, start: 1})
	useWorld(t, w)
	sup, err := newLimitSupervisor(4242, resourceLimits{}, time.Millisecond, w.snapshot, func() {})
	if err != nil || sup == nil {
		t.Fatalf("supervisor = %v err = %v, want a lifecycle supervisor with no caps", sup, err)
	}
	sup.start()
	if breach := sup.finish(); breach != "" {
		t.Errorf("breach = %q, want none", breach)
	}
	waitKilled(t, w, 4242)
}

func TestSupervisorSweepKillsTrackedSessionEscapee(t *testing.T) {
	// A child that was observed in the domain, then created its own session
	// and was reparented (pgid and ppid both leave the leader), is no
	// longer discoverable by ancestry — the tracked set is what keeps it
	// part of the execution, and the sweep must terminate it.
	w := newFakeWorld(procInfo{pid: 777, pgid: 777, ppid: 1, start: 5})
	useWorld(t, w)
	sup, err := newLimitSupervisor(4242, resourceLimits{}, time.Millisecond, w.snapshot, func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.track([]procInfo{{pid: 777, pgid: 4242, ppid: 4242, start: 5}})
	sup.start()
	if breach := sup.finish(); breach != "" {
		t.Errorf("breach = %q, want none", breach)
	}
	waitKilled(t, w, 777)
}

func TestSupervisorSweepSkipsRecycledPids(t *testing.T) {
	// The tracked pid must be killed only while it is still the same
	// process: a recycled pid belongs to someone else.
	w := newFakeWorld(procInfo{pid: 777, pgid: 777, ppid: 1, start: 9})
	useWorld(t, w)
	sup, err := newLimitSupervisor(4242, resourceLimits{}, time.Millisecond, w.snapshot, func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.track([]procInfo{{pid: 777, pgid: 4242, ppid: 4242, start: 5}})
	sup.start()
	if breach := sup.finish(); breach != "" {
		t.Errorf("breach = %q, want none", breach)
	}
	if killed := w.killedPids(); len(killed) != 0 {
		t.Errorf("killed = %v, want none (the tracked process died; pid 777 was recycled)", killed)
	}
}

func TestSupervisorStraySweepKillsDetachedDaemon(t *testing.T) {
	// A daemon that detached before any observation is unreachable by
	// ancestry and untracked — the workspace fingerprint sweep is what
	// keeps it from outliving its execution.
	w := newFakeWorld(procInfo{pid: 777, pgid: 777, ppid: 1, start: 5})
	useWorld(t, w)
	sup, err := newLimitSupervisor(4242, resourceLimits{}, time.Millisecond, w.snapshot, func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.stray = func(p procInfo) bool { return p.pid == 777 }
	sup.start()
	if breach := sup.finish(); breach != "" {
		t.Errorf("breach = %q, want none", breach)
	}
	waitKilled(t, w, 777)
}

func TestSupervisorZombiesDoNotBlockDrain(t *testing.T) {
	// An un-reaped zombie is already dead: it must not hold the drain open
	// or be killed again.
	w := newFakeWorld(procInfo{pid: 4242, pgid: 4242, start: 1, zombie: true})
	useWorld(t, w)
	sup, err := newLimitSupervisor(4242, resourceLimits{}, time.Millisecond, w.snapshot, func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	sup.start()
	if breach := sup.finish(); breach != "" {
		t.Errorf("breach = %q, want none", breach)
	}
	if killed := w.killedPids(); len(killed) != 0 {
		t.Errorf("killed = %v, want none (a zombie is already dead)", killed)
	}
}

func TestSupervisorCleanupFailureIsRecorded(t *testing.T) {
	// A process that survives every termination attempt is a containment
	// failure the run must record, not a silent leak.
	unkillable := newFakeWorld(procInfo{pid: 777, pgid: 777, ppid: 1, start: 5})
	useWorld(t, unkillable)
	oldTimeout := drainTimeout
	drainTimeout = 100 * time.Millisecond
	t.Cleanup(func() { drainTimeout = oldTimeout })
	sup, err := newLimitSupervisor(4242, resourceLimits{}, time.Millisecond, unkillable.snapshot, func() {})
	if err != nil {
		t.Fatalf("newLimitSupervisor: %v", err)
	}
	// A kill that never removes the process: SIGKILL was sent but the
	// process is still there (unkillable state).
	old := killProc
	killProc = func(pid int) {}
	t.Cleanup(func() { killProc = old })
	sup.stray = func(p procInfo) bool { return p.pid == 777 }
	sup.start()
	if breach := sup.finish(); breach != BreachCleanup {
		t.Errorf("breach = %q, want %q", breach, BreachCleanup)
	}
}

// --- real-process probes ---------------------------------------------------

// probeProfile serves one python command line as a registered test profile.
func probeProfile(script string) []ExecProfile {
	return []ExecProfile{{
		ID:                  "probe.test",
		Kind:                ProfileTest,
		Command:             "/usr/bin/python3",
		Modes:               []string{"focused"},
		MaxWallClockSeconds: 60,
		OutputLimitBytes:    1 << 20,
		Build: func(mode, target string) ([]string, error) {
			return []string{"-c", script}, nil
		},
	}}
}

// probeOutputChildPid finds the pid the probe script reported after label.
func probeOutputChildPid(t *testing.T, out []byte, label string) int {
	t.Helper()
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == label {
			pid, err := strconv.Atoi(fields[1])
			if err == nil && pid > 1 {
				return pid
			}
		}
	}
	t.Fatalf("no %q pid line in output %q", label, out)
	return 0
}

// mustBeGone asserts one pid no longer exists.
func mustBeGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Errorf("pid %d survived the execution", pid)
}

// TestExecuteProfileTerminatesSurvivingChildren runs a command that spawns a
// background child and exits normally, and verifies the child does not
// outlive the execution.
func TestExecuteProfileTerminatesSurvivingChildren(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skipf("python3 not available for the survivor probe: %v", err)
	}
	script := "import subprocess\n" +
		"p = subprocess.Popen(['/bin/sleep','30'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n" +
		"print('child', p.pid, flush=True)\n" +
		"import time\ntime.sleep(0.3)\n"
	runner, _ := structuredFixture(t, func(o *Options) { o.Profiles = probeProfile(script) })
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
	if res.ResourceExceeded != "" {
		t.Fatalf("ResourceExceeded = %q, want none (output %q)", res.ResourceExceeded, res.Output)
	}
	child := probeOutputChildPid(t, res.Output, "child")
	mustBeGone(t, child)
}

// TestExecuteProfileTerminatesSetsidEscapedChildren runs a command that
// immediately daemonizes a child (new session, reparented at parent exit)
// and verifies the child does not outlive the execution: the descendant is
// tracked before it can detach and swept even though no ancestry remains.
func TestExecuteProfileTerminatesSetsidEscapedChildren(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skipf("python3 not available for the setsid probe: %v", err)
	}
	script := "import subprocess\n" +
		"p = subprocess.Popen(['/bin/sleep','30'], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n" +
		"print('daemon', p.pid, flush=True)\n"
	runner, _ := structuredFixture(t, func(o *Options) { o.Profiles = probeProfile(script) })
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
	if res.ResourceExceeded != "" {
		t.Fatalf("ResourceExceeded = %q, want none (output %q)", res.ResourceExceeded, res.Output)
	}
	daemon := probeOutputChildPid(t, res.Output, "daemon")
	mustBeGone(t, daemon)
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
