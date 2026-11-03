package sandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/Luthiel/AutoFixer/harness"
)

// RevisionIdentity binds one execution's result to the exact repository
// revision it ran against: the repository, the pinned base SHA, and the
// digest of the materialized working tree.
type RevisionIdentity struct {
	RepositoryURL string `json:"repository_url"`
	BaseSHA       string `json:"base_sha"`
	TreeDigest    string `json:"tree_digest"`
}

// RevisionSource materializes one pinned repository revision into a
// workspace. It is the approved read broker: untrusted code never fetches
// anything, and a source that does not hold the requested revision fails
// instead of substituting another.
type RevisionSource interface {
	// Materialize writes the working tree of repositoryURL at baseSHA into
	// repoDir and returns the identity it actually materialized.
	Materialize(ctx context.Context, repoDir, repositoryURL, baseSHA string) (RevisionIdentity, error)
}

// StaticRevision is one in-memory revision for tests and fixtures.
type StaticRevision struct {
	RepositoryURL string
	BaseSHA       string
	Files         map[string]string
}

// StaticRevisionSource serves one fixed revision from memory.
type staticRevisionSource struct {
	revision StaticRevision
}

// NewStaticRevisionSource builds a revision source holding exactly one
// revision. Materializing any other revision is refused.
func NewStaticRevisionSource(revision StaticRevision) RevisionSource {
	return &staticRevisionSource{revision: revision}
}

func (s *staticRevisionSource) Materialize(_ context.Context, repoDir, repositoryURL, baseSHA string) (RevisionIdentity, error) {
	if repositoryURL != s.revision.RepositoryURL || baseSHA != s.revision.BaseSHA {
		return RevisionIdentity{}, fmt.Errorf("sandbox: static revision source does not hold %s at %s", repositoryURL, baseSHA)
	}
	for rel, content := range s.revision.Files {
		if !cleanTreePath(rel) {
			return RevisionIdentity{}, fmt.Errorf("sandbox: static revision file %q is not a clean repository-relative path", rel)
		}
		abs := filepath.Join(repoDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return RevisionIdentity{}, err
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			return RevisionIdentity{}, err
		}
	}
	digest, err := treeDigest(repoDir)
	if err != nil {
		return RevisionIdentity{}, err
	}
	return RevisionIdentity{RepositoryURL: repositoryURL, BaseSHA: baseSHA, TreeDigest: digest}, nil
}

// gitRevisionSource fetches a pinned revision through git. The clone and
// checkout run with a scrubbed environment and no credential prompt, and the
// checked-out HEAD is verified against the requested base SHA before the
// identity is reported.
type gitRevisionSource struct{}

// NewGitRevisionSource builds the production read broker over git.
func NewGitRevisionSource() RevisionSource { return gitRevisionSource{} }

func (gitRevisionSource) Materialize(ctx context.Context, repoDir, repositoryURL, baseSHA string) (RevisionIdentity, error) {
	if err := os.MkdirAll(filepath.Dir(repoDir), 0o755); err != nil {
		return RevisionIdentity{}, err
	}
	clone := exec.CommandContext(ctx, "git", "clone", "--no-checkout", "--quiet", repositoryURL, repoDir)
	clone.Env = gitEnv(filepath.Dir(repoDir))
	if out, err := clone.CombinedOutput(); err != nil {
		return RevisionIdentity{}, fmt.Errorf("sandbox: clone %s: %w: %s", repositoryURL, err, truncateOutput(out))
	}
	checkout := exec.CommandContext(ctx, "git", "-C", repoDir, "checkout", "--quiet", "--detach", baseSHA)
	checkout.Env = gitEnv(filepath.Dir(repoDir))
	if out, err := checkout.CombinedOutput(); err != nil {
		return RevisionIdentity{}, fmt.Errorf("sandbox: checkout %s: %w: %s", baseSHA, err, truncateOutput(out))
	}
	head := exec.CommandContext(ctx, "git", "-C", repoDir, "rev-parse", "HEAD")
	head.Env = gitEnv(filepath.Dir(repoDir))
	out, err := head.Output()
	if err != nil {
		return RevisionIdentity{}, fmt.Errorf("sandbox: read materialized HEAD: %w", err)
	}
	headSHA := strings.TrimSpace(string(out))
	if !strings.HasPrefix(headSHA, baseSHA) && !strings.HasPrefix(baseSHA, headSHA) {
		return RevisionIdentity{}, fmt.Errorf("sandbox: materialized HEAD %s does not match requested base SHA %s", headSHA, baseSHA)
	}
	digest, err := treeDigest(repoDir)
	if err != nil {
		return RevisionIdentity{}, err
	}
	return RevisionIdentity{RepositoryURL: repositoryURL, BaseSHA: headSHA, TreeDigest: digest}, nil
}

