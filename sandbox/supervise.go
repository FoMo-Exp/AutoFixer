package sandbox

import (
	"fmt"
	"sync"
	"time"
)

// Resource-limit enforcement: every declared limit from the capability grant
// is actually enforced on the execution, never merely recorded.
//
//   - supervisor_kill: the runner polls the execution's whole process domain
//     (its process group plus every descendant) and SIGKILLs the domain when
//     its aggregate resident memory or CPU time crosses the granted cap. The
//     overshoot is bounded by one poll interval.
//   - supervisor_kill+rlimit_cpu: the same, plus a kernel RLIMIT_CPU hard cap
//     pinned on the execution (see rlimit_linux.go). A process the kernel
//     kills with SIGXCPU is recorded as a CPU breach as well.
//
// The supervisor also owns the execution's process lifecycle: it records
// every domain member it ever observes (pid plus start-time identity), and
// when the execution ends it terminates every member it can attribute —
// including background children the command left behind and children that
// created their own session to escape the process group — then keeps
// enforcing the caps until nothing of the execution is still alive.
// Discovery of a daemonized child never depends on the parent chain
// surviving: a child seen while attached stays in the tracked set, and a
// child that detaches before any observation is found by the
// workspace-fingerprint pass in the final sweep. On macOS this lifecycle
// control is best-effort: a child that forks, calls setsid, is reparented,
// and moves its working directory out of the workspace between two
// observations is not attributable without a cgroup or PID namespace
// (DAT-253). Because that window cannot be closed without a kernel-owned
// domain, the darwin backend declares DomainBestEffort and the runner refuses
// untrusted execution there; the supervisor below backs the Linux PID
// namespace, where the domain itself is complete.
//
// A platform that cannot account a process domain refuses an execution with
// declared limits instead of running it uncapped (fail closed), and
// accounting that breaks down mid-run terminates the execution rather than
// silently losing enforcement. The same rule applies to the macOS fork
// watcher: if it cannot be created or armed, the execution is refused; if it
// degrades mid-run, the execution is stopped. The environment identity
// reports which enforcement applied.
const (
	// EnforcementNone is recorded when no resource cap is declared.
	EnforcementNone = "none"
	// EnforcementSupervisor labels kill-on-breach enforcement of the
	// declared caps.
	EnforcementSupervisor = "supervisor_kill"
	// EnforcementSupervisorRlimit labels kill-on-breach enforcement plus
	// the kernel's RLIMIT_CPU hard cap (Linux).
	EnforcementSupervisorRlimit = "supervisor_kill+rlimit_cpu"

	// CodeExecutionResourceExceeded records an execution terminated by a
	// resource-limit breach, and the run's transition to stopped.
	CodeExecutionResourceExceeded = "execution_resource_limit_exceeded"
	// CodeExecutionUnenforcedLimit records an execution terminated because
	// enforcement itself broke down mid-run: the caps could no longer be
	// measured, so the execution stopped instead of running uncapped.
	CodeExecutionUnenforcedLimit = "execution_limit_unenforceable"
	// CodeExecutionDescendantsSurvived records an execution whose
	// surviving descendants could not all be terminated when it ended.
	CodeExecutionDescendantsSurvived = "execution_descendants_survived"
	// CodeExecutionSupervisionUnavailable records an execution terminated
	// because its lifecycle supervision (the fork watcher) became
	// unavailable mid-run, instead of continuing unsupervised.
	CodeExecutionSupervisionUnavailable = "execution_supervision_unavailable"

	// Breach kinds recorded on the result.
	BreachMemory      = "memory"
	BreachCPU         = "cpu"
	BreachAccounting  = "accounting"
	BreachCleanup     = "cleanup"
	BreachSupervision = "supervision"

	// supervisorInterval is the usage poll period; the enforcement
	// overshoot is bounded by it.
	supervisorInterval = 25 * time.Millisecond

	// maxUsageErrors is how many consecutive accounting failures are
	// tolerated before enforcement gives up and stops the execution.
	maxUsageErrors = 3
)

// drainTimeout bounds how long the end-of-execution sweep waits for the
// domain to die before recording a cleanup failure. A variable so tests can
// shorten it.
var drainTimeout = 5 * time.Second

// resourceLimits are the enforced caps for one execution, derived from the
// capability grant's declared resource limits.
type resourceLimits struct {
	MemoryBytes int64
	CPUSeconds  int64
}

// declared reports whether any cap must be enforced.
func (l resourceLimits) declared() bool {
	return l.MemoryBytes > 0 || l.CPUSeconds > 0
}

// procInfo is one process's identity and accounting snapshot. The start
// time is the process's birth identity: it is compared before any kill so a
// recycled pid is never mistaken for a surviving descendant.
type procInfo struct {
	pid      int
	ppid     int
	pgid     int
	start    int64
	zombie   bool
	resident int64
	cpu      time.Duration
}

