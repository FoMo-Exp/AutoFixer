package sandbox

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The enforcement tests re-execute this test binary under the isolation
// backend as a probe. Probe modes: "read" prints the file at DSH_PROBE_PATH
// and exits 0 when it was readable; "write" writes DSH_PROBE_PATH and exits 0
// when the write landed; "network" connects to DSH_PROBE_ADDR and exits 0
// when the connection was accepted. Under a correct isolation profile every
// probe is refused, so each probe must exit non-zero.
func TestMain(m *testing.M) {
	if mode := os.Getenv("DSH_PROBE_MODE"); mode != "" {
		os.Exit(runIsolationProbe(mode))
	}
	os.Exit(m.Run())
}

func runIsolationProbe(mode string) int {
	switch mode {
	case "read":
		data, err := os.ReadFile(os.Getenv("DSH_PROBE_PATH"))
		if err != nil {
			return 1
		}
		fmt.Print(string(data))
		return 0
	case "write":
		err := os.WriteFile(os.Getenv("DSH_PROBE_PATH"), []byte("written"), 0o644)
		if err != nil {
			return 1
		}
		return 0
	case "network":
		conn, err := net.DialTimeout("tcp", os.Getenv("DSH_PROBE_ADDR"), 2*time.Second)
		if err != nil {
			return 1
		}
		_ = conn.Close()
		return 0
	}
	return 2
}

// probeCmd builds the wrapped probe invocation for one mode.
func probeCmd(t *testing.T, req IsolationRequest, mode string, env map[string]string) (*exec.Cmd, EnvironmentIdentity) {
	t.Helper()
	isolator := NewIsolator()
	if err := isolator.Available(); err != nil {
		t.Skipf("isolation backend unavailable on this host: %v", err)
	}
	cmd := exec.Command(os.Args[0])
	cmd.Dir = req.Dir
	cmd.Env = []string{"DSH_PROBE_MODE=" + mode}
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	identity, err := isolator.Wrap(cmd, req)
	if err != nil {
		t.Fatalf("Wrap: %v", err)
	}
	return cmd, identity
}

func TestIsolationBlocksCredentialReads(t *testing.T) {
	dir, req := newIsolationLayout(t)
	secretDir := filepath.Join(dir, "ctl")
	secret := filepath.Join(secretDir, "boot.token")
	if err := os.WriteFile(secret, []byte("control-plane-token"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}

	cmd, _ := probeCmd(t, req, "read", map[string]string{"DSH_PROBE_PATH": secret})
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("probe read of the control-plane token succeeded under isolation: %q", out)
	}
	if strings.Contains(string(out), "control-plane-token") {
		t.Fatalf("probe leaked the control-plane token: %q", out)
	}

	// The same probe outside isolation proves the fixture is readable, so
	// the block above is the isolation and not a broken probe.
	plain := exec.Command(os.Args[0])
	plain.Env = []string{"DSH_PROBE_MODE=read", "DSH_PROBE_PATH=" + secret}
	if out, err := plain.CombinedOutput(); err != nil {
		t.Fatalf("unisolated probe should read the fixture: %v (%s)", err, out)
	}
}

func TestIsolationBlocksWritesOutsideWorkspace(t *testing.T) {
	dir, req := newIsolationLayout(t)
	outside := filepath.Join(dir, "outside.txt")

	cmd, _ := probeCmd(t, req, "write", map[string]string{"DSH_PROBE_PATH": outside})
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("probe write outside the workspace succeeded under isolation: %q", out)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("outside file exists after isolated write probe: %v", err)
	}

	inside := filepath.Join(dir, "tmp", "inside.txt")
	cmd, _ = probeCmd(t, req, "write", map[string]string{"DSH_PROBE_PATH": inside})
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("probe write inside the workspace failed under isolation: %v (%s)", err, out)
	}
}

func TestIsolationBlocksUnapprovedNetwork(t *testing.T) {
	_, req := newIsolationLayout(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = listener.Close() }()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	cmd, _ := probeCmd(t, req, "network", map[string]string{"DSH_PROBE_ADDR": listener.Addr().String()})
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("probe connection succeeded under isolation: %q", out)
	}

	// The same probe outside isolation reaches the listener, proving the
	// block is the isolation and not an unreachable fixture.
	plain := exec.Command(os.Args[0])
	plain.Env = []string{"DSH_PROBE_MODE=network", "DSH_PROBE_ADDR=" + listener.Addr().String()}
	if out, err := plain.CombinedOutput(); err != nil {
		t.Fatalf("unisolated probe should connect: %v (%s)", err, out)
	}
}

func TestSeatbeltProfileCarriesEveryDenial(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("seatbelt profile generation is darwin-only")
	}
	dir, req := newIsolationLayout(t)
	profile, err := seatbeltProfile(req)
	if err != nil {
		t.Fatalf("seatbeltProfile: %v", err)
	}
	for _, fragment := range []string{
		"(deny network*)",
		"(deny file-write* (subpath \"/\"))",
		"(deny file-read*",
		"boot.token",
	} {
		if !strings.Contains(profile, fragment) {
			t.Errorf("profile missing %q:\n%s", fragment, profile)
		}
	}
	if !strings.Contains(profile, strconv.Quote(realProfilePath(filepath.Join(dir, "repo")))) {
		t.Errorf("profile missing writable carve-out for the repo:\n%s", profile)
	}
}

func TestBwrapArgvCarriesIsolationFlags(t *testing.T) {
	// The argv is a pure function of the request, so it is checked on every
	// platform even though only linux executes it.
	dir, req := newIsolationLayout(t)
	argv, err := bwrapArgv("/usr/bin/true", []string{"--version"}, req)
	if err != nil {
		t.Fatalf("bwrapArgv: %v", err)
	}
	joined := strings.Join(argv, " ")
	for _, fragment := range []string{
		"--unshare-net",
		"--unshare-pid",
		"--die-with-parent",
		"--ro-bind /usr /usr",
		"--bind " + realProfilePath(filepath.Join(dir, "repo")),
	} {
		if !strings.Contains(joined, fragment) {
			t.Errorf("bwrap argv missing %q:\n%s", fragment, joined)
		}
	}
	if argv[len(argv)-3] != "--" {
		t.Errorf("argv must end with -- <target> <args>, got tail %v", argv[len(argv)-3:])
	}
}
