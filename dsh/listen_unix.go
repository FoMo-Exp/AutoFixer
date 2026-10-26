//go:build !windows

package dsh

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// listen binds a Unix Domain Socket. A stale socket file left by a crashed
// previous run is removed only when nothing is accepting on it, so a live
// server is never unlinked underneath itself.
func listen(network, socketPath string) (net.Listener, error) {
	if network != NetworkUnix {
		return nil, fmt.Errorf("dsh: transport %q is not available on this platform", network)
	}
	if dir := filepath.Dir(socketPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("dsh: create socket directory: %w", err)
		}
	}
	if err := removeStaleSocket(socketPath); err != nil {
		return nil, err
	}
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("dsh: listen on unix socket: %w", err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("dsh: restrict socket permissions: %w", err)
	}
	return ln, nil
}

func removeStaleSocket(socketPath string) error {
	info, err := os.Lstat(socketPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("dsh: inspect socket path: %w", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("dsh: socket path %q exists and is not a socket", socketPath)
	}
	conn, err := net.Dial("unix", socketPath)
	if err == nil {
		_ = conn.Close()
		return fmt.Errorf("dsh: socket %q is already in use", socketPath)
	}
	if err := os.Remove(socketPath); err != nil {
		return fmt.Errorf("dsh: remove stale socket: %w", err)
	}
	return nil
}
