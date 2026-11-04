package dsh

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/Luthiel/AutoFixer/agent/tools"
	"github.com/Luthiel/AutoFixer/harness"
)

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ParamSpec is one structured argument of a registered tool. Enum
// parameters carry closed vocabularies; path parameters are clean
// repository-relative paths; text parameters are bounded free-form values.
// The capability grant never enumerates free-form values: it allow-lists the
// parameter's kind token ("path:name", "text:name"), so a value cannot be
// granted ahead of time while its effect stays bounded by the tool's
// registered schema, the path scope, and the operation gate.
type ParamSpec struct {
	Name     string   `json:"name"`
	Kind     string   `json:"kind"` // "enum" | "path" | "text"
	Enum     []string `json:"enum,omitempty"`
	MaxBytes int      `json:"max_bytes,omitempty"`
	Required bool     `json:"required"`
}

// ToolKind selects the dispatch surface a registered tool uses.
type ToolKind int

const (
	// ToolProcess is a plain tool binary (the M0 enum fixtures).
	ToolProcess ToolKind = iota
	// ToolRead is a structured repository read.
	ToolRead
	// ToolSearch is a structured repository search.
	ToolSearch
	// ToolEdit is a structured repository edit.
	ToolEdit
	// ToolTest is a registered test profile execution.
	ToolTest
	// ToolDep is a registered dependency preparation profile execution.
	ToolDep
)

// ToolSpec is one registered tool: its structured schema, the dispatch
// surface it uses, and the independent allow-list metadata the registry
// enforces in front of the harness grant.
type ToolSpec struct {
	ID           string
	Kind         ToolKind
	Exec         string
	Params       []ParamSpec
	MinimumRisk  harness.RiskClass
	AllowedPaths []string
}

// toolRegistry is the structured tool schema registry. Registration is the
// only way a tool becomes visible to the control plane; unregistered tools
// are refused before any dispatch or policy evaluation.
type toolRegistry struct {
	specs map[string]ToolSpec
	order []string
}

func newToolRegistry(specs []ToolSpec) *toolRegistry {
	registry := &toolRegistry{specs: map[string]ToolSpec{}}
	for _, spec := range specs {
		registry.specs[spec.ID] = spec
		registry.order = append(registry.order, spec.ID)
	}
	sort.Strings(registry.order)
	return registry
}

// defaultToolSpecs is the registered tool surface: the structured
// read/search/edit/test/dependency operations that replace raw shell and
// file access, plus the M0 enum fixtures. Every tool is schema-validated
// structured data — raw shell and argv identities (sh, bash, git, ...) are
// deliberately absent, and test/dependency commands come only from the
// registered sandbox profiles.
func defaultToolSpecs() []ToolSpec {
	return []ToolSpec{
		{
			ID:           "echo",
			Kind:         ToolProcess,
			Exec:         "echo",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "message", Kind: "enum", Enum: []string{"hello"}, Required: true},
			},
		},
		{
			ID:           "sleep",
			Kind:         ToolProcess,
			Exec:         "sleep",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "seconds", Kind: "enum", Enum: []string{"5"}, Required: true},
			},
		},
		{
			ID:           "repo.read",
			Kind:         ToolRead,
			Exec:         "repo.read",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "path", Kind: "path", Required: true},
			},
		},
		{
			ID:           "repo.search",
			Kind:         ToolSearch,
			Exec:         "repo.search",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "pattern", Kind: "text", MaxBytes: 256, Required: true},
				{Name: "path", Kind: "path"},
			},
		},
		{
			ID:           "workspace.patch",
			Kind:         ToolEdit,
			Exec:         "workspace.patch",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "path", Kind: "path", Required: true},
				{Name: "content", Kind: "text", MaxBytes: 262144, Required: true},
			},
		},
		{
			ID:           "test.run",
			Kind:         ToolTest,
			Exec:         "test.run",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "profile", Kind: "enum", Enum: []string{"go.test", "node.test"}, Required: true},
				{Name: "mode", Kind: "enum", Enum: []string{"focused", "suite"}, Required: true},
				{Name: "target", Kind: "path"},
			},
		},
		{
			ID:           "dep.prepare",
			Kind:         ToolDep,
			Exec:         "dep.prepare",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "profile", Kind: "enum", Enum: []string{"go.mod", "node.package"}, Required: true},
			},
		},
	}
}

func (r *toolRegistry) has(id string) bool {
	_, ok := r.specs[id]
	return ok
}

func (r *toolRegistry) get(id string) (ToolSpec, bool) {
	spec, ok := r.specs[id]
	return spec, ok
}

// ids lists the registered tool identities in stable order.
func (r *toolRegistry) ids() []string {
	return append([]string{}, r.order...)
}

// validatedArguments is one schema-validated call: the grant-checked class
// tokens, the redacted evidence forms, and the typed values.
type validatedArguments struct {
	// Tokens are the grant-visible arguments: enum values plus one class
	// token per free-form parameter. The harness allow-list matches these
	// exactly, so no free-form value is ever granted by enumeration.
	Tokens []string
	// Evidence are the redacted value forms recorded in the evidence
	// chain: enum values and paths as given, small text as redacted text,
	// large text as its digest.
	Evidence []string
	// Values are the validated string values by parameter name.
	Values map[string]string
}

