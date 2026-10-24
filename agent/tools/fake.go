package tools

import (
	"context"
	"sync"

	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// FakeToolIdentity is the identity of the prototype's offline fake tool.
// Registered via FakeToolPermissions and dispatched by FakeDispatcher, it
// lets the task loop and integration tests exercise success and denial paths
// with no host process, network, or credential involved.
const FakeToolIdentity = "fake-tool"

// FakeToolPermissions returns the permission metadata for FakeToolIdentity:
// one allowed argument, repository-scope paths, no network destinations, and
// a low minimum risk class.
func FakeToolPermissions() []Permission {
	return []Permission{{
		Identity:                   FakeToolIdentity,
		AllowedArguments:           []string{"--ok"},
		AllowedPaths:               []string{"."},
		AllowedNetworkDestinations: []string{},
		MinimumRisk:                harness.RiskLow,
	}}
}

// FakeDispatcher is the offline dispatch boundary: it records every call it
// receives and returns scripted results without touching a host process. An
// unscripted tool defaults to an allowed, zero-exit result so success paths
// need no setup; SetResult scripts denials, evidence, or failures per tool
// identity.
type FakeDispatcher struct {
	mu      sync.Mutex
	calls   []Call
	results map[string]fakeDispatch
}

type fakeDispatch struct {
	result sandbox.Result
	err    error
}

var _ Dispatcher = (*FakeDispatcher)(nil)

// NewFakeDispatcher builds the fake boundary with no scripted results.
func NewFakeDispatcher() *FakeDispatcher {
	return &FakeDispatcher{results: map[string]fakeDispatch{}}
}

// SetResult scripts the result Dispatch returns for one tool identity,
// including its error.
func (d *FakeDispatcher) SetResult(tool string, res sandbox.Result, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.results[tool] = fakeDispatch{result: res, err: err}
}

// Calls returns a copy of the calls dispatched so far, in order.
func (d *FakeDispatcher) Calls() []Call {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Call, len(d.calls))
	for i, c := range d.calls {
		out[i] = copyCall(c)
	}
	return out
}

// Dispatch implements Dispatcher.
func (d *FakeDispatcher) Dispatch(ctx context.Context, call Call) (sandbox.Result, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, copyCall(call))
	if scripted, ok := d.results[call.Tool]; ok {
		return scripted.result, scripted.err
	}
	exit := 0
	return sandbox.Result{
		Decision:   harness.Decision{Allowed: true, Code: harness.AllowWithinGrant},
		ExitStatus: &exit,
	}, nil
}

// copyCall recreates a call with fresh argument, path, and destination
// slices so the registry and the fake never share backing arrays with their
// callers.
func copyCall(call Call) Call {
	return Call{
		Tool:                call.Tool,
		Arguments:           copyStrings(call.Arguments),
		Paths:               copyStrings(call.Paths),
		NetworkDestinations: copyStrings(call.NetworkDestinations),
	}
}

// copyStrings copies a string slice, preserving the nil/empty distinction.
func copyStrings(in []string) []string {
	if in == nil {
		return nil
	}
	return append([]string{}, in...)
}
