//go:build darwin

package sandbox

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// seatbeltIsolator wraps commands in a macOS Seatbelt profile via
// sandbox-exec(1). The profile starts from allow-default for compatibility
// with real test toolchains and then denies exactly the trust boundaries:
// all network egress, every write outside the workspace scope, and reads of
// credential homes and control-plane files. The profile is generated per
// execution and its digest is part of the environment identity.
type seatbeltIsolator struct{}

func platformIsolator() Isolator { return seatbeltIsolator{} }

func (seatbeltIsolator) Name() string { return "seatbelt" }

func (seatbeltIsolator) Available() error {
	if _, err := exec.LookPath("sandbox-exec"); err != nil {
		return fmt.Errorf("%w: sandbox-exec is not on PATH", ErrIsolationUnavailable)
	}
	return nil
}

// Wrap applies the seatbelt profile to cmd in place.
func (s seatbeltIsolator) Wrap(cmd *exec.Cmd, req IsolationRequest) (EnvironmentIdentity, error) {
	if err := validateIsolationRequest(req); err != nil {
		return EnvironmentIdentity{}, err
	}
	if err := s.Available(); err != nil {
		return EnvironmentIdentity{}, err
	}
	profile, err := seatbeltProfile(req)
	if err != nil {
		return EnvironmentIdentity{}, err
	}
	digest := profileDigest([]byte(profile))
	if err := os.MkdirAll(req.ControlDir, 0o700); err != nil {
		return EnvironmentIdentity{}, fmt.Errorf("sandbox: create isolation control directory: %w", err)
	}
	profilePath := filepath.Join(req.ControlDir, fmt.Sprintf("seatbelt-%s.profile", digest[:16]))
	if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
		return EnvironmentIdentity{}, fmt.Errorf("sandbox: write seatbelt profile: %w", err)
	}

	target := cmd.Path
	cmd.Path = "/usr/bin/sandbox-exec"
	cmd.Args = append([]string{"sandbox-exec", "-f", profilePath, "--", target}, cmd.Args[1:]...)
	return isolationIdentity(s.Name(), digest, req), nil
}
