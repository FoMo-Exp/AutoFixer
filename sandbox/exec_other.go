//go:build !unix

package sandbox

import (
	"os"
	"os/exec"
	"time"
)

// toolPath on non-unix hosts inherits the parent PATH: the fixed system
// directory list is POSIX-only, and PATH carries no credentials.
func toolPath() string {
	return os.Getenv("PATH")
}

// configureProcess without POSIX process groups: CommandContext's default
// cancellation kills the direct child, and WaitDelay bounds how long its
// output pipes can be held open afterwards.
func configureProcess(cmd *exec.Cmd) {
	cmd.WaitDelay = 2 * time.Second
}
