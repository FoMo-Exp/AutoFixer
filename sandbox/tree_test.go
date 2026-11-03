package sandbox

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Luthiel/AutoFixer/harness"
)

// newTreeFixture builds a small checkout-like tree for gate tests.
func newTreeFixture(t *testing.T) (string, *Tree) {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		t.Helper()
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", rel, err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	write("web/src/export.ts", "export const button = 1;\n")
	write("web/src/deep/feature.ts", "export const feature = 2;\n")
	write("go.mod", "module example.com/fixture\n")
	write("migrations/0001_init.sql", "create table t (id int);\n")
	write(".github/workflows/ci.yml", "on: push\n")
	write(".env", "TOKEN=abc\n")
	write(".git/config", "[core]\n")
	write("big.txt", strings.Repeat("a", 4096))
	tree, err := OpenTree(root)
	if err != nil {
		t.Fatalf("OpenTree: %v", err)
	}
	return root, tree
}

func TestTreeReadRejectsPathEscapes(t *testing.T) {
	_, tree := newTreeFixture(t)
	for _, rel := range []string{"../outside.txt", "web/../../outside.txt", "/etc/passwd", "web//../../x", "", ".", ".."} {
		_, err := tree.Read(rel, OpLimits{})
		if !errors.Is(err, ErrPathEscape) {
			t.Errorf("Read(%q) error = %v, want ErrPathEscape", rel, err)
		}
	}
}

func TestTreeReadRejectsSymlinkEscapes(t *testing.T) {
	root, tree := newTreeFixture(t)
	outside := filepath.Join(t.TempDir(), "outside-secret.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape-file")); err != nil {
		t.Fatalf("symlink file: %v", err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "escape-dir")); err != nil {
		t.Fatalf("symlink dir: %v", err)
	}

	if _, err := tree.Read("escape-file", OpLimits{}); !errors.Is(err, ErrSymlinkEscape) {
		t.Errorf("Read through escaping symlink: error = %v, want ErrSymlinkEscape", err)
	}
	if _, err := tree.Read("escape-dir/outside-secret.txt", OpLimits{}); !errors.Is(err, ErrSymlinkEscape) {
		t.Errorf("Read under escaping dir symlink: error = %v, want ErrSymlinkEscape", err)
	}
}

func TestTreeReadRejectsProhibitedPaths(t *testing.T) {
	_, tree := newTreeFixture(t)
	for _, rel := range []string{".env", ".git/config", "web/src/server.pem", "sub/.npmrc"} {
		_, err := tree.Read(rel, OpLimits{})
		if !errors.Is(err, ErrProhibitedPath) {
			t.Errorf("Read(%q) error = %v, want ErrProhibitedPath", rel, err)
		}
	}
}

func TestTreeReadReturnsContentWithLimit(t *testing.T) {
	_, tree := newTreeFixture(t)
	got, err := tree.Read("web/src/export.ts", OpLimits{})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got.Content) != "export const button = 1;\n" {
		t.Errorf("Content = %q, want file body", got.Content)
	}
	if got.Truncated {
		t.Error("Truncated = true, want false")
	}
	if got.Class != harness.ClassSource {
		t.Errorf("Class = %v, want source", got.Class)
	}

	limited, err := tree.Read("big.txt", OpLimits{MaxReadBytes: 16})
	if err != nil {
		t.Fatalf("Read(limited): %v", err)
	}
	if len(limited.Content) != 16 || !limited.Truncated {
		t.Errorf("limited read = %d bytes truncated=%v, want 16 bytes truncated", len(limited.Content), limited.Truncated)
	}
}

func TestTreeEditRejectsUnauthorizedClass(t *testing.T) {
	_, tree := newTreeFixture(t)

	// A low-risk run may edit source but not dependency or migration
	// content even though the edit tool is registered and the path is in
	// scope: classification, not the tool, decides.
	if _, err := tree.Edit("web/src/export.ts", "changed\n", harness.RiskLow, OpLimits{}); err != nil {
		t.Fatalf("Edit source at low risk: %v", err)
	}
	if _, err := tree.Edit("go.mod", "module changed\n", harness.RiskLow, OpLimits{}); !errors.Is(err, ErrEditForbidden) {
		t.Errorf("Edit go.mod at low risk: error = %v, want ErrEditForbidden", err)
	}
	if _, err := tree.Edit("migrations/0002.sql", "alter table t;\n", harness.RiskLow, OpLimits{}); !errors.Is(err, ErrEditForbidden) {
		t.Errorf("Edit migration at low risk: error = %v, want ErrEditForbidden", err)
	}
	if _, err := tree.Edit("go.mod", "module changed\n", harness.RiskElevated, OpLimits{}); err != nil {
		t.Fatalf("Edit go.mod at elevated risk: %v", err)
	}
	if _, err := tree.Edit(".github/workflows/ci.yml", "on: nothing\n", harness.RiskElevated, OpLimits{}); !errors.Is(err, ErrEditForbidden) {
		t.Errorf("Edit workflow at elevated risk: error = %v, want ErrEditForbidden", err)
	}
	if _, err := tree.Edit("AGENTS.md", "rules\n", harness.RiskElevated, OpLimits{}); !errors.Is(err, ErrEditForbidden) {
		t.Errorf("Edit governance at elevated risk: error = %v, want ErrEditForbidden", err)
	}
}

