package sandbox

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestStaticRevisionSourceBindsTreeToBaseSHA(t *testing.T) {
	source := NewStaticRevisionSource(StaticRevision{
		RepositoryURL: "https://github.com/Luthiel/AutoFixer.git",
		BaseSHA:       "abc123",
		Files:         map[string]string{"go.mod": "module x\n", "web/src/a.ts": "export const a = 1;\n"},
	})
	dir := t.TempDir()
	identity, err := source.Materialize(context.Background(), dir, "https://github.com/Luthiel/AutoFixer.git", "abc123")
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if identity.BaseSHA != "abc123" || identity.TreeDigest == "" {
		t.Errorf("identity = %+v, want the pinned base SHA and a tree digest", identity)
	}
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); err != nil {
		t.Errorf("materialized file missing: %v", err)
	}

	// Materializing a revision the source does not hold is refused, so a
	// result can never describe a tree other than the exact revision asked
	// for.
	if _, err := source.Materialize(context.Background(), t.TempDir(), "https://github.com/Luthiel/AutoFixer.git", "other"); err == nil {
		t.Error("Materialize of an unheld base SHA succeeded, want refusal")
	}
}

func TestExecutionResultDigestBindsRevisionAndEnvironment(t *testing.T) {
	status := 0
	revision := &RevisionIdentity{RepositoryURL: "https://github.com/Luthiel/AutoFixer.git", BaseSHA: "abc123", TreeDigest: "sha256:tree-a"}
	environment := &EnvironmentIdentity{Platform: "test/os", Backend: "seatbelt", ProfileDigest: "sha256:profile-a", Network: "denied"}

	result, err := NewExecutionResult(ExecutionResultInput{
		Tool:        "test.run",
		Revision:    revision,
		Environment: environment,
		ExitStatus:  &status,
	})
	if err != nil {
		t.Fatalf("NewExecutionResult: %v", err)
	}
	if result.Digest == "" {
		t.Fatal("result digest is empty")
	}
	if err := result.VerifyDigest(); err != nil {
		t.Fatalf("VerifyDigest: %v", err)
	}

	again, err := NewExecutionResult(ExecutionResultInput{
		Tool:        "test.run",
		Revision:    revision,
		Environment: environment,
		ExitStatus:  &status,
	})
	if err != nil {
		t.Fatalf("NewExecutionResult again: %v", err)
	}
	if again.Digest != result.Digest {
		t.Errorf("digest unstable: %q vs %q", again.Digest, result.Digest)
	}

	// A result cannot borrow an identity from another revision or another
	// test environment: either change changes the binding digest.
	otherRevision := *revision
	otherRevision.BaseSHA = "def456"
	changed, err := NewExecutionResult(ExecutionResultInput{
		Tool:        "test.run",
		Revision:    &otherRevision,
		Environment: environment,
		ExitStatus:  &status,
	})
	if err != nil {
		t.Fatalf("NewExecutionResult changed revision: %v", err)
	}
	if changed.Digest == result.Digest {
		t.Error("digest unchanged after revision change")
	}

	otherEnvironment := *environment
	otherEnvironment.ProfileDigest = "sha256:profile-b"
	changed, err = NewExecutionResult(ExecutionResultInput{
		Tool:        "test.run",
		Revision:    revision,
		Environment: &otherEnvironment,
		ExitStatus:  &status,
	})
	if err != nil {
		t.Fatalf("NewExecutionResult changed environment: %v", err)
	}
	if changed.Digest == result.Digest {
		t.Error("digest unchanged after environment change")
	}

	// Tampering with a settled result is detectable.
	tampered := result
	tampered.ExitStatus = nil
	if err := tampered.VerifyDigest(); err == nil {
		t.Error("tampered result verified, want digest mismatch")
	}
}