// maxEvidenceTextBytes is the largest free-form text value recorded
// verbatim (redacted) in the evidence chain; larger values are recorded as
// a digest.
const maxEvidenceTextBytes = 256

// validateArguments checks a structured argument object against the tool's
// schema and returns the grant tokens, evidence forms, and typed values.
// Only enum values enter the grant vocabulary; free-form values are bounded
// by the schema and checked by the operation gate instead.
func (r *toolRegistry) validateArguments(id string, raw map[string]any) (validatedArguments, error) {
	spec, ok := r.specs[id]
	if !ok {
		return validatedArguments{}, fmt.Errorf("tool %q is not registered", id)
	}
	seen := map[string]bool{}
	out := validatedArguments{Tokens: make([]string, 0, len(spec.Params)), Values: map[string]string{}}
	for _, param := range spec.Params {
		value, present := raw[param.Name]
		if !present {
			if param.Required {
				return validatedArguments{}, fmt.Errorf("tool %q requires argument %q", id, param.Name)
			}
			continue
		}
		text, ok := value.(string)
		if !ok {
			return validatedArguments{}, fmt.Errorf("tool %q argument %q must be a string", id, param.Name)
		}
		if text == "" {
			return validatedArguments{}, fmt.Errorf("tool %q argument %q must not be empty", id, param.Name)
		}
		switch param.Kind {
		case "enum":
			if len(param.Enum) == 0 || !contains(param.Enum, text) {
				return validatedArguments{}, fmt.Errorf("tool %q argument %q must be one of %s", id, param.Name, strings.Join(param.Enum, ", "))
			}
			out.Tokens = append(out.Tokens, text)
			out.Evidence = append(out.Evidence, harness.Redact(text))
		case "path":
			if !cleanRelativePath(text) {
				return validatedArguments{}, fmt.Errorf("tool %q argument %q must be a relative repository path", id, param.Name)
			}
			out.Tokens = append(out.Tokens, "path:"+param.Name)
			out.Evidence = append(out.Evidence, text)
		case "text":
			if param.MaxBytes > 0 && len(text) > param.MaxBytes {
				return validatedArguments{}, fmt.Errorf("tool %q argument %q exceeds its %d-byte limit", id, param.Name, param.MaxBytes)
			}
			out.Tokens = append(out.Tokens, "text:"+param.Name)
			if len(text) > maxEvidenceTextBytes {
				out.Evidence = append(out.Evidence, "sha256:"+sha256Hex([]byte(text)))
			} else {
				out.Evidence = append(out.Evidence, harness.Redact(text))
			}
		default:
			return validatedArguments{}, fmt.Errorf("tool %q argument %q has unknown kind %q", id, param.Name, param.Kind)
		}
		seen[param.Name] = true
		out.Values[param.Name] = text
	}
	for name := range raw {
		if !seen[name] && !paramExists(spec, name) {
			return validatedArguments{}, fmt.Errorf("tool %q does not declare argument %q", id, name)
		}
	}
	return out, nil
}

func paramExists(spec ToolSpec, name string) bool {
	for _, param := range spec.Params {
		if param.Name == name {
			return true
		}
	}
	return false
}

// permittedArguments is the grant allow-list for one tool: its enum values
// plus one class token per free-form parameter. Harness policy matches
// arguments exactly against these tokens, so a free-form value can never be
// granted by enumeration and a kind the tool does not declare can never be
// granted at all.
func permittedArguments(spec ToolSpec) []string {
	seen := map[string]bool{}
	var out []string
	add := func(token string) {
		if !seen[token] {
			seen[token] = true
			out = append(out, token)
		}
	}
	for _, param := range spec.Params {
		switch param.Kind {
		case "enum":
			for _, value := range param.Enum {
				add(value)
			}
		case "path":
			add("path:" + param.Name)
		case "text":
			add("text:" + param.Name)
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}

// permission builds the independent allow-list gate the agent/tools registry
// enforces in front of the harness grant.
func (r *toolRegistry) permission(spec ToolSpec) tools.Permission {
	return tools.Permission{
		Identity:         spec.ID,
		AllowedArguments: permittedArguments(spec),
		AllowedPaths:     append([]string{}, spec.AllowedPaths...),
		MinimumRisk:      spec.MinimumRisk,
	}
}

// scopeDigest binds an approval to the exact requested scope it covers.
func scopeDigest(scope requestedScope) string {
	normalized := scope
	if normalized.PathHints == nil {
		normalized.PathHints = []string{}
	}
	if normalized.ToolCapabilities == nil {
		normalized.ToolCapabilities = []string{}
	}
	raw, err := json.Marshal(normalized)
	if err != nil {
		// The scope is plain strings and an int, so marshaling cannot fail;
		// fail closed rather than approving an unbound scope.
		return "sha256:"
	}
	return "sha256:" + sha256Hex(raw)
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func cleanRelativePath(value string) bool {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return false
	}
	parts := strings.Split(value, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
