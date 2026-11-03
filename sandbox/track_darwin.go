//go:build darwin

package sandbox

import (
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// startForkWatch arms fork and exit notifications for the execution leader
// and every descendant discovered later, so a child is never born unseen:
// each fork pokes the supervisor into an immediate accounting tick that
// records the newborn before it can detach from the domain. macOS delivers
// no child pid in the event (kqueue data is 0), so discovery is the tick's
// job; the notification only makes it immediate.
//
// The returned stop function waits for the watcher to exit.
func startForkWatch(leader int, pids func() []int, poke func()) (stop func()) {
	kq, err := unix.Kqueue()
	if err != nil {
		return func() {}
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	watched := map[int]bool{}
	watch := func(pid int) {
		if pid <= 0 || watched[pid] {
			return
		}
		watched[pid] = true
		ev := unix.Kevent_t{
			Ident:  uint64(pid),
			Filter: unix.EVFILT_PROC,
			Flags:  unix.EV_ADD,
			Fflags: unix.NOTE_FORK | unix.NOTE_EXIT,
		}
		_, _ = unix.Kevent(kq, []unix.Kevent_t{ev}, nil, nil)
	}
	watch(leader)
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
			n, err := unix.Kevent(kq, nil, events, timeout)
			if err != nil {
				if err == unix.EINTR {
					continue
				}
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
					watch(pid)
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(done) })
		<-finished
	}
}
