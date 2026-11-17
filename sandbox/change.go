package sandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ErrChangeCaptureUnavailable reports a workspace whose change cannot be
// frozen: the materialized checkout is not a git repository, so there is no
// tree/commit identity and no reviewable patch to retain.
var ErrChangeCaptureUnavailable = errors.New(
	"sandbox: the workspace is not a git checkout, so no proposed change can be captured",
)

const (
	// maxCapturedDiffBytes bounds the retained patch. A change larger than
	// this is not silently truncated into a reviewable artifact: capture
	// fails closed and no candidate can be frozen from it.
	maxCapturedDiffBytes = 2 << 20
	// captureTimeout bounds the trusted git plumbing calls that compute the
	// change identity after the untrusted execution has ended.
	captureTimeout = 45 * time.Second
	// trustedGitConfig replaces the repository's own config before capture.
	// The checkout was writable by untrusted code, so every repository-local
	// setting is treated as hostile input: no filters, hooks, fsmonitor,
	// include, signing, or credential helper can influence the trusted
	// plumbing that freezes the change.
	trustedGitConfig = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"
	// trustedGitAttributes unsets content filters and ident expansion for
	// every path. .git/info/attributes outranks the checkout's own
	// .gitattributes files, so a filter declared by the tested revision never
	// runs inside the control plane during capture.
	trustedGitAttributes = "* -filter -ident -text -working-tree-encoding\n"
	// captiveCommitName and captiveCommitEmail are the deterministic identity
	// of the local candidate commit. Together with the fixed epoch dates and
	// the run-bound message they make the candidate head SHA reproducible
	// from (base, tree, task, run) alone — no host identity or clock enters it.
	captiveCommitName  = "AutoFixer"
	captiveCommitEmail = "autofixer@localhost"
	captiveCommitDate  = "1970-01-01T00:00:00 +0000"
)

// ProposedChange is the frozen description of the change a preparation run
// produced. It is computed from the run's materialized checkout after the
// untrusted execution ended and before the workspace is removed, so a review
// card, its diff, and its identity survive cleanup.
type ProposedChange struct {
	// BaseSHA is the pinned revision the change was prepared against.
	BaseSHA string
	// TreeSHA is the git tree object of the prepared working tree.
	TreeSHA string
	// HeadSHA names the exact candidate revision. It is a locally created
	// git commit object (never a ref, branch, or provider write) whose
	// identity is deterministic for one base, tree, task, and run.
	HeadSHA string
	// Diff is the exact unified diff a reviewer reads, and DiffDigest is the
	// sha256 hex of those bytes.
	Diff       string
	DiffDigest string
	// ChangedPaths, Insertions, and Deletions are the bounded review stats
	// computed from the same revision pair as Diff.
	ChangedPaths []string
	Insertions   int
	Deletions    int
}

// CaptureChange freezes the change the run prepared in its one-time
// workspace. It performs only local git plumbing — staging the working tree,
// writing a tree object, and creating a dangling commit object — and never
// creates or updates a branch, ref, remote, or provider resource. A run that
// changed nothing returns (nil, nil).
//
// The caller must have finished all untrusted execution: capture reads the
// workspace after the last dispatch, which is why dsh only calls it once the
// run stopped or reached a terminal state.
func (r *Runner) CaptureChange(ctx context.Context) (*ProposedChange, error) {
	if !r.prepared || r.tree == nil || !r.mutated {
		return nil, nil
	}
	repoDir := filepath.Join(r.workspace, "repo")
	if err := sanitizeGitDir(repoDir); err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, captureTimeout)
	defer cancel()

	git := func(args ...string) ([]byte, error) {
		return r.gitPlumbing(ctx, repoDir, args...)
	}

	baseSHA := r.revision.BaseSHA
	if !isGitObjectID(baseSHA) {
		return nil, fmt.Errorf("sandbox: base revision %q is not a git object id", baseSHA)
	}
	baseTreeRaw, err := git("rev-parse", "--verify", baseSHA+"^{tree}")
	if err != nil {
		return nil, fmt.Errorf("sandbox: resolve base tree: %w", err)
	}
	baseTree := strings.TrimSpace(string(baseTreeRaw))
	treeSHA, err := r.stageAndWriteTree(ctx, repoDir, baseTree)
	if err != nil {
		return nil, err
	}
	if treeSHA == "" {
		// The staged index matches the base: the run prepared no change.
		return nil, nil
	}

	message := fmt.Sprintf("autofixer candidate for %s\n\nrun: %s\n", r.run.TaskID, r.run.RunID)
	headRaw, err := r.gitPlumbingEnv(ctx, repoDir, captiveGitEnv(r.workspace),
		"commit-tree", treeSHA, "-p", baseSHA, "-m", message)
	if err != nil {
		return nil, fmt.Errorf("sandbox: create candidate commit: %w", err)
	}
	headSHA := strings.TrimSpace(string(headRaw))
	if !isGitObjectID(headSHA) {
		return nil, fmt.Errorf("sandbox: candidate commit did not return an object id")
	}

	diffRaw, err := git("diff", "--no-color", "--no-ext-diff", "--no-renames", "--no-textconv",
		"--unified=3", baseSHA, headSHA)
	if err != nil {
		return nil, fmt.Errorf("sandbox: diff prepared change: %w", err)
	}
	if len(diffRaw) > maxCapturedDiffBytes {
		return nil, fmt.Errorf(
			"sandbox: prepared change diff is %d bytes, over the %d-byte review limit",
			len(diffRaw), maxCapturedDiffBytes,
		)
	}
	statsRaw, err := git("diff", "--numstat", "--no-renames", baseSHA, headSHA)
	if err != nil {
		return nil, fmt.Errorf("sandbox: measure prepared change: %w", err)
	}
	insertions, deletions, paths, err := parseNumstat(statsRaw)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(diffRaw)
	return &ProposedChange{
		BaseSHA:      baseSHA,
		TreeSHA:      treeSHA,
		HeadSHA:      headSHA,
		Diff:         string(diffRaw),
		DiffDigest:   hex.EncodeToString(sum[:]),
		ChangedPaths: paths,
		Insertions:   insertions,
		Deletions:    deletions,
	}, nil
}

