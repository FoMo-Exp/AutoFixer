package sandbox

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Luthiel/AutoFixer/harness"
)

// Structured-operation errors: every refusal names one boundary so the
// evidence chain and the caller see exactly which gate decided.
var (
	// ErrPathEscape names a request that is not a clean repository-relative
	// path, or whose resolution walks outside the tree.
	ErrPathEscape = errors.New("sandbox: path escapes the repository tree")
	// ErrSymlinkEscape names a request that reaches outside the tree through
	// a symbolic link, or that would write through a symbolic link at all.
	ErrSymlinkEscape = errors.New("sandbox: path reaches outside the repository tree through a symbolic link")
	// ErrProhibitedPath names a path on the prohibited list: secret-looking
	// content and version-control internals are never readable or editable.
	ErrProhibitedPath = errors.New("sandbox: path is prohibited for structured operations")
	// ErrEditForbidden names an edit outside the allowed edit scope for the
	// run's risk class: dependency and migration changes need an elevated
	// assessment, workflow and governance content never opens.
	ErrEditForbidden = errors.New("sandbox: edit is outside the allowed edit scope for this risk class")
	// ErrLimitExceeded names a structured operation over its resource limit.
	ErrLimitExceeded = errors.New("sandbox: structured operation exceeds its resource limit")
)

// OpLimits bounds one structured operation. Zero values take the defaults
// below, so the zero value is safe: an operation can never run unbounded.
type OpLimits struct {
	// MaxReadBytes caps how many bytes one read retains; larger files are
	// truncated and flagged. Default defaultMaxReadBytes.
	MaxReadBytes int64
	// MaxEditBytes caps the content of one edit; larger writes are refused
	// outright. Default defaultMaxEditBytes.
	MaxEditBytes int64
	// MaxSearchHits caps how many matches one search returns. Default
	// defaultMaxSearchHits.
	MaxSearchHits int
	// MaxSearchBytes caps the total excerpt bytes one search returns.
	// Default defaultMaxSearchBytes.
	MaxSearchBytes int64
}

const (
	defaultMaxReadBytes   = 1 << 20   // 1 MiB
	defaultMaxEditBytes   = 512 << 10 // 512 KiB
	defaultMaxSearchHits  = 200
	defaultMaxSearchBytes = 256 << 10 // 256 KiB
	maxSearchFileBytes    = 1 << 20   // per-file scan cap
	maxExcerptBytes       = 200
)

func (l OpLimits) readBytes() int64 {
	if l.MaxReadBytes > 0 {
		return l.MaxReadBytes
	}
	return defaultMaxReadBytes
}

func (l OpLimits) editBytes() int64 {
	if l.MaxEditBytes > 0 {
		return l.MaxEditBytes
	}
	return defaultMaxEditBytes
}

func (l OpLimits) searchHits() int {
	if l.MaxSearchHits > 0 {
		return l.MaxSearchHits
	}
	return defaultMaxSearchHits
}

func (l OpLimits) searchBytes() int64 {
	if l.MaxSearchBytes > 0 {
		return l.MaxSearchBytes
	}
	return defaultMaxSearchBytes
}

// ReadResult is one bounded file read.
type ReadResult struct {
	Path      string
	Class     harness.PathClass
	Content   []byte
	Truncated bool
}

// SearchHit is one bounded match: the repository-relative path, the 1-based
// line number, and the redacted, truncated line text.
type SearchHit struct {
	Path string
	Line int
	Text string
}

// SearchResult is one bounded search.
type SearchResult struct {
	Hits      []SearchHit
	Truncated bool
}

// EditResult is one applied edit.
type EditResult struct {
	Path  string
	Class harness.PathClass
	Bytes int
}

// Tree is the structured read/search/edit gate over one materialized
// repository checkout. Every operation resolves its path with lexical and
// symlink containment, refuses prohibited paths, and applies the FP-01 path
// class rules before touching the filesystem. It is safe for concurrent use:
// a Tree holds only its real root.
type Tree struct {
	root string // EvalSymlinks(root), absolute
}

// OpenTree opens the gate over an existing checkout directory.
func OpenTree(root string) (*Tree, error) {
	if root == "" {
		return nil, errors.New("sandbox: tree root is required")
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(real)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("sandbox: tree root must be a directory")
	}
	return &Tree{root: real}, nil
}

// Root returns the real absolute checkout root.
func (t *Tree) Root() string { return t.root }

// resolvedPath is one validated request path.
type resolvedPath struct {
	// Rel is the cleaned repository-relative request path.
	Rel string
	// Abs is the real absolute path inside the tree.
	Abs string
	// Class is the FP-01 class of the request path.
	Class harness.PathClass
}

// resolve validates rel and resolves it inside the tree. When forEdit is
// set, a request path whose final component is a symbolic link is refused:
// edits never write through a link, only to the path itself.
func (t *Tree) resolve(rel string, forEdit bool) (resolvedPath, error) {
	if !cleanTreePath(rel) {
		return resolvedPath{}, ErrPathEscape
	}
	cleaned := path.Clean(filepath.ToSlash(rel))
	abs := filepath.Join(t.root, filepath.FromSlash(cleaned))
	real, err := t.realPath(abs)
	if err != nil {
		return resolvedPath{}, err
	}
	relClass := harness.ClassifyPath(cleaned)
	realClass := harness.ClassifyPath(t.relOf(real))
	if !harness.ReadableFor(relClass) || !harness.ReadableFor(realClass) {
		return resolvedPath{}, ErrProhibitedPath
	}
	if forEdit {
		if info, err := os.Lstat(abs); err == nil && info.Mode()&fs.ModeSymlink != 0 {
			return resolvedPath{}, ErrSymlinkEscape
		}
	}
	return resolvedPath{Rel: cleaned, Abs: real, Class: relClass}, nil
}

