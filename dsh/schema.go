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

// ParamSpec is one structured argument of a registered tool. Parameters with
// an Enum are the only values a capability grant can carry: the harness grant
// allow-lists arguments exactly, so free-form values cannot be granted
// ahead of time. Path-typed intent is declared separately in
// `intent.path_scope` and checked against the grant's permitted paths.
type ParamSpec struct {
	Name     string   `json:"name"`
	Type     string   `json:"type"` // "string" | "path"
	Enum     []string `json:"enum,omitempty"`
	Required bool     `json:"required"`
}

// ToolSpec is one registered tool: its structured schema, the sandbox binary
// identity it dispatches to, and the independent allow-list metadata the
// registry enforces in front of the harness grant.
type ToolSpec struct {
	ID           string
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

// defaultToolSpecs is the M1 composition's registered tool surface: enum-only
// structured schemas over binaries the sandbox can prove on its PATH. Raw
// shell and argv identities (sh, bash, git, ...) are deliberately absent.
func defaultToolSpecs() []ToolSpec {
	return []ToolSpec{
		{
			ID:           "echo",
			Exec:         "echo",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "message", Type: "string", Enum: []string{"hello"}, Required: true},
			},
		},
		{
			ID:           "sleep",
			Exec:         "sleep",
			MinimumRisk:  harness.RiskLow,
			AllowedPaths: []string{"."},
			Params: []ParamSpec{
				{Name: "seconds", Type: "string", Enum: []string{"5"}, Required: true},
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

// validateArguments checks a structured argument object against the tool's
// schema and returns the argv the sandbox will execute. Every value must be
// an allowed enum member, so the returned argv is always grant-checkable.
func (r *toolRegistry) validateArguments(id string, raw map[string]any) ([]string, error) {
	spec, ok := r.specs[id]
	if !ok {
		return nil, fmt.Errorf("tool %q is not registered", id)
	}
	seen := map[string]bool{}
	argv := make([]string, 0, len(spec.Params))
	for _, param := range spec.Params {
		value, present := raw[param.Name]
		if !present {
			if param.Required {
				return nil, fmt.Errorf("tool %q requires argument %q", id, param.Name)
			}
			continue
		}
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("tool %q argument %q must be a string", id, param.Name)
		}
		if text == "" {
			return nil, fmt.Errorf("tool %q argument %q must not be empty", id, param.Name)
		}
		if len(param.Enum) > 0 && !contains(param.Enum, text) {
			return nil, fmt.Errorf("tool %q argument %q must be one of %s", id, param.Name, strings.Join(param.Enum, ", "))
		}
		if param.Type == "path" && !cleanRelativePath(text) {
			return nil, fmt.Errorf("tool %q argument %q must be a relative repository path", id, param.Name)
		}
		seen[param.Name] = true
		argv = append(argv, text)
	}
	for name := range raw {
		if !seen[name] && !paramExists(spec, name) {
			return nil, fmt.Errorf("tool %q does not declare argument %q", id, name)
		}
	}
	return argv, nil
}

func paramExists(spec ToolSpec, name string) bool {
	for _, param := range spec.Params {
		if param.Name == name {
			return true
		}
	}
	return false
}

// permittedArguments is the grant allow-list for one tool: the union of its
// enum values. Harness policy matches arguments exactly, so a value outside
// this set can never be granted.
func permittedArguments(spec ToolSpec) []string {
	seen := map[string]bool{}
	var out []string
	for _, param := range spec.Params {
		for _, value := range param.Enum {
			if !seen[value] {
				seen[value] = true
				out = append(out, value)
			}
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