// CurrentTreeSHA stages the workspace exactly as capture would and returns the
// git tree object of its current content, without creating a commit, ref, or
// diff. The control plane uses it to pin the tree a validation attempt ran
// against: a later capture whose tree differs from the last validated tree is
// not that revision's evidence.
//
// The workspace must still exist. A closed runner, a non-git checkout, or an
// unreadable workspace returns ErrChangeCaptureUnavailable.
func (r *Runner) CurrentTreeSHA(ctx context.Context) (string, error) {
	if !r.prepared || r.tree == nil || r.closed {
		return "", ErrChangeCaptureUnavailable
	}
	repoDir := filepath.Join(r.workspace, "repo")
	if err := sanitizeGitDir(repoDir); err != nil {
		return "", err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, captureTimeout)
	defer cancel()
	baseSHA := r.revision.BaseSHA
	if !isGitObjectID(baseSHA) {
		return "", fmt.Errorf("sandbox: base revision %q is not a git object id", baseSHA)
	}
	baseTreeRaw, err := r.gitPlumbing(ctx, repoDir, "rev-parse", "--verify", baseSHA+"^{tree}")
	if err != nil {
		return "", fmt.Errorf("sandbox: resolve base tree: %w", err)
	}
	treeSHA, err := r.stageAndWriteTree(ctx, repoDir, strings.TrimSpace(string(baseTreeRaw)))
	if err != nil {
		return "", err
	}
	if treeSHA == "" {
		// No difference from the pinned base: the tree is the base tree.
		return strings.TrimSpace(string(baseTreeRaw)), nil
	}
	return treeSHA, nil
}

// stageAndWriteTree stages the working tree and writes its tree object. It
// returns "" when the staged content equals baseTree (no change). No commit,
// ref, or remote is involved.
func (r *Runner) stageAndWriteTree(ctx context.Context, repoDir, baseTree string) (string, error) {
	git := func(args ...string) ([]byte, error) {
		return r.gitPlumbing(ctx, repoDir, args...)
	}
	if _, err := git("add", "--all", "--", "."); err != nil {
		return "", fmt.Errorf("sandbox: stage prepared change: %w", err)
	}
	treeRaw, err := git("write-tree")
	if err != nil {
		return "", fmt.Errorf("sandbox: write prepared tree: %w", err)
	}
	treeSHA := strings.TrimSpace(string(treeRaw))
	if treeSHA == baseTree {
		return "", nil
	}
	return treeSHA, nil
}

