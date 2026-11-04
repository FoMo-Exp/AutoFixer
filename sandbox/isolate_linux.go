//go:build linux

package sandbox

import (
	"fmt"
	"os/exec"
	"strings"
)

// bwrapIsolator wraps commands in bubblewrap: a PID, IPC, and UTS namespace,
// no network namespace at all, read-only system binds, an explicit writable
// bind set, and credential paths hidden behind empty mounts. The generated
// argv is part of the environment identity.
type bwrapIsolator struct{}

func platformIsolator() Isolator { return bwrapIsolator{} }

func (bwrapIsolator) Name() string { return "bwrap" }

func (bwrapIsolator) Available() error {
	if _, err := exec.LookPath("bwrap"); err != nil {
		return fmt.Errorf("%w: bwrap is not on PATH", ErrIsolationUnavailable)
	}
	return nil
}

// Wrap applies bubblewrap isolation to cmd in place.
func (s bwrapIsolator) Wrap(cmd *exec.Cmd, req IsolationRequest) (EnvironmentIdentity, error) {
	if err := validateIsolationRequest(req); err != nil {
		return EnvironmentIdentity{}, err
	}
	if err := s.Available(); err != nil {
		return EnvironmentIdentity{}, err
	}
	argv, err := bwrapArgv(cmd.Path, cmd.Args[1:], req)
	if err != nil {
		return EnvironmentIdentity{}, err
	}
	digest := profileDigest([]byte(strings.Join(argv, "\x00")))
	bwrapPath, err := exec.LookPath("bwrap")
	if err != nil {
		return EnvironmentIdentity{}, fmt.Errorf("%w: bwrap disappeared", ErrIsolationUnavailable)
	}
	cmd.Path = bwrapPath
	cmd.Args = append([]string{"bwrap"}, argv...)
	return isolationIdentity(s.Name(), digest, req), nil
}
