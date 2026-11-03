//go:build !darwin

package sandbox

// startForkWatch has no fork notification mechanism on this platform.
// Linux executions run in their own PID namespace (bubblewrap), where the
// kernel removes every remaining process when the namespace dies, and the
// polling supervisor plus the final sweep cover the rest.
func startForkWatch(leader int, pids func() []int, poke func()) (stop func()) {
	return func() {}
}
