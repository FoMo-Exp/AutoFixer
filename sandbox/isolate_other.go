//go:build !darwin && !linux

package sandbox

import (
	"fmt"
	"os/exec"
	"runtime"
)

// unavailableIsolator refuses every untrusted execution on platforms without
// a supported OS-level isolation mechanism. Blocking is the point: an
// unisolated test run would reach host credentials and unapproved networks.
type unavailableIsolator struct{}

func platformIsolator() Isolator { return unavailableIsolator{} }

func (unavailableIsolator) Name() string { return "unavailable" }

// ExecutionDomain reports that no backend exists here: there is no domain to
// guarantee, and untrusted execution is refused.
func (unavailableIsolator) ExecutionDomain() ExecutionDomain { return DomainBestEffort }

func (unavailableIsolator) Available() error {
	return fmt.Errorf("%w: no OS-level isolation backend for %s", ErrIsolationUnavailable, runtime.GOOS)
}

func (unavailableIsolator) Wrap(cmd *exec.Cmd, req IsolationRequest) (EnvironmentIdentity, error) {
	if err := validateIsolationRequest(req); err != nil {
		return EnvironmentIdentity{}, err
	}
	return EnvironmentIdentity{}, fmt.Errorf("%w: no OS-level isolation backend for %s", ErrIsolationUnavailable, runtime.GOOS)
}
