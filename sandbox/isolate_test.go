package sandbox

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// isolationRequest builds a request rooted in dir with the standard
// workspace-relative writable set.
func isolationRequest(dir string) IsolationRequest {
	return IsolationRequest{
		Dir:        filepath.Join(dir, "repo"),
		ControlDir: filepath.Join(dir, "ctl"),
		Writable: []string{
			filepath.Join(dir, "repo"),
			filepath.Join(dir, "tmp"),
			filepath.Join(dir, "home"),
		},
		DenyRead:            []string{filepath.Join(dir, "ctl", "boot.token")},
		Network:             NetworkPolicy{DenyAll: true},
		Limits:              EnforcedLimits{MaxMemoryMB: 512, MaxCPUSeconds: 60},
		MaxWallClockSeconds: 60,
		OutputLimitBytes:    1 << 20,
	}
}

func newIsolationLayout(t *testing.T) (string, IsolationRequest) {
	t.Helper()
	dir := t.TempDir()
	for _, sub := range []string{"repo", "tmp", "home", "ctl"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
	}
	return dir, isolationRequest(dir)
}

func TestIsolatorWrapRefusesApprovedDestinations(t *testing.T) {
	_, req := newIsolationLayout(t)
	req.Network = NetworkPolicy{Destinations: []string{"proxy.golang.org:443"}}
	isolator := NewIsolator()
	cmd := exec.Command("/usr/bin/true")
	_, err := isolator.Wrap(cmd, req)
	if !errors.Is(err, ErrIsolationUnavailable) {
		t.Errorf("Wrap with approved destinations: error = %v, want ErrIsolationUnavailable", err)
	}
}

func TestIsolatorWrapRefusesEmptyWorkspace(t *testing.T) {
	_, req := newIsolationLayout(t)
	req.Writable = nil
	isolator := NewIsolator()
	_, err := isolator.Wrap(exec.Command("/usr/bin/true"), req)
	if err == nil {
		t.Fatal("Wrap without writable paths: want error, got nil")
	}
}

func TestEnvironmentIdentityBindsProfileAndRevision(t *testing.T) {
	dir, req := newIsolationLayout(t)
	isolator := NewIsolator()
	if err := isolator.Available(); err != nil {
		t.Skipf("isolation backend unavailable on this host: %v", err)
	}
	cmd := exec.Command("/usr/bin/true")
	cmd.Dir = req.Dir
	identity, err := isolator.Wrap(cmd, req)
	if err != nil {
		t.Fatalf("Wrap: %v", err)
	}
	if identity.Backend == "" {
		t.Error("Backend is empty")
	}
	if identity.Platform != runtime.GOOS+"/"+runtime.GOARCH {
		t.Errorf("Platform = %q, want %q", identity.Platform, runtime.GOOS+"/"+runtime.GOARCH)
	}
	if !strings.HasPrefix(identity.ProfileDigest, "sha256:") {
		t.Errorf("ProfileDigest = %q, want sha256: prefix", identity.ProfileDigest)
	}
	if identity.Network != "denied" {
		t.Errorf("Network = %q, want denied", identity.Network)
	}
	if len(identity.Writable) == 0 || filepath.IsAbs(identity.Writable[0]) {
		t.Errorf("Writable = %v, want workspace-relative roles", identity.Writable)
	}
	if identity.EnforcedLimits.MaxMemoryMB != 512 {
		t.Errorf("EnforcedLimits = %+v, want the granted limits", identity.EnforcedLimits)
	}
	if identity.EnforcedLimits.Enforcement == "" || identity.EnforcedLimits.Enforcement == EnforcementNone {
		t.Errorf("EnforcedLimits.Enforcement = %q, want the platform's enforcement label", identity.EnforcedLimits.Enforcement)
	}

	// The same request must derive the same profile identity, and a change
	// to the isolation scope must change it: results cannot borrow an
	// environment identity from a different scope.
	again, err := isolator.Wrap(exec.Command("/usr/bin/true"), req)
	if err != nil {
		t.Fatalf("Wrap again: %v", err)
	}
	if again.ProfileDigest != identity.ProfileDigest {
		t.Errorf("ProfileDigest unstable: %q vs %q", again.ProfileDigest, identity.ProfileDigest)
	}
	changed := req
	changed.Writable = []string{filepath.Join(dir, "repo")}
	third, err := isolator.Wrap(exec.Command("/usr/bin/true"), changed)
	if err != nil {
		t.Fatalf("Wrap changed: %v", err)
	}
	if third.ProfileDigest == identity.ProfileDigest {
		t.Error("ProfileDigest unchanged after isolation scope change")
	}
}
