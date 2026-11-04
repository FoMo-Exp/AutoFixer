package harness

import "testing"

// Classification of repository paths is FP-01 governance policy: dependency,
// workflow, and migration changes keep their elevated/prohibited classes no
// matter which tool touches them, so registering a structured edit tool can
// never implicitly widen what a low-risk run may change.

func TestClassifyPathKeepsGovernanceClasses(t *testing.T) {
	cases := []struct {
		path string
		want PathClass
	}{
		{"web/src/export.ts", ClassSource},
		{"harness/policy_test.go", ClassSource},
		{"dsh/README.md", ClassSource},
		{"package.json", ClassDependency},
		{"package-lock.json", ClassDependency},
		{"node/package.json", ClassDependency},
		{"node/package-lock.json", ClassDependency},
		{"go.mod", ClassDependency},
		{"go.sum", ClassDependency},
		{"sub/project/go.mod", ClassDependency},
		{"migrations/0001_init.sql", ClassMigration},
		{"db/migrations/0001_init.sql", ClassMigration},
		{"services/api/alembic/versions/0001.py", ClassMigration},
		{".github/workflows/ci.yml", ClassWorkflow},
		{".github/workflows/release.yaml", ClassWorkflow},
		{"ci/Jenkinsfile", ClassWorkflow},
		{".circleci/config.yml", ClassWorkflow},
		{"azure-pipelines.yml", ClassWorkflow},
		{".gitlab-ci.yml", ClassWorkflow},
		{"CODEOWNERS", ClassGovernance},
		{"docs/CODEOWNERS", ClassGovernance},
		{"docs/adr/0007-pi-collaboration-and-pre-pr-approval.md", ClassGovernance},
		{".githooks/pre-commit", ClassGovernance},
		{"AGENTS.md", ClassGovernance},
		{"CONTEXT.md", ClassGovernance},
		{".env", ClassSecret},
		{"node/.env.local", ClassSecret},
		{"config/id_rsa", ClassSecret},
		{"certs/server.pem", ClassSecret},
		{".npmrc", ClassSecret},
		{"sub/.netrc", ClassSecret},
		{".git/config", ClassVersionControl},
		{"git/regular-file.txt", ClassSource},
	}
	for _, tc := range cases {
		if got := ClassifyPath(tc.path); got != tc.want {
			t.Errorf("ClassifyPath(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

func TestEditAllowedOnlyAtClassifiedRisk(t *testing.T) {
	cases := []struct {
		class PathClass
		risk  RiskClass
		want  bool
	}{
		{ClassSource, RiskLow, true},
		{ClassSource, RiskElevated, true},
		{ClassDependency, RiskLow, false},
		{ClassDependency, RiskElevated, true},
		{ClassMigration, RiskLow, false},
		{ClassMigration, RiskElevated, true},
		{ClassWorkflow, RiskLow, false},
		{ClassWorkflow, RiskElevated, false},
		{ClassGovernance, RiskElevated, false},
		{ClassSecret, RiskElevated, false},
		{ClassVersionControl, RiskElevated, false},
		{ClassSource, RiskProhibited, false},
	}
	for _, tc := range cases {
		if got := EditAllowedFor(tc.class, tc.risk); got != tc.want {
			t.Errorf("EditAllowedFor(%v, %v) = %v, want %v", tc.class, tc.risk, got, tc.want)
		}
	}
}

func TestReadableClassExcludesSecretsAndVCS(t *testing.T) {
	for _, class := range []PathClass{ClassSource, ClassDependency, ClassMigration, ClassWorkflow, ClassGovernance} {
		if !ReadableFor(class) {
			t.Errorf("ReadableFor(%v) = false, want true", class)
		}
	}
	for _, class := range []PathClass{ClassSecret, ClassVersionControl} {
		if ReadableFor(class) {
			t.Errorf("ReadableFor(%v) = true, want false", class)
		}
	}
}