// snapshotFunc captures the host's whole process table. It is injectable so
// the enforcement and cleanup behavior is testable without real processes.
type snapshotFunc func() ([]procInfo, error)

// enforcementLabel names the enforcement stack on this platform.
func enforcementLabel() string {
	if kernelLimitsAvailable() {
		return EnforcementSupervisorRlimit
	}
	return EnforcementSupervisor
}

// enforcementFor names the mechanism that enforces the given caps: the
// platform stack when anything is capped, none when nothing is.
func enforcementFor(limits EnforcedLimits) string {
	if limits.MaxMemoryMB <= 0 && limits.MaxCPUSeconds <= 0 {
		return EnforcementNone
	}
	return enforcementLabel()
}

// usageOfDomain sums one execution's supervision domain: the leader's
// process group plus every descendant of the leader. Zombies carry no
// usage.
func usageOfDomain(procs []procInfo, pgid int) (int64, time.Duration) {
	var resident int64
	var cpu time.Duration
	for _, p := range domainProcs(procs, pgid) {
		if p.zombie {
			continue
		}
		resident += p.resident
		cpu += p.cpu
	}
	return resident, cpu
}

// domainProcs filters a process snapshot to the supervision domain of the
// execution leader: the leader itself, its process group, and every
// descendant of the leader, so a child that created its own session is still
// accounted — and, through the sweep, still killed — while it remains
// attached. A child that already detached and was reparented is no longer
// reachable here; the supervisor's tracked set (and the stray sweep) is what
// keeps it discoverable.
func domainProcs(procs []procInfo, pgid int) []procInfo {
	children := map[int][]int{}
	for _, p := range procs {
		children[p.ppid] = append(children[p.ppid], p.pid)
	}
	inDomain := map[int]bool{}
	// The execution leader is always in its own domain, even when it is
	// not its process group's leader.
	inDomain[pgid] = true
	for _, p := range procs {
		if p.pgid == pgid {
			inDomain[p.pid] = true
		}
	}
	var walk func(int)
	walk = func(pid int) {
		for _, child := range children[pid] {
			if !inDomain[child] {
				inDomain[child] = true
				walk(child)
			}
		}
	}
	walk(pgid)
	out := make([]procInfo, 0, len(inDomain))
	for _, p := range procs {
		if inDomain[p.pid] {
			out = append(out, p)
		}
	}
	return out
}

// killDomain SIGKILLs every process in the execution domain of pgid.
func killDomain(pgid int) {
	procs, err := platformProcs()
	if err != nil {
		// Nothing to enumerate; the caller's group kill still applies.
		return
	}
	for _, p := range domainProcs(procs, pgid) {
		killProc(p.pid)
	}
}

// limitSupervisor enforces resource caps and owns the process lifecycle of
// one execution: it polls the domain's usage, kills the domain on breach,
// tracks every member ever observed, and when the execution ends sweeps
// until nothing of it is still alive.
type limitSupervisor struct {
	pgid     int
	limits   resourceLimits
	interval time.Duration
	snapshot snapshotFunc
	kill     func()
	// stray reports whether one process belongs to this execution even
	// outside the supervision domain: a daemonized child whose ancestry is
	// gone. Consulted during the final sweep. May be nil.
	stray func(p procInfo) bool

	mu       sync.Mutex
	breach   string
	tracked  map[int]int64
	draining bool
	straysOK bool

	nudge    chan struct{}
	done     chan struct{}
	drained  chan struct{}
	doneOnce sync.Once
	// drainedOnce guards closing drained: the channel means "the sweep has
	// verified the domain is empty".
	drainedOnce sync.Once
}

// newLimitSupervisor builds a supervisor for one execution. Declared limits
// without a process snapshot are a fail-closed error, never a silent no-op;
// with no declared limits and no snapshot there is nothing to enforce or
// clean up, and the supervisor is absent.
func newLimitSupervisor(pgid int, limits resourceLimits, interval time.Duration, snapshot snapshotFunc, kill func()) (*limitSupervisor, error) {
	if snapshot == nil {
		if limits.declared() {
			return nil, fmt.Errorf("%w: no resource accounting on this platform for the declared limits", ErrIsolationUnavailable)
		}
		return nil, nil
	}
	if interval <= 0 {
		interval = supervisorInterval
	}
	return &limitSupervisor{
		pgid:     pgid,
		limits:   limits,
		interval: interval,
		snapshot: snapshot,
		kill:     kill,
		tracked:  map[int]int64{},
		nudge:    make(chan struct{}, 1),
		done:     make(chan struct{}),
		drained:  make(chan struct{}),
	}, nil
}

// start begins polling in the background.
func (s *limitSupervisor) start() {
	go s.loop()
}

// poke asks for an immediate tick (e.g. from a fork notification).
func (s *limitSupervisor) poke() {
	select {
	case s.nudge <- struct{}{}:
	default:
	}
}

