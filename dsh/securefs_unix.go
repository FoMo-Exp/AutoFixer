//go:build !windows

package dsh

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// defaultRuntimeDir is a per-user directory under the system temp dir, so
// the socket and token never sit in a shared world-writable path.
func defaultRuntimeDir() string {
	return filepath.Join(os.TempDir(), fmt.Sprintf("dsh-%d", os.Getuid()))
}

// openExclusive creates path atomically, failing if anything already exists
// there and refusing to follow a symlink. It is the only way the boot token
// file is created, so a pre-planted file in a shared directory can neither be
// truncated nor redirect the write.
func openExclusive(path string, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, perm)
}

// openOwned reopens a token file left by a previous run of ours. The path may
// already exist, but only a regular file owned by the current user is
// accepted; symlinks and foreign files are refused.
func openOwned(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_TRUNC|syscall.O_NOFOLLOW, 0o600)
}

// secureDirError explains a refused runtime directory.
func secureDirError(path, reason string) error {
	return fmt.Errorf("dsh: runtime directory %q is not a private directory owned by this user (%s)", path, reason)
}

// verifySecureDir refuses a runtime directory that is not a plain directory
// owned by the current user with no group or other access, shrinking an
// owned-but-wide directory to 0700 on the way.
func verifySecureDir(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("dsh: inspect runtime directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return secureDirError(path, "symlink")
	}
	if !info.IsDir() {
		return secureDirError(path, "not a directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return secureDirError(path, "ownership unavailable")
	}
	if int(stat.Uid) != os.Getuid() {
		return secureDirError(path, "different owner")
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		if err := os.Chmod(path, 0o700); err != nil {
			return fmt.Errorf("dsh: restrict runtime directory permissions: %w", err)
		}
	}
	return nil
}

// verifyOwnedFile checks an already-opened token file: it must be a regular
// file owned by the current user.
func verifyOwnedFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("dsh: inspect token file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("dsh: token path is not a regular file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("dsh: token file ownership unavailable")
	}
	if int(stat.Uid) != os.Getuid() {
		return fmt.Errorf("dsh: token file is not owned by this user")
	}
	return nil
}
