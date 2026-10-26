//go:build windows

package dsh

import (
	"fmt"
	"os"
	"path/filepath"
)

// defaultRuntimeDir is a per-user directory under the system temp dir, so
// the pipe token never sits in a shared fixed path.
func defaultRuntimeDir() string {
	return filepath.Join(os.TempDir(), "dsh")
}

// openExclusive creates path atomically, failing if anything already exists
// there. Windows named-pipe mode has no O_NOFOLLOW equivalent; the runtime
// directory check plus O_EXCL carries the same guarantee.
func openExclusive(path string, perm os.FileMode) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
}

// openOwned reopens a token file left by a previous run of ours. The path may
// already exist, but only a regular file is accepted.
func openOwned(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0o600)
}

func secureDirError(path, reason string) error {
	return fmt.Errorf("dsh: runtime directory %q is not a private directory owned by this user (%s)", path, reason)
}

// verifySecureDir refuses a runtime directory that is not a plain directory,
// shrinking an overly open directory to 0700 on the way. Windows has no unix
// ownership bits to compare, so existence and type are the checks.
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
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		if err := os.Chmod(path, 0o700); err != nil {
			return fmt.Errorf("dsh: restrict runtime directory permissions: %w", err)
		}
	}
	return nil
}

// verifyOwnedFile checks an already-opened token file is a regular file.
func verifyOwnedFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("dsh: inspect token file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("dsh: token path is not a regular file")
	}
	return nil
}