// loop polls until stopped, enforcing caps and keeping the tracked set
// current; in drain mode it also sweeps until the domain is empty.
func (s *limitSupervisor) loop() {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	usageErrors := 0
	for {
		select {
		case <-s.done:
			return
		case <-s.nudge:
		case <-ticker.C:
		}
		procs, err := s.snapshot()
		if err != nil {
			// Accounting that keeps failing makes the caps
			// unenforceable: stop the execution instead of letting it
			// run uncapped.
			usageErrors++
			if usageErrors >= maxUsageErrors {
				s.trigger(BreachAccounting)
			}
			continue
		}
		usageErrors = 0
		s.track(procs)
		if s.limits.declared() {
			resident, cpu := usageOfDomain(procs, s.pgid)
			switch {
			case s.limits.MemoryBytes > 0 && resident > s.limits.MemoryBytes:
				s.trigger(BreachMemory)
			case s.limits.CPUSeconds > 0 && cpu > time.Duration(s.limits.CPUSeconds)*time.Second:
				s.trigger(BreachCPU)
			}
		}
		if s.isDraining() {
			s.sweep(procs)
			if !s.alive(procs) {
				s.drainedOnce.Do(func() { close(s.drained) })
				return
			}
		}
	}
}

// track records every domain member as part of this execution, keyed by pid
// and start-time identity.
func (s *limitSupervisor) track(procs []procInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range domainProcs(procs, s.pgid) {
		if !p.zombie {
			s.tracked[p.pid] = p.start
		}
	}
}

// trackedPids lists the pids the supervisor currently considers part of the
// execution, for platforms that want fork notifications per process.
func (s *limitSupervisor) trackedPids() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int, 0, len(s.tracked))
	for pid := range s.tracked {
		out = append(out, pid)
	}
	return out
}

// sweep kills every process still belonging to the execution: live domain
// members, tracked pids whose identity still matches, and — once — the
// strays the domain view can no longer attribute (a daemonized child that
// left the group and was reparented before any observation). Later sweeps
// handle those through the tracked set.
func (s *limitSupervisor) sweep(procs []procInfo) {
	for _, p := range domainProcs(procs, s.pgid) {
		if !p.zombie {
			killProc(p.pid)
		}
	}
	s.mu.Lock()
	tracked := make(map[int]int64, len(s.tracked))
	for pid, start := range s.tracked {
		tracked[pid] = start
	}
	stray := s.stray
	straysOK := s.straysOK
	if stray != nil {
		s.straysOK = true
	}
	s.mu.Unlock()
	for pid, start := range tracked {
		p, ok := findProc(procs, pid)
		if !ok || p.zombie || p.start != start {
			continue
		}
		killProc(pid)
	}
	if stray != nil && !straysOK {
		for _, p := range procs {
			if p.zombie {
				continue
			}
			if _, seen := tracked[p.pid]; seen {
				continue
			}
			if stray(p) {
				s.mu.Lock()
				s.tracked[p.pid] = p.start
				s.mu.Unlock()
				killProc(p.pid)
			}
		}
	}
}

// alive reports whether anything of the execution is still running.
func (s *limitSupervisor) alive(procs []procInfo) bool {
	for _, p := range domainProcs(procs, s.pgid) {
		if !p.zombie {
			return true
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for pid, start := range s.tracked {
		if p, ok := findProc(procs, pid); ok && !p.zombie && p.start == start {
			return true
		}
	}
	return false
}

// findProc looks one pid up in a snapshot.
func findProc(procs []procInfo, pid int) (procInfo, bool) {
	for _, p := range procs {
		if p.pid == pid {
			return p, true
		}
	}
	return procInfo{}, false
}

// trigger records the breach and removes the execution: the injected kill
// (process group and descendants) plus the tracked sweep (session escapees).
// Only the first breach is recorded and only it kills.
func (s *limitSupervisor) trigger(kind string) {
	s.mu.Lock()
	if s.breach != "" {
		s.mu.Unlock()
		return
	}
	s.breach = kind
	s.mu.Unlock()
	if s.kill != nil {
		s.kill()
	}
	if procs, err := s.snapshot(); err == nil {
		s.sweep(procs)
	}
}

// finish ends the execution's supervised lifetime: it removes every
// surviving member and keeps enforcing the caps until nothing of the
// execution is still alive. The returned breach kind, if any, is what the
// run must record: a resource breach, or "cleanup" when descendants
// survived every termination attempt.
func (s *limitSupervisor) finish() string {
	s.mu.Lock()
	s.draining = true
	s.mu.Unlock()
	s.poke()
	select {
	case <-s.drained:
	case <-time.After(drainTimeout):
		s.mu.Lock()
		if s.breach == "" {
			s.breach = BreachCleanup
		}
		s.mu.Unlock()
	}
	s.stop()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.breach
}

// stop ends polling.
func (s *limitSupervisor) stop() {
	s.doneOnce.Do(func() { close(s.done) })
}

// isDraining reports whether the end-of-execution sweep is running.
func (s *limitSupervisor) isDraining() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.draining
}
