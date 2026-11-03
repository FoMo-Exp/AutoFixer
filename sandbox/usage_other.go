//go:build !darwin && !linux

package sandbox

import "errors"

// platformSnapshot stays nil: this platform has no process accounting at
// all, and executions with declared resource limits are refused rather than
// run uncapped (fail closed).
var platformSnapshot snapshotFunc

// usageAccountingAvailable reports that no accounting exists here.
func usageAccountingAvailable() bool { return false }

// platformProcs has no enumeration to offer on this platform.
func platformProcs() ([]procInfo, error) {
	return nil, errors.New("sandbox: no process accounting on this platform")
}

// processCwd has no fingerprint to offer on this platform.
func processCwd(pid int) (string, bool) { return "", false }

// killProc is a no-op: without accounting there is no supervision domain.
// It is a variable so tests can record kills instead of signaling real
// processes.
var killProc = func(int) {}
