//go:build unix

package sandbox_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// localGitRepo creates one real git repository with a single pinned commit
// and returns its path, its full base SHA, and a README only the base holds.
func localGitRepo(t *testing.T) (dir, baseSHA string) {
	t.Helper()
	dir = t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com"}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "--quiet", "--initial-branch", "main")
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "src", "fix.ts"), []byte("export const value = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "--all")
	git("commit", "--quiet", "-m", "base")
	baseSHA = git("rev-parse", "HEAD")
	return dir, baseSHA
}

// newChangeRunner builds an approved run whose grant may create a patch and
// whose revision source materializes the real local repository.
func newChangeRunner(t *testing.T, repoURL, baseSHA string) *sandbox.Runner {
	t.Helper()
	store := harness.NewEventStore()
	assessment, err := harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID:             "task-change",
		RunID:              "run-change",
		AssessedAt:         time.Now().UTC().Truncate(time.Second),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/task-change",
	}, harness.RiskLow, harness.DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatalf("NewRiskAssessment: %v", err)
	}
	run, err := harness.NewRun(harness.RunConfig{
		TaskID:            "task-change",
		RunID:             "run-change",
		IssueID:           "DAT-258",
		ActorIdentity:     "human:owner-1",
		ExecutionIdentity: "agent:sandbox-1",
		RepositoryURL:     repoURL,
		BaseSHA:           baseSHA,
	}, assessment, store)
	if err != nil {
		t.Fatalf("NewRun: %v", err)
	}
	now := time.Now().UTC()
	err = run.Approve(harness.GrantParams{
		TaskID:                 "task-change",
		RunID:                  "run-change",
		IssuedAt:               now.Add(-time.Minute),
		ExpiresAt:              now.Add(time.Hour),
		CapabilityGrantVersion: "grant-change",
		RepositoryURL:          repoURL,
		BaseSHA:                baseSHA,
		PermittedPaths:         []string{"src"},
		PermittedTools: []harness.PermittedTool{
			{Identity: "repo.read", AllowedArguments: []string{"path:path"}},
			{Identity: "workspace.patch", AllowedArguments: []string{"path:path", "text:content"}},
		},
		NetworkDestinations: []string{},
		MaxWallClockSeconds: 60,
		MayCreatePatch:      true,
	})
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
	runner, err := sandbox.New(run, sandbox.Options{
		WorkspaceRoot:  t.TempDir(),
		RevisionSource: sandbox.NewGitRevisionSource(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	return runner
}

func edit(t *testing.T, runner *sandbox.Runner, path, content string) {
	t.Helper()
	result, err := runner.Execute(context.Background(), sandbox.Spec{
		Kind:       sandbox.DispatchEdit,
		Tool:       "workspace.patch",
		WantsPatch: true,
		Arguments:  []string{"path:path", "text:content"},
		Paths:      []string{path},
		Op:         &sandbox.OpRequest{Path: path, Content: content},
	})
	if err != nil {
		t.Fatalf("Execute edit: %v", err)
	}
	if !result.Decision.Allowed {
		t.Fatalf("edit denied: %+v", result.Decision)
	}
}

func read(t *testing.T, runner *sandbox.Runner, path string) {
	t.Helper()
	result, err := runner.Execute(context.Background(), sandbox.Spec{
		Kind:      sandbox.DispatchRead,
		Tool:      "repo.read",
		Arguments: []string{"path:path"},
		Paths:     []string{path},
		Op:        &sandbox.OpRequest{Path: path},
	})
	if err != nil {
		t.Fatalf("Execute read: %v", err)
	}
	if !result.Decision.Allowed {
		t.Fatalf("read denied: %+v", result.Decision)
	}
}

func TestCaptureChangeFreezesDiffAndDeterministicHead(t *testing.T) {
	repo, baseSHA := localGitRepo(t)
	runner := newChangeRunner(t, repo, baseSHA)

	if change, err := runner.CaptureChange(context.Background()); err != nil || change != nil {
		t.Fatalf("CaptureChange before any edit = (%v, %v), want (nil, nil)", change, err)
	}

	edit(t, runner, "src/fix.ts", "export const value = 2;\n")

	first, err := runner.CaptureChange(context.Background())
	if err != nil {
		t.Fatalf("CaptureChange: %v", err)
	}
	if first == nil {
		t.Fatal("CaptureChange returned no change after an edit")
	}
	if first.BaseSHA != baseSHA {
		t.Errorf("base_sha = %q, want %q", first.BaseSHA, baseSHA)
	}
	if len(first.HeadSHA) != 40 || len(first.TreeSHA) != 40 {
		t.Errorf("head/tree = %q/%q, want git object ids", first.HeadSHA, first.TreeSHA)
	}
	if first.HeadSHA == baseSHA {
		t.Error("candidate head equals the base commit")
	}
	sum := sha256.Sum256([]byte(first.Diff))
	if first.DiffDigest != hex.EncodeToString(sum[:]) {
		t.Errorf("diff_digest = %q, want sha256 of the retained diff", first.DiffDigest)
	}
	for _, want := range []string{
		"diff --git a/src/fix.ts b/src/fix.ts",
		"-export const value = 1;",
		"+export const value = 2;",
	} {
		if !strings.Contains(first.Diff, want) {
			t.Errorf("diff does not contain %q:\n%s", want, first.Diff)
		}
	}
	if len(first.ChangedPaths) != 1 || first.ChangedPaths[0] != "src/fix.ts" {
		t.Errorf("changed_paths = %v, want [src/fix.ts]", first.ChangedPaths)
	}
	if first.Insertions != 1 || first.Deletions != 1 {
		t.Errorf("stats = +%d/-%d, want +1/-1", first.Insertions, first.Deletions)
	}

	// The candidate identity is a function of the prepared content only:
	// capturing again without a further edit yields the same revision.
	second, err := runner.CaptureChange(context.Background())
	if err != nil {
		t.Fatalf("second CaptureChange: %v", err)
	}
	if second == nil || second.HeadSHA != first.HeadSHA || second.DiffDigest != first.DiffDigest {
		t.Fatalf("repeat capture changed identity: %+v vs %+v", second, first)
	}

	// A content change is a new revision, never a mutation of the old one.
	edit(t, runner, "src/fix.ts", "export const value = 3;\n")
	third, err := runner.CaptureChange(context.Background())
	if err != nil {
		t.Fatalf("third CaptureChange: %v", err)
	}
	if third == nil || third.HeadSHA == first.HeadSHA || third.DiffDigest == first.DiffDigest {
		t.Fatalf("content change kept the old identity: %+v", third)
	}
}

func TestCaptureChangeIsLocalOnly(t *testing.T) {
	repo, baseSHA := localGitRepo(t)
	runner := newChangeRunner(t, repo, baseSHA)
	workspaceRepo := filepath.Join(runner.Workspace(), "repo")
	listRefs := func() string {
		t.Helper()
		out, err := exec.Command("git", "-C", workspaceRepo, "for-each-ref").Output()
		if err != nil {
			t.Fatalf("for-each-ref: %v", err)
		}
		return string(out)
	}
	edit(t, runner, "src/fix.ts", "export const value = 2;\n")
	before := listRefs()
	change, err := runner.CaptureChange(context.Background())
	if err != nil {
		t.Fatalf("CaptureChange: %v", err)
	}

	// Capture stages the working tree and creates a dangling commit object;
	// it must not create or move a branch, tag, or remote ref.
	after := listRefs()
	if after != before {
		t.Errorf("refs changed after capture:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	if strings.Contains(after, change.HeadSHA) {
		t.Errorf("candidate head %s leaked into a ref:\n%s", change.HeadSHA, after)
	}
	// The origin's pinned revision is untouched: still exactly one commit.
	count, err := exec.Command("git", "-C", repo, "rev-list", "--count", "HEAD").Output()
	if err != nil {
		t.Fatalf("rev-list: %v", err)
	}
	if strings.TrimSpace(string(count)) != "1" {
		t.Errorf("origin commit count = %s, want 1", strings.TrimSpace(string(count)))
	}
}

func TestCaptureChangeRefusesNonGitWorkspace(t *testing.T) {
	store := harness.NewEventStore()
	assessment, err := harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID:             "task-static",
		RunID:              "run-static",
		AssessedAt:         time.Now().UTC().Truncate(time.Second),
		AssessorIdentity:   "human:reviewer-1",
		RationaleReference: "evidence://risk/task-static",
	}, harness.RiskLow, harness.DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatalf("NewRiskAssessment: %v", err)
	}
	run, err := harness.NewRun(harness.RunConfig{
		TaskID:            "task-static",
		RunID:             "run-static",
		IssueID:           "DAT-258",
		ActorIdentity:     "human:owner-1",
		ExecutionIdentity: "agent:sandbox-1",
		RepositoryURL:     testRepoURL,
		BaseSHA:           testBaseSHA,
	}, assessment, store)
	if err != nil {
		t.Fatalf("NewRun: %v", err)
	}
	now := time.Now().UTC()
	if err := run.Approve(harness.GrantParams{
		TaskID:                 "task-static",
		RunID:                  "run-static",
		IssuedAt:               now.Add(-time.Minute),
		ExpiresAt:              now.Add(time.Hour),
		CapabilityGrantVersion: "grant-static",
		RepositoryURL:          testRepoURL,
		BaseSHA:                testBaseSHA,
		PermittedPaths:         []string{"src"},
		PermittedTools: []harness.PermittedTool{
			{Identity: "workspace.patch", AllowedArguments: []string{"path:path", "text:content"}},
		},
		MaxWallClockSeconds: 60,
		MayCreatePatch:      true,
	}); err != nil {
		t.Fatalf("Approve: %v", err)
	}
	runner, err := sandbox.New(run, sandbox.Options{
		WorkspaceRoot: t.TempDir(),
		RevisionSource: sandbox.NewStaticRevisionSource(sandbox.StaticRevision{
			RepositoryURL: testRepoURL,
			BaseSHA:       testBaseSHA,
			Files:         map[string]string{"src/fix.ts": "export const value = 1;\n"},
		}),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	edit(t, runner, "src/fix.ts", "export const value = 2;\n")

	if _, err := runner.CaptureChange(context.Background()); !errors.Is(err, sandbox.ErrChangeCaptureUnavailable) {
		t.Fatalf("CaptureChange error = %v, want ErrChangeCaptureUnavailable", err)
	}
}

func TestCurrentTreeSHATracksTheWorkingTree(t *testing.T) {
	repo, baseSHA := localGitRepo(t)
	runner := newChangeRunner(t, repo, baseSHA)
	read(t, runner, "src/fix.ts")

	baseTree, err := runner.CurrentTreeSHA(context.Background())
	if err != nil {
		t.Fatalf("CurrentTreeSHA on the pinned base: %v", err)
	}
	if len(baseTree) != 40 {
		t.Fatalf("base tree = %q, want a git tree object id", baseTree)
	}

	edit(t, runner, "src/fix.ts", "export const value = 2;\n")
	change, err := runner.CaptureChange(context.Background())
	if err != nil {
		t.Fatalf("CaptureChange: %v", err)
	}
	tree, err := runner.CurrentTreeSHA(context.Background())
	if err != nil {
		t.Fatalf("CurrentTreeSHA: %v", err)
	}
	if tree != change.TreeSHA {
		t.Fatalf("CurrentTreeSHA = %q, want the captured tree %q", tree, change.TreeSHA)
	}
	if tree == baseTree {
		t.Fatal("CurrentTreeSHA did not move after an edit")
	}

	edit(t, runner, "src/fix.ts", "export const value = 3;\n")
	second, err := runner.CurrentTreeSHA(context.Background())
	if err != nil {
		t.Fatalf("second CurrentTreeSHA: %v", err)
	}
	if second == tree {
		t.Fatal("a later edit kept the previously validated tree identity")
	}
}

func TestCaptureChangeIgnoresHostileGitMetadata(t *testing.T) {
	repo, baseSHA := localGitRepo(t)
	runner := newChangeRunner(t, repo, baseSHA)
	edit(t, runner, "src/fix.ts", "export const value = 2;\n")

	workspaceRepo := filepath.Join(runner.Workspace(), "repo")
	// The checkout is writable by untrusted execution: a test can plant a
	// clean filter and an fsmonitor command in repository metadata. Trusted
	// capture must never execute either of them.
	config := strings.Join([]string{
		"[core]",
		"\trepositoryformatversion = 0",
		"\tbare = false",
		"\tfsmonitor = !touch fsmonitor-ran",
		"[filter \"evil\"]",
		"\tclean = sh -c 'touch filter-ran; cat'",
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(workspaceRepo, ".git", "config"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspaceRepo, ".gitattributes"), []byte("* filter=evil\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := runner.CaptureChange(context.Background()); err != nil {
		t.Fatalf("CaptureChange: %v", err)
	}
	for _, marker := range []string{"filter-ran", "fsmonitor-ran"} {
		if _, err := os.Stat(filepath.Join(workspaceRepo, marker)); err == nil {
			t.Fatalf("repository metadata executed %q during trusted capture", marker)
		}
	}

	// The hostile config was replaced with the trusted one; capture never
	// carries it forward.
	content, err := os.ReadFile(filepath.Join(workspaceRepo, ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "filter") || strings.Contains(string(content), "fsmonitor") {
		t.Fatalf("trusted capture left hostile git config in place:\n%s", content)
	}
}
