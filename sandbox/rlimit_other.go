//go:build !linux

package sandbox

// kernelLimitsAvailable reports that this platform has no per-process kernel
// resource caps to pin: the kill-on-breach supervisor is the whole
// enforcement stack here.
func kernelLimitsAvailable() bool { return false }

// applyKernelLimits is a no-op: there is nothing kernel-hard to pin on this
// platform, and the supervisor enforces the declared caps.
func applyKernelLimits(pid int, limits resourceLimits) error { return nil }
