// Package delivery contains the side-effect boundary for ForgePilot's patch
// and pull-request handoff. The package accepts an already-authorized client;
// it never reads credentials, merges a pull request, or writes a protected
// repository resource itself.
package delivery

import (
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"unicode"
)

const (
	// AllowedRepositoryURL is the only repository this pilot may mutate.
	AllowedRepositoryURL = "https://github.com/Luthiel/AutoFixer.git"
	// AllowedBaseBranch is the protected base branch for proposed changes.
	AllowedBaseBranch = "main"
	// BranchPrefix is the only namespace writable by the adapter.
	BranchPrefix = "autofixer/"
)

var (
	ErrRepositoryNotAllowed = errors.New("delivery: repository is not the allowed AutoFixer repository")
	ErrBranchNotAllowed     = errors.New("delivery: branch is not in the autofixer namespace")
	ErrResourceNotAllowed   = errors.New("delivery: resource is protected and cannot be written")
)

// ValidateRepositoryURL accepts the canonical GitHub URL and its URL form
// without the conventional .git suffix. User info, ports, query strings, and
// fragments are rejected so a lookalike URL cannot cross the write boundary.
func ValidateRepositoryURL(repositoryURL string) error {
	u, err := url.Parse(repositoryURL)
	if err != nil || u.Scheme != "https" || strings.ToLower(u.Hostname()) != "github.com" ||
		u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" {
		return ErrRepositoryNotAllowed
	}
	repoPath := strings.TrimSuffix(path.Clean(u.Path), "/")
	if repoPath != "/Luthiel/AutoFixer" && repoPath != "/Luthiel/AutoFixer.git" {
		return ErrRepositoryNotAllowed
	}
	return nil
}

func validateRepositoryURLExact(repositoryURL string) error {
	if err := ValidateRepositoryURL(repositoryURL); err != nil {
		return err
	}
	return nil
}

// ValidateBranch checks a Git ref before it is passed to an injected branch
// writer. A prefix alone is not enough: traversal, ref syntax, and an empty
// suffix are all rejected.
func ValidateBranch(branch string) error {
	if branch == "" || !strings.HasPrefix(branch, BranchPrefix) ||
		strings.HasPrefix(branch, "refs/") || len(branch) > 255 {
		return ErrBranchNotAllowed
	}
	suffix := strings.TrimPrefix(branch, BranchPrefix)
	if suffix == "" || strings.Contains(branch, "//") || strings.Contains(branch, "..") ||
		strings.HasSuffix(branch, "/") || strings.HasSuffix(branch, ".") || strings.HasSuffix(branch, ".lock") ||
		strings.Contains(branch, "@{") {
		return ErrBranchNotAllowed
	}
	for _, component := range strings.Split(branch, "/") {
		if component == "." || component == ".." || strings.HasPrefix(component, ".") {
			return ErrBranchNotAllowed
		}
	}
	for _, r := range branch {
		if unicode.IsControl(r) || unicode.IsSpace(r) || strings.ContainsRune("~^:?*[\\", r) {
			return ErrBranchNotAllowed
		}
	}
	return nil
}

// ValidateBaseBranch makes the protected target explicit. The adapter can
// create a PR whose base is main, but it never writes that branch.
func ValidateBaseBranch(branch string) error {
	if branch != AllowedBaseBranch {
		return fmt.Errorf("%w: base branch %q", ErrResourceNotAllowed, branch)
	}
	return nil
}

// PatchFile identifies one repository path changed by a proposed patch. File
// contents are deliberately not part of this value; they stay in the
// isolated checkout or in an access-controlled artifact store.
type PatchFile struct {
	Path           string `json:"path"`
	ArtifactDigest string `json:"artifact_digest,omitempty"`
}

// PatchArtifact is the minimum revision binding needed to push a patch to an
// autofixer branch. It carries no credentials or raw file contents.
type PatchArtifact struct {
	TaskID             string      `json:"task_id"`
	RepositoryURL      string      `json:"repository_url"`
	BaseSHA            string      `json:"base_sha"`
	Branch             string      `json:"branch"`
	HeadSHA            string      `json:"head_sha"`
	Files              []PatchFile `json:"files"`
	ArtifactReferences []string    `json:"artifact_references"`
}

// Validate checks all repository paths that a branch writer would mutate.
func (p PatchArtifact) Validate() error {
	if err := validateRepositoryURLExact(p.RepositoryURL); err != nil {
		return err
	}
	if p.TaskID == "" || p.BaseSHA == "" || p.HeadSHA == "" {
		return errors.New("delivery: patch artifact requires task, base, and head identity")
	}
	if err := ValidateTaskBranch(p.TaskID, p.Branch, p.HeadSHA); err != nil {
		return err
	}
	if len(p.Files) == 0 {
		return errors.New("delivery: patch artifact must identify at least one file")
	}
	for _, file := range p.Files {
		if err := validateWritablePath(file.Path); err != nil {
			return err
		}
	}
	return nil
}

// ValidateTaskBranch enforces the project's branch naming contract:
// autofixer/<task-id>-<short-sha>. A seven-character prefix is used because it
// is the shortest GitHub-style short SHA that remains useful to reviewers.
func ValidateTaskBranch(taskID, branch, headSHA string) error {
	if err := ValidateBranch(branch); err != nil {
		return err
	}
	if taskID == "" || headSHA == "" || len(headSHA) < 7 || strings.ContainsAny(taskID, "/\\ ") {
		return ErrBranchNotAllowed
	}
	suffix := strings.TrimPrefix(branch, BranchPrefix)
	prefix := strings.ToLower(taskID) + "-"
	if !strings.HasPrefix(strings.ToLower(suffix), prefix) {
		return ErrBranchNotAllowed
	}
	shortSHA := suffix[len(prefix):]
	if len(shortSHA) != 7 || !strings.EqualFold(shortSHA, headSHA[:7]) {
		return ErrBranchNotAllowed
	}
	for _, r := range shortSHA {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return ErrBranchNotAllowed
		}
	}
	return nil
}

func validateWritablePath(filePath string) error {
	if filePath == "" || strings.Contains(filePath, "\\") {
		return fmt.Errorf("%w: empty or non-portable path", ErrResourceNotAllowed)
	}
	cleaned := path.Clean(filePath)
	if path.IsAbs(cleaned) || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return fmt.Errorf("%w: path %q", ErrResourceNotAllowed, filePath)
	}
	lower := strings.ToLower(cleaned)
	if lower == ".git" || strings.HasPrefix(lower, ".git/") ||
		lower == ".github" || strings.HasPrefix(lower, ".github/") ||
		lower == "docs/adr" || strings.HasPrefix(lower, "docs/adr/") {
		return fmt.Errorf("%w: path %q", ErrResourceNotAllowed, filePath)
	}
	for _, segment := range strings.Split(lower, "/") {
		if segment == "secret" || segment == "secrets" || segment == "credential" ||
			segment == "credentials" || segment == "password" || segment == "passwords" ||
			segment == "token" || segment == "tokens" {
			return fmt.Errorf("%w: path %q", ErrResourceNotAllowed, filePath)
		}
	}
	base := path.Base(lower)
	if base == ".env" || strings.HasPrefix(base, ".env.") || base == ".npmrc" ||
		base == ".pypirc" || base == "id_rsa" {
		return fmt.Errorf("%w: path %q", ErrResourceNotAllowed, filePath)
	}
	return nil
}

// ValidateWritablePath exposes the same deny-by-default path check used by a
// branch push, so callers can reject a patch before constructing an artifact.
func ValidateWritablePath(filePath string) error {
	return validateWritablePath(filePath)
}
