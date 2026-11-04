package harness

import (
	"path"
	"strings"
)

// PathClass is the FP-01 governance class of a repository-relative path. The
// class, not the tool that touches the path, decides what risk a change
// requires: dependency and migration changes stay elevated, workflow and
// governance changes stay prohibited, and registering a structured edit tool
// never implicitly expands either boundary.
type PathClass int

const (
	// ClassSource is ordinary source, test, and documentation content:
	// editable under a low-risk grant.
	ClassSource PathClass = iota
	// ClassDependency is a dependency manifest or lockfile: editable only
	// under an elevated (human-approved) assessment.
	ClassDependency
	// ClassMigration is database or schema migration content: editable only
	// under an elevated (human-approved) assessment.
	ClassMigration
	// ClassWorkflow is CI/workflow configuration: never editable, keeping
	// FP-01's prohibited workflow-edit classification.
	ClassWorkflow
	// ClassGovernance is ownership and governance content: never editable,
	// keeping FP-01's prohibited governance-change classification.
	ClassGovernance
	// ClassSecret is secret-looking content: never readable and never
	// editable through a structured operation.
	ClassSecret
	// ClassVersionControl is repository version-control internals (.git):
	// never readable and never editable through a structured operation.
	ClassVersionControl
)

// String names the class for audit reasons and errors.
func (c PathClass) String() string {
	switch c {
	case ClassSource:
		return "source"
	case ClassDependency:
		return "dependency"
	case ClassMigration:
		return "migration"
	case ClassWorkflow:
		return "workflow"
	case ClassGovernance:
		return "governance"
	case ClassSecret:
		return "secret"
	case ClassVersionControl:
		return "version_control"
	default:
		return "unknown"
	}
}

// dependencyNames are exact dependency manifest and lockfile names at any
// depth. Keeping the list explicit keeps classification deterministic.
var dependencyNames = map[string]bool{
	"package.json":         true,
	"package-lock.json":    true,
	"yarn.lock":            true,
	"pnpm-lock.yaml":       true,
	"npm-shrinkwrap.json":  true,
	"go.mod":               true,
	"go.sum":               true,
	"requirements.txt":     true,
	"requirements-dev.txt": true,
	"pipfile":              true,
	"pipfile.lock":         true,
	"poetry.lock":          true,
	"pyproject.toml":       true,
	"cargo.toml":           true,
	"cargo.lock":           true,
	"gemfile":              true,
	"gemfile.lock":         true,
	"composer.json":        true,
	"composer.lock":        true,
}

// secretNames are exact file names that look like local credentials.
var secretNames = map[string]bool{
	".env":        true,
	".npmrc":      true,
	".netrc":      true,
	".pypirc":     true,
	"credentials": true,
}

// secretSuffixes are file suffixes that look like key material.
var secretSuffixes = []string{".pem", ".key", ".p12", ".pfx"}

// ClassifyPath returns the governance class of one repository-relative path.
// Classification is lexical and deterministic: it looks only at the cleaned
// path, never at file contents or symlinks, so the same path classifies the
// same way on every host and in every run.
func ClassifyPath(rel string) PathClass {
	cleaned := path.Clean(strings.TrimPrefix(rel, "./"))
	if cleaned == "" || cleaned == "." || cleaned == "/" {
		return ClassSource
	}
	segments := strings.Split(cleaned, "/")
	for i, segment := range segments {
		lower := strings.ToLower(segment)
		switch {
		case segment == ".git":
			return ClassVersionControl
		case segment == ".github" && i < len(segments)-1:
			// Everything under .github is repository automation and
			// governance: workflow files and platform configuration alike.
			return ClassWorkflow
		case lower == "codeowners":
			return ClassGovernance
		case segment == ".githooks":
			return ClassGovernance
		case segment == "adr" && i > 0 && segments[i-1] == "docs":
			return ClassGovernance
		}
	}
	base := strings.ToLower(segments[len(segments)-1])
	switch {
	case base == "agents.md" || base == "context.md":
		return ClassGovernance
	case dependencyNames[base]:
		return ClassDependency
	case secretNames[base] || hasSecretSuffix(base) || strings.HasPrefix(base, ".env."):
		return ClassSecret
	case isWorkflowFile(base, segments):
		return ClassWorkflow
	case isMigrationPath(segments):
		return ClassMigration
	}
	return ClassSource
}

// hasSecretSuffix reports whether a base name looks like key material.
func hasSecretSuffix(base string) bool {
	for _, suffix := range secretSuffixes {
		if strings.HasSuffix(base, suffix) {
			return true
		}
	}
	return strings.HasPrefix(base, "id_rsa") || strings.HasPrefix(base, "id_ecdsa") ||
		strings.HasPrefix(base, "id_ed25519")
}

// isWorkflowFile recognizes CI pipeline files outside .github (which the
// segment walk already classified).
func isWorkflowFile(base string, segments []string) bool {
	switch base {
	case "jenkinsfile", "azure-pipelines.yml", "azure-pipelines.yaml",
		".gitlab-ci.yml", ".travis.yml", "buildkite.yml":
		return true
	}
	for _, segment := range segments {
		if segment == ".circleci" {
			return true
		}
	}
	return false
}

// isMigrationPath recognizes database/schema migration directories at any
// depth.
func isMigrationPath(segments []string) bool {
	for _, segment := range segments {
		switch strings.ToLower(segment) {
		case "migrations", "migrate", "alembic":
			return true
		}
	}
	return false
}

// EditAllowedFor reports whether a change to a path of the given class is
// permitted at the given assessed risk class. Elevated classes never open for
// low-risk runs, prohibited classes never open at all, and only an explicitly
// non-prohibited assessment may edit anything.
func EditAllowedFor(class PathClass, risk RiskClass) bool {
	switch risk {
	case RiskLow:
		return class == ClassSource
	case RiskElevated:
		return class == ClassSource || class == ClassDependency || class == ClassMigration
	default:
		return false
	}
}

// ReadableFor reports whether a path of the given class may be read through a
// structured operation. Secret material and version-control internals are
// never readable; governance content is readable but not editable.
func ReadableFor(class PathClass) bool {
	switch class {
	case ClassSecret, ClassVersionControl:
		return false
	default:
		return true
	}
}
