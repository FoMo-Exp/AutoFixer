//go:build linux

package sandbox

import "golang.org/x/sys/unix"

// kernelLimitsAvailable reports that this platform can pin a kernel-hard
// CPU cap on a running execution.
func kernelLimitsAvailable() bool { return true }

// applyKernelLimits pins the granted CPU budget as a kernel-hard RLIMIT_CPU
// on the execution: the kernel terminates a process that exceeds it (SIGXCPU,
// SIGKILL at the hard cap), and every child inherits the cap. The supervisor
// enforces the aggregate domain budget on top of it, and a SIGXCPU death is
// recorded as a CPU breach as well (see signalBreach), so the kernel cap can
// never kill a process without the violation being evidenced.
//
// No memory rlimit is pinned: the rlimits that cap memory (RLIMIT_AS,
// RLIMIT_DATA) bound address space rather than resident memory, and healthy
// toolchains routinely reserve far more address space (V8's reservation
// alone is gigabytes) than they ever occupy. Resident memory is enforced by
// the kill-on-breach supervisor instead.
func applyKernelLimits(pid int, limits resourceLimits) error {
	if limits.CPUSeconds <= 0 {
		return nil
	}
	rl := unix.Rlimit{Cur: uint64(limits.CPUSeconds), Max: uint64(limits.CPUSeconds)}
	return unix.Prlimit(pid, unix.RLIMIT_CPU, &rl, nil)
}
