package sandbox

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
)

// DependencyLayout names the workspace areas dependency preparation works
// in: the materialized checkout and the credential-free toolchain home.
type DependencyLayout struct {
	RepoDir string
	HomeDir string
}

// DependencySource primes one dependency profile's cache from approved
// registries — the approved dependency access point. It runs trusted fetch
// tooling only (never install scripts) in a credential-free environment;
// the untrusted install phase runs separately under OS-level isolation.
type DependencySource interface {
	// Prime prepares the dependency cache for the revision in layout.
	Prime(ctx context.Context, layout DependencyLayout, profile ExecProfile) error
}

// StaticDependencySource primes nothing and optionally reports the request.
// Tests use it to stand in for a primed workspace.
type StaticDependencySource struct {
	// Primed, when set, observes each prime request.
	Primed func(layout DependencyLayout, profile ExecProfile) error
}

// Prime implements DependencySource.
func (s StaticDependencySource) Prime(_ context.Context, layout DependencyLayout, profile ExecProfile) error {
	if s.Primed == nil {
		return nil
	}
	return s.Primed(layout, profile)
}

// CommandDependencySource runs the profile's registered fetch argv with the
// pinned registry environment. The child sees no host credentials — the
// environment is built from an explicit allowlist plus the profile's pinned
// registry settings — and the fetch argv never contains install scripts.
type CommandDependencySource struct {
	// Run executes one fetch; nil uses a real child process. Tests inject
	// a recorder.
	Run func(ctx context.Context, command string, argv, env []string, dir string) error
}

// Prime implements DependencySource.
func (s CommandDependencySource) Prime(ctx context.Context, layout DependencyLayout, profile ExecProfile) error {
	if profile.Kind != ProfileDependency {
		return fmt.Errorf("sandbox: profile %q is not a dependency profile", profile.ID)
	}
	if len(profile.FetchArgv) == 0 {
		return fmt.Errorf("sandbox: dependency profile %q has no fetch argv", profile.ID)
	}
	if err := validateDependencyLayout(layout); err != nil {
		return err
	}
	env := fetchEnv(layout, profile)
	run := s.Run
	if run == nil {
		run = func(ctx context.Context, command string, argv, env []string, dir string) error {
			resolved, err := resolveTool(command, toolPath())
			if err != nil {
				return fmt.Errorf("sandbox: resolve dependency fetch command: %w", err)
			}
			cmd := exec.CommandContext(ctx, resolved, argv...)
			cmd.Dir = dir
			cmd.Env = env
			configureProcess(cmd)
			out := &cappedBuffer{limit: defaultOutputLimit}
			cmd.Stdout = out
			cmd.Stderr = out
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("sandbox: dependency fetch %q: %w: %s", profile.ID, err, truncateOutput([]byte(out.buf.String())))
			}
			return nil
		}
	}
	if err := run(ctx, profile.Command, profile.FetchArgv, env, layout.RepoDir); err != nil {
		return fmt.Errorf("sandbox: prime dependencies with profile %q: %w", profile.ID, err)
	}
	return nil
}

// fetchEnv builds the credential-free fetch environment: the same explicit
// allowlist the sandbox children get, plus the profile's pinned approved
// registry settings. Nothing from the host environment is inherited.
func fetchEnv(layout DependencyLayout, profile ExecProfile) []string {
	env := []string{
		"PATH=" + toolPath(),
		"HOME=" + layout.HomeDir,
		"GIT_TERMINAL_PROMPT=0",
		"LANG=C",
	}
	keys := make([]string, 0, len(profile.FetchEnv))
	for key := range profile.FetchEnv {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env = append(env, key+"="+profile.FetchEnv[key])
	}
	return env
}

// validateDependencyLayout checks the layout a prime needs.
func validateDependencyLayout(layout DependencyLayout) error {
	if layout.RepoDir == "" || layout.HomeDir == "" {
		return errors.New("sandbox: dependency layout requires repo and home directories")
	}
	if _, err := os.Stat(layout.RepoDir); err != nil {
		return fmt.Errorf("sandbox: dependency layout repo dir: %w", err)
	}
	return nil
}
