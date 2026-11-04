//go:build !darwin

package sandbox

// startForkWatch has no fork notification mechanism on this platform, and
// needs none: Linux executions run in their own PID namespace (bubblewrap),
// where the kernel removes every remaining process when the namespace dies,
// and other platforms have no process accounting at all, so executions with
// declared limits are refused before they start. The polling supervisor plus
// the final sweep cover the rest.
func startForkWatch(leader int, pids func() []int, poke, fail func()) (func(), error) {
	return func() {}, nil
}
