package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// builtInCredentialPaths are host credential locations denied to every
// untrusted execution, on top of the request's control-plane denials.
func builtInCredentialPaths() []string {
	var paths []string
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		for _, sub := range []string{
			".ssh", ".aws", ".gnupg", ".docker", ".kube", ".azure",
			".config/gcloud", ".config/gh", ".config/hub",
		} {
			paths = append(paths, filepath.Join(home, sub))
		}
		for _, file := range []string{".netrc", ".npmrc", ".pypirc", ".git-credentials", ".gitconfig"} {
			paths = append(paths, filepath.Join(home, file))
		}
	}
	return append(paths, "/etc/ssh", "/etc/kerberos")
}

// This file holds the pure isolation-profile builders. They compile on every
// platform so the generated profiles and argv are unit-tested everywhere,
// while only the platform files turn them into an executed command.

// realProfilePath resolves one profile path the way the kernel will see it.
// Seatbelt and mount rules match real paths, so an alias like macOS's /var →
// /private/var must be resolved before it is written into a profile — the
// same containment reasoning the tree gate applies.
func realProfilePath(path string) string {
	real, err := filepath.EvalSymlinks(path)
	if err == nil {
		return real
	}
	// Not-yet-existing paths resolve through their deepest existing parent.
	parent := filepath.Dir(path)
	if parent != path {
		if realParent, err := filepath.EvalSymlinks(parent); err == nil {
			return filepath.Join(realParent, filepath.Base(path))
		}
	}
	return filepath.Clean(path)
}

// seatbeltProfile renders the macOS Seatbelt profile for one isolation
// request. Rule shape (validated against macOS Seatbelt semantics: the most
// specific matching rule wins): an allow-default base, a blanket write deny
// carved back open only for the writable scope and the device nodes every
// runtime needs, a blanket network deny, and read denies for credentials and
// control-plane files.
func seatbeltProfile(req IsolationRequest) (string, error) {
	writable := writableFragments(req)
	if len(writable) == 0 {
		return "", errors.New("sandbox: seatbelt profile requires a writable scope")
	}
	var b strings.Builder
	b.WriteString("(version 1)\n(allow default)\n")

	b.WriteString(`(deny file-write* (subpath "/"))` + "\n")
	b.WriteString("(allow file-write*")
	for _, path := range writable {
		b.WriteString(" (subpath " + seatbeltQuote(realProfilePath(path)) + ")")
	}
	// Device nodes every toolchain writes to that must stay reachable.
	for _, device := range []string{"/dev/null", "/dev/dtracehelper", "/dev/autofs_nowait", "/dev/tty"} {
		b.WriteString(" (literal " + seatbeltQuote(device) + ")")
	}
	b.WriteString(")\n")

	b.WriteString("(deny network*)\n")

	denyRead := append(denyReadFragments(req), builtInCredentialPaths()...)
	if len(denyRead) > 0 {
		b.WriteString("(deny file-read*")
		for _, path := range denyRead {
			b.WriteString(" (subpath " + seatbeltQuote(realProfilePath(path)) + ")")
		}
		b.WriteString(")\n")
	}
	return b.String(), nil
}

// bwrapArgv builds the bubblewrap invocation for one isolation request.
// Deny-read directories are hidden behind empty tmpfs mounts and deny-read
// files behind /dev/null binds, so the paths are unreachable from inside.
func bwrapArgv(target string, args []string, req IsolationRequest) ([]string, error) {
	writable := writableFragments(req)
	if len(writable) == 0 {
		return nil, errors.New("sandbox: bwrap requires a writable scope")
	}
	argv := []string{
		"--die-with-parent",
		"--new-session",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--proc", "/proc",
		"--dev", "/dev",
		"--tmpfs", "/tmp",
		"--ro-bind", "/usr", "/usr",
		"--ro-bind", "/bin", "/bin",
		"--ro-bind", "/sbin", "/sbin",
		"--ro-bind", "/lib", "/lib",
		"--ro-bind", "/lib64", "/lib64",
		"--ro-bind", "/etc", "/etc",
	}
	// Credential and control-plane paths become unreachable: an empty
	// tmpfs for directories, a /dev/null bind for files.
	for _, path := range denyReadFragments(req) {
		real := realProfilePath(path)
		if info, err := os.Stat(real); err == nil && !info.IsDir() {
			argv = append(argv, "--ro-bind", "/dev/null", real)
		} else {
			argv = append(argv, "--tmpfs", real)
		}
	}
	for _, path := range writable {
		real := realProfilePath(path)
		argv = append(argv, "--bind", real, real)
	}
	argv = append(argv, "--chdir", realProfilePath(req.Dir))
	argv = append(argv, "--unshare-net")
	argv = append(argv, "--", target)
	argv = append(argv, args...)
	return argv, nil
}
