package sandbox

import (
	"context"
	"strings"
	"testing"
)

func TestCommandDependencySourcePinsApprovedEnvAndNeverRunsScripts(t *testing.T) {
	profile, _ := ProfileFor(DefaultExecProfiles(), "node.package")
	t.Setenv("GITHUB_TOKEN", "ghp_host_secret")
	var got struct {
		command string
		argv    []string
		env     []string
		dir     string
	}
	source := CommandDependencySource{
		Run: func(_ context.Context, command string, argv, env []string, dir string) error {
			got.command, got.argv, got.env, got.dir = command, argv, env, dir
			return nil
		},
	}
	layout := DependencyLayout{RepoDir: t.TempDir(), HomeDir: t.TempDir()}
	if err := source.Prime(context.Background(), layout, profile); err != nil {
		t.Fatalf("Prime: %v", err)
	}
	if strings.Contains(strings.Join(got.argv, " "), "rebuild") {
		t.Errorf("fetch argv %v runs install scripts", got.argv)
	}
	if !strings.Contains(strings.Join(got.argv, " "), "--ignore-scripts") {
		t.Errorf("fetch argv %v must suppress install scripts", got.argv)
	}
	joined := strings.Join(got.env, "\n")
	if !strings.Contains(joined, "npm_config_registry=https://registry.npmjs.org/") {
		t.Errorf("fetch env must pin the approved registry:\n%s", joined)
	}
	// The environment is allowlist-built: a host credential on the parent
	// process can never reach the fetch.
	if strings.Contains(joined, "ghp_host_secret") || strings.Contains(joined, "GITHUB_TOKEN") {
		t.Errorf("fetch env leaked host credentials:\n%s", joined)
	}
	if got.dir != layout.RepoDir {
		t.Errorf("fetch dir = %q, want %q", got.dir, layout.RepoDir)
	}
}

func TestCommandDependencySourceRejectsNonDependencyProfiles(t *testing.T) {
	profile, _ := ProfileFor(DefaultExecProfiles(), "go.test")
	source := CommandDependencySource{
		Run: func(context.Context, string, []string, []string, string) error {
			t.Error("fetch must not run for a test profile")
			return nil
		},
	}
	err := source.Prime(context.Background(), DependencyLayout{RepoDir: t.TempDir(), HomeDir: t.TempDir()}, profile)
	if err == nil {
		t.Fatal("Prime with a test profile: want error, got nil")
	}
}

func TestStaticDependencySourceStandsInForAPrimedWorkspace(t *testing.T) {
	var seen string
	source := StaticDependencySource{
		Primed: func(_ DependencyLayout, profile ExecProfile) error {
			seen = profile.ID
			return nil
		},
	}
	profile, _ := ProfileFor(DefaultExecProfiles(), "go.mod")
	if err := source.Prime(context.Background(), DependencyLayout{RepoDir: t.TempDir(), HomeDir: t.TempDir()}, profile); err != nil {
		t.Fatalf("Prime: %v", err)
	}
	if seen != "go.mod" {
		t.Errorf("primed profile = %q, want go.mod", seen)
	}
}
