//go:build darwin

package sandbox

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// Package-level indirection so the fail-closed paths are testable: a watcher
// that cannot be created or armed must refuse the execution, never silently
// downgrade lifecycle supervision.
var (
	kqueueCreate = unix.Kqueue
	keventCall   = unix.Kevent
)

// startForkWatch arms fork and exit notifications for the execution leader
// and every descendant discovered later, so a child is more likely to be
// recorded before it can detach: each fork pokes the supervisor into an
// immediate accounting tick. macOS delivers no child pid in the event
// (kqueue data is 0), so discovery is the tick's job; the notification only
// makes it immediate. This is best-effort by construction — a child that
// forks, creates its own session, is reparented, and leaves the workspace
// between two observations cannot be attributed on this platform (DAT-253).
// The runner therefore refuses untrusted execution on the darwin backend
// (DomainBestEffort) rather than claim supervision this watcher cannot
// deliver; the watcher still underpins the supervision tests and any future
// backend that supplies its own kernel-owned domain.
//
// Creating the kqueue and arming the leader are synchronous: a failure means
// the watcher does not exist and the caller must refuse the execution. A
// later registration failure or a lost queue calls fail once and ends the
// watcher, so supervision is never silently degraded mid-run.
//
// The returned stop function waits for the watcher to exit.
func startForkWatch(leader int, pids func() []int, poke, fail func()) (func(), error) {
	kq, err := kqueueCreate()
	if err != nil {
		return nil, fmt.Errorf("sandbox: create fork watcher: %w", err)
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	watched := map[int]bool{}
	// watch registers one pid. The first call (the leader) is synchronous;
	// afterwards only the watcher goroutine calls it.
	watch := func(pid int) error {
		if pid <= 0 || watched[pid] {
			return nil
		}
		watched[pid] = true
		ev := unix.Kevent_t{
			Ident:  uint64(pid),
			Filter: unix.EVFILT_PROC,
			Flags:  unix.EV_ADD,
			Fflags: unix.NOTE_FORK | unix.NOTE_EXIT,
		}
		if _, err := keventCall(kq, []unix.Kevent_t{ev}, nil, nil); err != nil {
			delete(watched, pid)
			return err
		}
		return nil
	}
	if err := watch(leader); err != nil {
		unix.Close(kq)
		return nil, fmt.Errorf("sandbox: arm fork watcher for pid %d: %w", leader, err)
	}
	degrade := func() {
		if fail != nil {
			fail()
		}
	}
	go func() {
		defer close(finished)
		defer unix.Close(kq)
		for {
			select {
			case <-done:
				return
			default:
			}
			events := make([]unix.Kevent_t, 8)
			timeout := &unix.Timespec{Nsec: int64(50 * time.Millisecond / time.Nanosecond)}
			n, err := keventCall(kq, nil, events, timeout)
			if err != nil {
				if err == unix.EINTR {
					continue
				}
				// The queue is gone: fork notifications can no
				// longer be delivered, so the execution is stopped
				// instead of running with degraded supervision.
				degrade()
				return
			}
			for _, e := range events[:n] {
				if e.Fflags&unix.NOTE_FORK != 0 && poke != nil {
					poke()
				}
				if e.Fflags&unix.NOTE_EXIT != 0 {
					delete(watched, int(e.Ident))
				}
			}
			if pids != nil {
				for _, pid := range pids() {
					if err := watch(pid); err != nil {
						if errors.Is(err, unix.ESRCH) {
							// The process already exited:
							// nothing left to watch.
							continue
						}
						degrade()
						return
					}
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(done) })
		<-finished
	}, nil
}