// realPath resolves abs through any symbolic links and proves the result
// stays inside the tree. Not-yet-existing tails are re-appended under the
// deepest resolved ancestor: components below it cannot yet be links.
func (t *Tree) realPath(abs string) (string, error) {
	probe := abs
	var tail []string
	for {
		real, err := filepath.EvalSymlinks(probe)
		if err == nil {
			candidate := real
			for i := len(tail) - 1; i >= 0; i-- {
				candidate = filepath.Join(candidate, tail[i])
			}
			if !withinRoot(t.root, candidate) {
				return "", ErrSymlinkEscape
			}
			return candidate, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", ErrPathEscape
		}
		tail = append([]string{filepath.Base(probe)}, tail...)
		probe = parent
	}
}

// relOf turns an absolute path inside the tree back into its
// repository-relative form.
func (t *Tree) relOf(abs string) string {
	rel, err := filepath.Rel(t.root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(rel)
}

// withinRoot reports whether candidate is root itself or beneath it, on
// segment boundaries so a sibling like "root-evil" never matches.
func withinRoot(root, candidate string) bool {
	if candidate == root {
		return true
	}
	return strings.HasPrefix(candidate, root+string(os.PathSeparator))
}

// cleanTreePath reports whether rel is a clean repository-relative path:
// non-empty, not absolute, and free of empty, ".", and ".." segments.
func cleanTreePath(rel string) bool {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\\") {
		return false
	}
	if filepath.IsAbs(rel) {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// Read reads one file through the gate, bounded by limits.
func (t *Tree) Read(rel string, limits OpLimits) (ReadResult, error) {
	resolved, err := t.resolve(rel, false)
	if err != nil {
		return ReadResult{}, err
	}
	data, err := os.ReadFile(resolved.Abs)
	if err != nil {
		return ReadResult{}, err
	}
	limit := limits.readBytes()
	truncated := int64(len(data)) > limit
	if truncated {
		data = data[:limit]
	}
	return ReadResult{
		Path:      resolved.Rel,
		Class:     resolved.Class,
		Content:   data,
		Truncated: truncated,
	}, nil
}

// Edit replaces or creates one file through the gate. The edit keeps the
// FP-01 class rules for the run's risk class in addition to the policy
// gate's, so an unauthorized change is refused even if a caller forgets to
// ask the policy first.
func (t *Tree) Edit(rel, content string, risk harness.RiskClass, limits OpLimits) (EditResult, error) {
	resolved, err := t.resolve(rel, true)
	if err != nil {
		return EditResult{}, err
	}
	if !harness.EditAllowedFor(resolved.Class, risk) {
		return EditResult{}, ErrEditForbidden
	}
	if int64(len(content)) > limits.editBytes() {
		return EditResult{}, ErrLimitExceeded
	}
	if err := os.MkdirAll(filepath.Dir(resolved.Abs), 0o755); err != nil {
		return EditResult{}, err
	}
	if err := os.WriteFile(resolved.Abs, []byte(content), 0o644); err != nil {
		return EditResult{}, err
	}
	return EditResult{Path: resolved.Rel, Class: resolved.Class, Bytes: len(content)}, nil
}

// Search scans the tree for a regular-expression pattern (RE2 syntax, so no
// pathological backtracking), bounded by limits. Scope is a
// repository-relative directory or file; empty means the whole tree.
// Prohibited paths never contribute matches.
func (t *Tree) Search(pattern, scope string, limits OpLimits) (SearchResult, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return SearchResult{}, err
	}
	start := t.root
	if scope != "" && scope != "." {
		resolved, err := t.resolve(scope, false)
		if err != nil {
			return SearchResult{}, err
		}
		start = resolved.Abs
	}

	result := SearchResult{Hits: []SearchHit{}}
	hitLimit := limits.searchHits()
	byteLimit := limits.searchBytes()
	var used int64

	walkErr := filepath.WalkDir(start, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable subtree is not a match source; keep scanning.
			return nil
		}
		name := entry.Name()
		if entry.IsDir() {
			if p != start && (name == ".git" || name == "node_modules") {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		rel := t.relOf(p)
		if !cleanTreePath(rel) {
			return nil
		}
		class := harness.ClassifyPath(rel)
		if !harness.ReadableFor(class) {
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.Size() > maxSearchFileBytes {
			return nil
		}
		file, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer func() { _ = file.Close() }()
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 0, 64<<10), 64<<10)
		line := 0
		for scanner.Scan() {
			line++
			text := scanner.Text()
			if !re.MatchString(text) {
				continue
			}
			excerpt := harness.Redact(text)
			if len(excerpt) > maxExcerptBytes {
				excerpt = excerpt[:maxExcerptBytes] + "…"
			}
			result.Hits = append(result.Hits, SearchHit{Path: rel, Line: line, Text: excerpt})
			used += int64(len(excerpt))
			if len(result.Hits) >= hitLimit || used >= byteLimit {
				result.Truncated = true
				return errSearchCap
			}
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, errSearchCap) {
		return SearchResult{}, walkErr
	}
	return result, nil
}

// errSearchCap stops the walk once a search budget is spent.
var errSearchCap = errors.New("sandbox: search budget spent")