// gitEnv is the scrubbed environment for broker git calls: no host
// credentials, no prompting, no terminal interaction.
func gitEnv(home string) []string {
	return []string{
		"PATH=" + toolPath(),
		"HOME=" + home,
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"LANG=C",
	}
}

// truncateOutput keeps error surfaces bounded.
func truncateOutput(out []byte) string {
	const limit = 512
	if len(out) > limit {
		out = out[:limit]
	}
	return strings.TrimSpace(string(out))
}

// treeDigest computes the working-tree manifest digest: every
// repository-relative file path with its content digest, in sorted order.
// Version-control internals (.git) are not part of the revision identity.
func treeDigest(root string) (string, error) {
	h := sha256.New()
	var files []string
	err := filepath.WalkDir(root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if p != root && entry.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			return relErr
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return "", err
	}
	for _, rel := range files {
		content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(content)
		fmt.Fprintf(h, "%s\x00%s\n", rel, hex.EncodeToString(sum[:]))
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// ExecutionResultInput carries the facts one execution result binds
// together before its tamper-evident digest is computed.
type ExecutionResultInput struct {
	Tool             string
	Revision         *RevisionIdentity
	Environment      *EnvironmentIdentity
	ExitStatus       *int
	OutputDigest     *harness.Digest
	TimedOut         bool
	Canceled         bool
	ResourceExceeded string
}

// ExecutionResult is one structured operation's outcome, bound to the exact
// revision and test environment it ran in. The digest covers every field —
// including both identities — so a result can never present one revision's
// output under another revision's or environment's identity.
type ExecutionResult struct {
	Tool         string               `json:"tool"`
	Revision     *RevisionIdentity    `json:"revision"`
	Environment  *EnvironmentIdentity `json:"environment"`
	ExitStatus   *int                 `json:"exit_status,omitempty"`
	OutputDigest *harness.Digest      `json:"output_digest,omitempty"`
	TimedOut     bool                 `json:"timed_out,omitempty"`
	Canceled     bool                 `json:"canceled,omitempty"`
	// ResourceExceeded names the granted resource cap that terminated the
	// execution ("memory", "cpu"), or "accounting" when enforcement broke
	// down and the execution was stopped rather than left uncapped.
	ResourceExceeded string `json:"resource_exceeded,omitempty"`
	Digest           string `json:"digest"`
}

// NewExecutionResult computes the binding digest over the result record.
func NewExecutionResult(in ExecutionResultInput) (ExecutionResult, error) {
	result := ExecutionResult{
		Tool:             in.Tool,
		Revision:         in.Revision,
		Environment:      in.Environment,
		ExitStatus:       in.ExitStatus,
		OutputDigest:     in.OutputDigest,
		TimedOut:         in.TimedOut,
		Canceled:         in.Canceled,
		ResourceExceeded: in.ResourceExceeded,
	}
	digest, err := resultDigest(result)
	if err != nil {
		return ExecutionResult{}, err
	}
	result.Digest = digest
	return result, nil
}

// VerifyDigest recomputes the binding digest and fails on any tampering.
func (r ExecutionResult) VerifyDigest() error {
	expected, err := resultDigest(r)
	if err != nil {
		return err
	}
	if r.Digest != expected {
		return errors.New("sandbox: execution result digest mismatch")
	}
	return nil
}

// resultDigest hashes the canonical result record with the digest field
// blanked.
func resultDigest(r ExecutionResult) (string, error) {
	r.Digest = ""
	raw, err := json.Marshal(r)
	if err != nil {
		return "", fmt.Errorf("sandbox: canonicalize execution result: %w", err)
	}
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}
