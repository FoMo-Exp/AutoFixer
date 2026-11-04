//go:build darwin

package sandbox

import (
	"errors"
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

// TestStartForkWatchFailsWhenKqueueUnavailable pins the fail-closed path: a
// watcher that cannot be created is an error, never a silent no-op.
func TestStartForkWatchFailsWhenKqueueUnavailable(t *testing.T) {
	old := kqueueCreate
	kqueueCreate = func() (int, error) { return -1, errors.New("kqueue exhausted") }
	t.Cleanup(func() { kqueueCreate = old })

	stop, err := startForkWatch(os.Getpid(), nil, nil, nil)
	if err == nil {
		t.Fatal("startForkWatch succeeded without a kqueue; want an error")
	}
	if stop != nil {
		t.Error("stop = non-nil, want nil on failure")
	}
}

// TestStartForkWatchFailsWhenLeaderCannotBeArmed pins the other fail-closed
// path: the leader registration error must surface, not be dropped.
func TestStartForkWatchFailsWhenLeaderCannotBeArmed(t *testing.T) {
	old := keventCall
	keventCall = func(int, []unix.Kevent_t, []unix.Kevent_t, *unix.Timespec) (int, error) {
		return 0, errors.New("registration refused")
	}
	t.Cleanup(func() { keventCall = old })

	stop, err := startForkWatch(os.Getpid(), nil, nil, nil)
	if err == nil {
		t.Fatal("startForkWatch succeeded without arming the leader; want an error")
	}
	if stop != nil {
		t.Error("stop = non-nil, want nil on failure")
	}
}

// TestStartForkWatchArmsAndStops watches this test process itself: the happy
// path returns a working stop function.
func TestStartForkWatchArmsAndStops(t *testing.T) {
	stop, err := startForkWatch(os.Getpid(), nil, nil, nil)
	if err != nil {
		t.Fatalf("startForkWatch: %v", err)
	}
	stop()
}
