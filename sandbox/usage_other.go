//go:build !darwin && !linux

package sandbox

import "errors"

// usageAccountingAvailable reports that this platform has no process
// accounting at all: executions with declared resource limits are refused
// rather than run uncapped (fail closed).
func usageAccountingAvailable() bool { return false }

// platformProcs has no enumeration to offer on this platform.
func platformProcs() ([]procInfo, error) {
	return nil, errors.New("sandbox: no process accounting on this platform")
}

// killProc is a no-op: without accounting there is no supervision domain.
func killProc(int) {}
