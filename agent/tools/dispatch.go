package tools

import (
	"context"
	"errors"

	"github.com/Luthiel/AutoFixer/sandbox"
)

// Dispatcher is the boundary an authorized call is delivered to. The registry
// never executes a host command itself; implementations forward to the
// existing sandbox/harness policy.
type Dispatcher interface {
	Dispatch(ctx context.Context, call Call) (sandbox.Result, error)
}

// SandboxDispatcher delivers calls to a sandbox.Runner, the existing
// execution boundary. Inside Runner.Execute the FP-03 harness policy decides
// again against the capability grant and writes the evidence chain, so a
// call that clears the registry still runs only within the grant, in the
// one-time credential-free workspace.
type SandboxDispatcher struct {
	runner *sandbox.Runner
}

var _ Dispatcher = (*SandboxDispatcher)(nil)

// NewSandboxDispatcher wraps a run's sandbox runner as the dispatch boundary.
func NewSandboxDispatcher(runner *sandbox.Runner) *SandboxDispatcher {
	return &SandboxDispatcher{runner: runner}
}

// Dispatch converts the declared call scopes into one sandbox spec and hands
// it to the runner unchanged; the grant policy inside the runner is the only
// execution permission.
func (d *SandboxDispatcher) Dispatch(ctx context.Context, call Call) (sandbox.Result, error) {
	if d == nil || d.runner == nil {
		return sandbox.Result{}, errors.New("tools: sandbox dispatcher requires a runner")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return d.runner.Execute(ctx, sandbox.Spec{
		Tool:                call.Tool,
		Arguments:           append([]string{}, call.Arguments...),
		Paths:               append([]string{}, call.Paths...),
		NetworkDestinations: append([]string{}, call.NetworkDestinations...),
	})
}
