package harness

import (
	"errors"
	"fmt"
)

// ExecutionOutcome is the observed result of one allowed tool execution: the
// exit status the runner observed, the digest of the redacted output, and the
// code recorded on the completion event.
type ExecutionOutcome struct {
	// ExitStatus is the observed exit status. It is nil only when the
	// process ran but no exit status could be observed.
	ExitStatus *int
	// OutputDigest names the algorithm and digest of the redacted output
	// the execution produced; it is required because this record exists
	// only for executions that ran.
	OutputDigest *Digest
	// Code records the outcome: AllowWithinGrant for a completed
	// execution, or the sandbox's termination code for an execution ended
	// by wall-clock timeout or cancellation. Empty defaults to
	// AllowWithinGrant.
	Code string
}

// RecordExecutionOutcome appends the completion evidence for an execution
// that EvaluateAndRecordAction already permitted and recorded: a second
// tool-invocation event carrying the same requested and actual tool plus the
// observed exit status and redacted output digest. The dispatch event keeps
// a null exit status because no tool had run when it was written; this
// event answers it with the observed result, so an allowed dispatch and its
// outcome are two distinct, individually digested records in the chain.
//
// It fails closed exactly as dispatch recording does: an audit-write failure
// revokes the grant so no further dispatch can proceed unevidenced.
func (r *Run) RecordExecutionOutcome(req ActionRequest, out ExecutionOutcome) error {
	if out.OutputDigest == nil || out.OutputDigest.Algorithm == "" || out.OutputDigest.Value == "" {
		return errors.New("harness: execution outcome requires a named output digest")
	}
	ev := r.baseEvent(EventTypeToolInvocation, r.State, r.State)
	ev.RequestedTool = &ToolRecord{
		Identity:  req.Tool,
		Arguments: append([]string{}, req.Arguments...),
	}
	ev.ActualTool = &ToolRecord{
		Identity:  req.Tool,
		Arguments: append([]string{}, req.Arguments...),
	}
	if out.ExitStatus != nil {
		status := *out.ExitStatus
		ev.ExitStatus = &status
	}
	digest := *out.OutputDigest
	ev.OutputDigest = &digest
	code := out.Code
	if code == "" {
		code = AllowWithinGrant
	}
	ev.DecisionOrStopCode = &code

	if _, err := r.store.Append(ev); err != nil {
		// Control failure: the observed result cannot be evidenced, so
		// block further dispatch immediately, mirroring a failed dispatch
		// write.
		r.Revoked = true
		return fmt.Errorf("harness: audit write failed while recording the execution outcome, dispatch revoked: %w", err)
	}
	return nil
}
