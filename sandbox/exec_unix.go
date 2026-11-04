//go:build unix

package sandbox

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

// toolPath is the fixed child PATH: only well-known system directories, so
// a permitted tool resolves the same on every host and no user-writable
// directory can shadow a permitted binary.
func toolPath() string {
	return "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

// configureProcess isolates process lifetime: the child starts in its own
// process group, and context completion (wall-clock timeout or caller
// cancellation) kills that whole group, taking the tool's descendants with
// it. WaitDelay bounds how long surviving processes can hold the output
// pipes open after that kill.
func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil // the group is already gone
		}
		return err
	}
	cmd.WaitDelay = 2 * time.Second
}

// signalBreach classifies a termination by the kernel's CPU cap signal
// (SIGXCPU, from the pinned RLIMIT_CPU) as a CPU resource breach. It closes
// the window between supervisor samples: whichever enforcement kills first,
// the violation is still evidenced.
func signalBreach(cmd *exec.Cmd) string {
	if cmd.ProcessState == nil {
		return ""
	}
	status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus)
	if ok && status.Signaled() && status.Signal() == syscall.SIGXCPU {
		return BreachCPU
	}
	return ""
}
