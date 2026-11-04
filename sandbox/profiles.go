package sandbox

import (
	"errors"
	"fmt"
	"path"
	"slices"
	"strings"
)

// ProfileKind separates the registered execution profiles: untrusted test
// commands and dependency installation.
type ProfileKind int

const (
	// ProfileTest is a registered test command profile.
	ProfileTest ProfileKind = iota
	// ProfileDependency is a registered dependency preparation profile.
	ProfileDependency
)

// ExecProfile is one registered execution profile: the only shape in which a
// test command or dependency installation can run. The command itself is
// never caller-supplied — a request picks a registered profile id, mode, and
// target, and the profile builds the argv, so no call can name a binary,
// smuggle arguments, or widen the mode beyond the registered vocabulary.
type ExecProfile struct {
	// ID is the registered profile identity ("go.test", "node.test",
	// "go.mod", "node.package").
	ID string
	// Kind selects test vs dependency preparation semantics.
	Kind ProfileKind
	// Command is the toolchain binary, resolved only on the sandbox PATH.
	Command string
	// Modes is the closed mode vocabulary; empty means the profile takes
	// no mode. Unknown modes are refused.
	Modes []string
	// MaxWallClockSeconds and OutputLimitBytes are the profile's resource
	// limits; the enforced wall clock is the minimum of this and the grant.
	MaxWallClockSeconds int
	OutputLimitBytes    int64
	// Build returns the argv for the isolated phase. The target is already
	// validated as a clean repository-relative path.
	Build func(mode, target string) ([]string, error)
	// FetchArgv and FetchEnv describe the approved-dependency-access fetch
	// a trusted broker runs before the isolated phase: dependency profiles
	// only, pinned to approved registries, and never executing install
	// scripts (the isolated phase runs those).
	FetchArgv []string
	FetchEnv  map[string]string
}

// DefaultExecProfiles is the registered execution surface. Registration is
// the only way a command becomes runnable; raw shell, arbitrary argv, and
// unregistered commands are absent by construction.
func DefaultExecProfiles() []ExecProfile {
	return []ExecProfile{
		{
			ID:                  "go.test",
			Kind:                ProfileTest,
			Command:             "go",
			Modes:               []string{"focused", "suite"},
			MaxWallClockSeconds: 900,
			OutputLimitBytes:    4 << 20,
			Build:               goTestArgv,
		},
		{
			ID:                  "node.test",
			Kind:                ProfileTest,
			Command:             "npm",
			Modes:               []string{"focused", "suite"},
			MaxWallClockSeconds: 900,
			OutputLimitBytes:    4 << 20,
			Build:               nodeTestArgv,
		},
		{
			ID:                  "go.mod",
			Kind:                ProfileDependency,
			Command:             "go",
			MaxWallClockSeconds: 600,
			OutputLimitBytes:    2 << 20,
			Build:               goDepArgv,
			FetchArgv:           []string{"mod", "download"},
			FetchEnv: map[string]string{
				"GOPROXY": "https://proxy.golang.org,direct",
				"GOSUMDB": "sum.golang.org",
			},
		},
		{
			ID:                  "node.package",
			Kind:                ProfileDependency,
			Command:             "npm",
			MaxWallClockSeconds: 600,
			OutputLimitBytes:    2 << 20,
			Build:               nodeDepArgv,
			FetchArgv:           []string{"ci", "--ignore-scripts", "--no-audit", "--no-fund"},
			FetchEnv: map[string]string{
				"npm_config_registry": "https://registry.npmjs.org/",
			},
		},
	}
}

// scopeDir returns the repository directory one focused target executes in:
// a file target runs its containing directory's package, a directory target
// runs itself.
func scopeDir(target string) string {
	if strings.Contains(path.Base(target), ".") {
		return path.Dir(target)
	}
	return target
}

// ExecutionScope reports the repository paths one request executes against
// and whether the execution is repository-wide. Suite runs and dependency
// preparation touch the whole checkout; focused runs are bounded to the
// target and its execution directory. The runner checks this scope against
// the capability grant, so a narrow grant can never run repository-wide work
// and a target outside the grant can never execute.
func (p ExecProfile) ExecutionScope(mode, target string) (paths []string, treeWide bool) {
	if p.Kind == ProfileDependency || mode == "suite" {
		return nil, true
	}
	dir := scopeDir(target)
	if dir == "." || dir == "" {
		return nil, true
	}
	paths = []string{dir}
	if target != dir {
		paths = append(paths, target)
	}
	return paths, false
}

// ProfileFor looks up one registered profile. The vocabulary is closed:
// anything not registered is not runnable.
func ProfileFor(profiles []ExecProfile, id string) (ExecProfile, bool) {
	for _, profile := range profiles {
		if profile.ID == id {
			return profile, true
		}
	}
	return ExecProfile{}, false
}

// Argv validates a request against the profile vocabulary and returns the
// exact argv the isolated phase runs. Over-privileged requests — unknown
// profiles or modes, missing or escaping targets — are refused here, before
// any policy or dispatch work.
func (p ExecProfile) Argv(mode, target string) ([]string, error) {
	if p.ID == "" || p.Build == nil {
		return nil, errors.New("sandbox: execution profile is not registered")
	}
	if len(p.Modes) > 0 {
		if !slices.Contains(p.Modes, mode) {
			return nil, fmt.Errorf("sandbox: profile %q has no mode %q", p.ID, mode)
		}
	} else if mode != "" {
		return nil, fmt.Errorf("sandbox: profile %q takes no mode", p.ID)
	}
	if p.Kind == ProfileTest && mode == "focused" {
		if !cleanTreePath(target) {
			return nil, fmt.Errorf("sandbox: profile %q needs a clean repository-relative target", p.ID)
		}
	}
	return p.Build(mode, target)
}

// goTestArgv builds `go test` argv. Focused runs name the target's package
// directory behind a "./" prefix, so a flag-shaped target can never become
// an option; suite runs the whole module.
func goTestArgv(mode, target string) ([]string, error) {
	switch mode {
	case "suite":
		return []string{"test", "./..."}, nil
	case "focused":
		dir := target
		if strings.HasSuffix(dir, ".go") {
			dir = path.Dir(dir)
		}
		pkg := "./"
		if dir != "." {
			pkg = "./" + dir
		}
		return []string{"test", pkg}, nil
	}
	return nil, fmt.Errorf("sandbox: go.test has no mode %q", mode)
}

// nodeTestArgv builds `npm test` argv. Focused runs pass the target behind
// the "--" separator with the discovery base pinned to the target's
// directory via "--dir", so the filter stays positional data and the run
// cannot pick up matching tests outside its execution scope.
func nodeTestArgv(mode, target string) ([]string, error) {
	switch mode {
	case "suite":
		return []string{"test"}, nil
	case "focused":
		return []string{"test", "--", "--dir", scopeDir(target), target}, nil
	}
	return nil, fmt.Errorf("sandbox: node.test has no mode %q", mode)
}

// goDepArgv is the isolated dependency phase for Go: verify the approved
// module cache against go.sum. Fetching happens in the broker phase
// (FetchArgv), never here.
func goDepArgv(mode, target string) ([]string, error) {
	return []string{"mod", "verify"}, nil
}

// nodeDepArgv is the isolated dependency phase for Node: run the packages'
// install scripts against the already-fetched tree. The scripts run with no
// network and no credentials — the control-plane credential boundary for
// install scripts. Fetching happens in the broker phase (FetchArgv), never
// here.
func nodeDepArgv(mode, target string) ([]string, error) {
	return []string{"rebuild"}, nil
}