// sanitizeGitDir replaces the checkout's writable git metadata that could
// influence trusted plumbing. The repository was writable by untrusted code,
// so its config and attributes are inputs, never authority:
//
//   - a .git file (worktree pointer), symlink, or missing directory is
//     refused: capture only reads a real directory the broker created;
//   - .git/config is replaced with a minimal fixed config, dropping filters,
//     hooks, includes, fsmonitor commands, signing, and credential helpers;
//   - .git/info/attributes unsets every content filter and ident expansion,
//     and outranks the checkout's own .gitattributes files.
func sanitizeGitDir(repoDir string) error {
	gitDir := filepath.Join(repoDir, ".git")
	info, err := os.Lstat(gitDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ErrChangeCaptureUnavailable
		}
		return fmt.Errorf("sandbox: inspect workspace git directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrChangeCaptureUnavailable
	}
	// Every file this touches must not be a symlink out of the workspace.
	for _, dir := range []string{gitDir, filepath.Join(gitDir, "info")} {
		entry, err := os.Lstat(dir)
		switch {
		case errors.Is(err, os.ErrNotExist) && dir != gitDir:
			if err := os.MkdirAll(dir, 0o700); err != nil {
				return fmt.Errorf("sandbox: prepare git metadata: %w", err)
			}
		case err != nil:
			return fmt.Errorf("sandbox: inspect git metadata: %w", err)
		case entry.Mode()&os.ModeSymlink != 0 || !entry.IsDir():
			return ErrChangeCaptureUnavailable
		}
	}
	if err := writeTrustedFile(filepath.Join(gitDir, "config"), trustedGitConfig); err != nil {
		return err
	}
	return writeTrustedFile(filepath.Join(gitDir, "info", "attributes"), trustedGitAttributes)
}

// writeTrustedFile writes one control-plane-owned git metadata file, refusing
// a symlink at the leaf and replacing the content atomically.
func writeTrustedFile(pathname, content string) error {
	if info, err := os.Lstat(pathname); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || info.IsDir() {
			return ErrChangeCaptureUnavailable
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("sandbox: inspect git metadata file: %w", err)
	}
	temporary := pathname + ".autofixer-tmp"
	if err := os.WriteFile(temporary, []byte(content), 0o600); err != nil {
		return fmt.Errorf("sandbox: write git metadata: %w", err)
	}
	if err := os.Rename(temporary, pathname); err != nil {
		return fmt.Errorf("sandbox: install git metadata: %w", err)
	}
	return nil
}

// gitPlumbing runs one local git command with the broker's scrubbed
// environment (no host credentials, no prompts, no terminal).
func (r *Runner) gitPlumbing(ctx context.Context, repoDir string, args ...string) ([]byte, error) {
	return r.gitPlumbingEnv(ctx, repoDir, gitEnv(filepath.Join(r.workspace, "home")), args...)
}

func (r *Runner) gitPlumbingEnv(ctx context.Context, repoDir string, env []string, args ...string) ([]byte, error) {
	// -c overrides outrank every config file, including a global one the
	// capture environment does not own.
	argv := append([]string{
		"-C", repoDir,
		"-c", "core.fsmonitor=false",
		"-c", "core.untrackedCache=false",
		"-c", "core.hooksPath=/dev/null",
		"-c", "commit.gpgsign=false",
		"-c", "tag.gpgsign=false",
	}, args...)
	cmd := exec.CommandContext(ctx, "git", argv...)
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return nil, fmt.Errorf("%s: %s", strings.Join(args, " "), truncateOutput(exitErr.Stderr))
		}
		return nil, err
	}
	return out, nil
}

// captiveGitEnv is the deterministic commit environment: a fixed author and
// committer with a fixed epoch date, on top of the scrubbed broker
// environment. One base/tree/task/run tuple therefore always yields the same
// candidate head SHA.
func captiveGitEnv(workspace string) []string {
	return append(gitEnv(filepath.Join(workspace, "home")),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME="+captiveCommitName,
		"GIT_AUTHOR_EMAIL="+captiveCommitEmail,
		"GIT_COMMITTER_NAME="+captiveCommitName,
		"GIT_COMMITTER_EMAIL="+captiveCommitEmail,
		"GIT_AUTHOR_DATE="+captiveCommitDate,
		"GIT_COMMITTER_DATE="+captiveCommitDate,
	)
}

// parseNumstat turns `git diff --numstat` output into review stats and paths.
// Binary entries report "-" instead of line counts; they still name a changed
// path but contribute no insertion/deletion count.
func parseNumstat(raw []byte) (insertions, deletions int, paths []string, err error) {
	seen := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			return 0, 0, nil, fmt.Errorf("sandbox: unreadable numstat line %q", line)
		}
		if parts[0] != "-" {
			added, convErr := strconv.Atoi(parts[0])
			if convErr != nil {
				return 0, 0, nil, fmt.Errorf("sandbox: unreadable numstat count %q", parts[0])
			}
			insertions += added
		}
		if parts[1] != "-" {
			removed, convErr := strconv.Atoi(parts[1])
			if convErr != nil {
				return 0, 0, nil, fmt.Errorf("sandbox: unreadable numstat count %q", parts[1])
			}
			deletions += removed
		}
		path := parts[2]
		if !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	return insertions, deletions, paths, nil
}

// isGitObjectID reports whether value is a full git object id (sha1 or
// sha256 repository).
func isGitObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, r := range value {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}