func TestTreeEditRefusesSymlinkTargetAndEscapes(t *testing.T) {
	root, tree := newTreeFixture(t)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("original"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked.txt")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := tree.Edit("linked.txt", "hijack\n", harness.RiskLow, OpLimits{}); !errors.Is(err, ErrSymlinkEscape) {
		t.Errorf("Edit through symlink: error = %v, want ErrSymlinkEscape", err)
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != "original" {
		t.Errorf("outside target = %q, %v; want untouched", raw, err)
	}
	if _, err := tree.Edit("../escape.txt", "x\n", harness.RiskLow, OpLimits{}); !errors.Is(err, ErrPathEscape) {
		t.Errorf("Edit escaping path: error = %v, want ErrPathEscape", err)
	}
}

func TestTreeEditEnforcesSizeLimit(t *testing.T) {
	_, tree := newTreeFixture(t)
	if _, err := tree.Edit("web/src/export.ts", strings.Repeat("x", 100), harness.RiskLow, OpLimits{MaxEditBytes: 16}); !errors.Is(err, ErrLimitExceeded) {
		t.Errorf("oversized edit: error = %v, want ErrLimitExceeded", err)
	}
}

func TestTreeSearchMatchesWithinScope(t *testing.T) {
	_, tree := newTreeFixture(t)
	got, err := tree.Search(`button`, "", OpLimits{})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got.Hits) != 1 || got.Hits[0].Path != "web/src/export.ts" || got.Hits[0].Line != 1 {
		t.Errorf("Hits = %+v, want one hit in web/src/export.ts line 1", got.Hits)
	}

	// Prohibited paths never contribute matches, and the match budget caps
	// the result instead of walking the whole tree unboundedly.
	secretHit, err := tree.Search(`TOKEN`, "", OpLimits{})
	if err != nil {
		t.Fatalf("Search secret pattern: %v", err)
	}
	if len(secretHit.Hits) != 0 {
		t.Errorf("secret file matched: %+v", secretHit.Hits)
	}

	capped, err := tree.Search(`export`, "web/src", OpLimits{MaxSearchHits: 1})
	if err != nil {
		t.Fatalf("Search capped: %v", err)
	}
	if len(capped.Hits) != 1 || !capped.Truncated {
		t.Errorf("capped search = %+v truncated=%v, want one hit and truncation", capped.Hits, capped.Truncated)
	}
}

func TestTreeSearchRejectsPathEscapesAndBadPatterns(t *testing.T) {
	_, tree := newTreeFixture(t)
	if _, err := tree.Search(`x`, "../outside", OpLimits{}); !errors.Is(err, ErrPathEscape) {
		t.Errorf("Search escaping scope: error = %v, want ErrPathEscape", err)
	}
	if _, err := tree.Search(`(unclosed`, "", OpLimits{}); err == nil {
		t.Error("Search with invalid pattern: want error, got nil")
	}
}

func TestTreeReadIsBoundedByLimit(t *testing.T) {
	_, tree := newTreeFixture(t)
	// A large file must not be pulled into memory whole: the read is
	// bounded by the limit and reports truncation.
	big := filepath.Join(tree.Root(), "huge.bin")
	if err := os.WriteFile(big, make([]byte, 8<<20), 0o644); err != nil {
		t.Fatalf("write huge file: %v", err)
	}
	got, err := tree.Read("huge.bin", OpLimits{MaxReadBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got.Content) != 1024 || !got.Truncated {
		t.Errorf("bounded read = %d bytes truncated=%v, want 1024 bytes truncated", len(got.Content), got.Truncated)
	}

	// A file at exactly the limit is not marked truncated.
	exact := filepath.Join(tree.Root(), "exact.bin")
	if err := os.WriteFile(exact, make([]byte, 1024), 0o644); err != nil {
		t.Fatalf("write exact file: %v", err)
	}
	got, err = tree.Read("exact.bin", OpLimits{MaxReadBytes: 1024})
	if err != nil {
		t.Fatalf("Read exact: %v", err)
	}
	if len(got.Content) != 1024 || got.Truncated {
		t.Errorf("exact read = %d bytes truncated=%v, want 1024 bytes untruncated", len(got.Content), got.Truncated)
	}
}

// countingReader counts how many bytes were pulled through it, so the
// bounded-read contract is observable: the reader must never be drained
// past the limit plus the truncation probe byte.
type countingReader struct {
	data io.Reader
	read int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.data.Read(p)
	c.read += int64(n)
	return n, err
}

func TestReadBoundedNeverDrainsTheSource(t *testing.T) {
	source := &countingReader{data: strings.NewReader(strings.Repeat("a", 1<<20))}
	got, truncated, err := readBounded(source, 1024)
	if err != nil {
		t.Fatalf("readBounded: %v", err)
	}
	if len(got) != 1024 || !truncated {
		t.Errorf("readBounded = %d bytes truncated=%v, want 1024 bytes truncated", len(got), truncated)
	}
	if source.read > 1025 {
		t.Errorf("source drained %d bytes, want at most limit+1 (1025)", source.read)
	}
}
