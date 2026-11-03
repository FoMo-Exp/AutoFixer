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
// A platform that cannot account a process domain refuses an execution with
// declared limits instead of running it uncapped (fail closed), and
// accounting that breaks down mid-run terminates the execution rather than
// silently losing enforcement. The environment identity reports which
// enforcement applied.
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

	// Breach kinds recorded on the result.
	BreachMemory     = "memory"
	BreachCPU        = "cpu"
	BreachAccounting = "accounting"

	// supervisorInterval is the usage poll period; the enforcement
	// overshoot is bounded by it.
	supervisorInterval = 25 * time.Millisecond

	// maxUsageErrors is how many consecutive accounting failures are
	// tolerated before enforcement gives up and stops the execution.
	maxUsageErrors = 3
)

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

// usageFunc reports one execution domain's aggregate resident memory and CPU
// time. It is injectable so the enforcement behavior is testable without a
// real hog process.
type usageFunc func(pgid int) (residentBytes int64, cpuTime time.Duration, err error)

// procInfo is one process's accounting snapshot.
type procInfo struct {
	pid      int
	ppid     int
	pgid     int
	resident int64
	cpu      time.Duration
}

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

// usageOfDomain sums one execution's supervision domain: the leader's process
// group plus every descendant of the leader, so a child that created its own
// session is still accounted — and, through killDomain, still killed.
func usageOfDomain(procs []procInfo, pgid int) (int64, time.Duration) {
	var resident int64
	var cpu time.Duration
	for _, p := range domainProcs(procs, pgid) {
		resident += p.resident
		cpu += p.cpu
	}
	return resident, cpu
}

// domainProcs filters a process snapshot to the supervision domain of the
// execution leader: the leader itself, its process group, and every
// descendant of the leader, so a child that created its own session is still
// accounted — and, through killDomain, still killed.
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

// platformUsage accounts the execution domain of pgid. It is nil where no
// accounting exists, which blocks executions with declared limits.
func platformUsage(pgid int) (int64, time.Duration, error) {
	procs, err := platformProcs()
	if err != nil {
		return 0, 0, err
	}
	resident, cpu := usageOfDomain(procs, pgid)
	return resident, cpu, nil
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

// limitSupervisor enforces resource caps on one running execution by polling
// its domain's usage and killing the domain on breach.
type limitSupervisor struct {
	pgid     int
	limits   resourceLimits
	interval time.Duration
	usage    usageFunc
	kill     func()

	mu       sync.Mutex
	breach   string
	done     chan struct{}
	doneOnce sync.Once
}

// newLimitSupervisor builds a supervisor for a declared limit set. It fails
// closed: declared limits without usage accounting are an error, never a
// silent no-op.
func newLimitSupervisor(pgid int, limits resourceLimits, interval time.Duration, usage usageFunc, kill func()) (*limitSupervisor, error) {
	if !limits.declared() {
		return nil, nil
	}
	if usage == nil {
		return nil, fmt.Errorf("%w: no resource accounting on this platform for the declared limits", ErrIsolationUnavailable)
	}
	if interval <= 0 {
		interval = supervisorInterval
	}
	return &limitSupervisor{
		pgid:     pgid,
		limits:   limits,
		interval: interval,
		usage:    usage,
		kill:     kill,
		done:     make(chan struct{}),
	}, nil
}

// start begins polling in the background.
func (s *limitSupervisor) start() {
	go s.loop()
}

// loop polls until a breach or stop.
func (s *limitSupervisor) loop() {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	usageErrors := 0
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			resident, cpu, err := s.usage(s.pgid)
			if err != nil {
				// Accounting that keeps failing makes the caps
				// unenforceable: stop the execution instead of letting it
				// run uncapped.
				usageErrors++
				if usageErrors >= maxUsageErrors {
					s.trigger(BreachAccounting)
					return
				}
				continue
			}
			usageErrors = 0
			switch {
			case s.limits.MemoryBytes > 0 && resident > s.limits.MemoryBytes:
				s.trigger(BreachMemory)
			case s.limits.CPUSeconds > 0 && cpu > time.Duration(s.limits.CPUSeconds)*time.Second:
				s.trigger(BreachCPU)
			default:
				continue
			}
			return
		}
	}
}

// trigger records the breach and kills the execution domain.
func (s *limitSupervisor) trigger(kind string) {
	s.mu.Lock()
	if s.breach == "" {
		s.breach = kind
	}
	s.mu.Unlock()
	s.kill()
}

// stop ends polling and reports the breach kind, if any.
func (s *limitSupervisor) stop() string {
	s.doneOnce.Do(func() { close(s.done) })
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.breach
}
