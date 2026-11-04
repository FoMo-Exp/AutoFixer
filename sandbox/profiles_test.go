package sandbox

import (
	"strings"
	"testing"
)

func defaultProfile(id string) (ExecProfile, bool) {
	for _, profile := range DefaultExecProfiles() {
		if profile.ID == id {
			return profile, true
		}
	}
	return ExecProfile{}, false
}

func TestDefaultProfilesCoverTestAndDependencyKinds(t *testing.T) {
	for _, id := range []string{"go.test", "node.test"} {
		profile, ok := defaultProfile(id)
		if !ok {
			t.Fatalf("profile %q not registered", id)
		}
		if profile.Kind != ProfileTest {
			t.Errorf("profile %q kind = %v, want test", id, profile.Kind)
		}
	}
	for _, id := range []string{"go.mod", "node.package"} {
		profile, ok := defaultProfile(id)
		if !ok {
			t.Fatalf("profile %q not registered", id)
		}
		if profile.Kind != ProfileDependency {
			t.Errorf("profile %q kind = %v, want dependency", id, profile.Kind)
		}
		if profile.MaxWallClockSeconds <= 0 || profile.OutputLimitBytes <= 0 {
			t.Errorf("profile %q missing resource limits: %+v", id, profile)
		}
	}
}

func TestTestArgvBuildsOnlyRegisteredShapes(t *testing.T) {
	profile, _ := defaultProfile("go.test")
	argv, err := profile.Argv("suite", "")
	if err != nil {
		t.Fatalf("Argv(suite): %v", err)
	}
	if strings.Join(argv, " ") != "test ./..." {
		t.Errorf("suite argv = %v, want go test ./...", argv)
	}
	argv, err = profile.Argv("focused", "harness/policy_test.go")
	if err != nil {
		t.Fatalf("Argv(focused): %v", err)
	}
	if strings.Join(argv, " ") != "test ./harness" {
		t.Errorf("focused argv = %v, want go test ./harness", argv)
	}

	node, _ := defaultProfile("node.test")
	argv, err = node.Argv("focused", "web/src/export/export-button.test.ts")
	if err != nil {
		t.Fatalf("node Argv(focused): %v", err)
	}
	if strings.Join(argv, " ") != "test -- --dir web/src/export web/src/export/export-button.test.ts" {
		t.Errorf("node focused argv = %v", argv)
	}
}

func TestTestArgvRejectsOverprivilegedRequests(t *testing.T) {
	profile, _ := defaultProfile("go.test")

	// A request can only pick from the registered profile vocabulary: it
	// can never name a command, smuggle argv, or widen the mode.
	if _, err := profile.Argv("shell", "harness"); err == nil {
		t.Error("unknown mode accepted")
	}
	if _, err := profile.Argv("focused", ""); err == nil {
		t.Error("focused mode without a target accepted")
	}
	for _, target := range []string{"../outside", "harness/../../etc", "/etc/passwd", `win\path`, "a//b/../../c"} {
		if _, err := profile.Argv("focused", target); err == nil {
			t.Errorf("escaping target %q accepted", target)
		}
	}

	// A target can never turn into a command-line flag: go prefixes the
	// package with "./" and npm separates filters with "--", so flag-shaped
	// targets stay positional data.
	argv, err := profile.Argv("focused", "--help")
	if err != nil {
		t.Fatalf("Argv(focused, --help): %v", err)
	}
	if len(argv) != 2 || argv[0] != "test" || !strings.HasPrefix(argv[1], "./") {
		t.Errorf("go argv for flag-shaped target = %v, want [test ./...]", argv)
	}
	node, _ := defaultProfile("node.test")
	argv, err = node.Argv("focused", "--help")
	if err != nil {
		t.Fatalf("node Argv(focused, --help): %v", err)
	}
	if len(argv) < 3 || argv[0] != "test" || argv[1] != "--" || argv[len(argv)-1] != "--help" {
		t.Errorf("node argv for flag-shaped target = %v, want the target kept positional after --", argv)
	}
}

func TestExecutionScopeBoundedToTargetAndDirectory(t *testing.T) {
	goProfile, _ := defaultProfile("go.test")
	scope, treeWide := goProfile.ExecutionScope("focused", "harness/policy_test.go")
	if treeWide || strings.Join(scope, " ") != "harness harness/policy_test.go" {
		t.Errorf("go focused scope = %v treeWide=%v, want the package dir and target", scope, treeWide)
	}
	if _, treeWide = goProfile.ExecutionScope("suite", ""); !treeWide {
		t.Error("suite scope must be repository-wide")
	}
	nodeProfile, _ := defaultProfile("node.test")
	scope, treeWide = nodeProfile.ExecutionScope("focused", "web/src/x.test.ts")
	if treeWide || strings.Join(scope, " ") != "web/src web/src/x.test.ts" {
		t.Errorf("node focused scope = %v treeWide=%v", scope, treeWide)
	}
	depProfile, _ := defaultProfile("go.mod")
	if _, treeWide = depProfile.ExecutionScope("", ""); !treeWide {
		t.Error("dependency preparation scope must be repository-wide")
	}
	// A root-level target executes the root package, which is repository-wide
	// for grant purposes.
	if _, treeWide = goProfile.ExecutionScope("focused", "root_test.go"); !treeWide {
		t.Error("root-level target scope must require a repository-wide grant")
	}
}

func TestDepProfileFetchPinsApprovedRegistriesAndNeverRunsScripts(t *testing.T) {
	npm, _ := defaultProfile("node.package")
	if !strings.Contains(strings.Join(npm.FetchArgv, " "), "--ignore-scripts") {
		t.Errorf("npm fetch argv %v must never run install scripts", npm.FetchArgv)
	}
	if registry := npm.FetchEnv["npm_config_registry"]; !strings.Contains(registry, "registry.npmjs.org") {
		t.Errorf("npm fetch env must pin the approved registry, got %q", registry)
	}
	goMod, _ := defaultProfile("go.mod")
	if proxy := goMod.FetchEnv["GOPROXY"]; !strings.Contains(proxy, "proxy.golang.org") {
		t.Errorf("go fetch env must pin the approved proxy, got %q", proxy)
	}
	// The isolated phase stays offline: no fetch argv leaks into it.
	for _, profile := range []ExecProfile{npm, goMod} {
		argv, err := profile.Argv("", "")
		if err != nil {
			t.Fatalf("dep Argv: %v", err)
		}
		joined := strings.Join(argv, " ")
		if strings.Contains(joined, "download") || strings.Contains(joined, "ci") {
			t.Errorf("isolated dep argv %v must not fetch", argv)
		}
	}
}
