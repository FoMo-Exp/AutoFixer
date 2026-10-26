package dsh

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/Luthiel/AutoFixer/agent/tools"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

type actionAgent struct {
	Runtime   string `json:"runtime"`
	SessionID string `json:"session_id"`
	TurnID    string `json:"turn_id"`
}

type actionIntent struct {
	ToolID              string          `json:"tool_id"`
	Arguments           json.RawMessage `json:"arguments"`
	PathScope           []string        `json:"path_scope"`
	NetworkDestinations []string        `json:"network_destinations"`
	Rationale           string          `json:"rationale"`
}

type actionRequest struct {
	ActionID string       `json:"action_id"`
	Agent    actionAgent  `json:"agent"`
	Intent   actionIntent `json:"intent"`
}

type actionResponse struct {
	ActionID            string        `json:"action_id"`
	State               harness.State `json:"state"`
	AcceptedToolID      string        `json:"accepted_tool_id"`
	AuditEventReference string        `json:"audit_event_reference"`
}

type invalidIntentError struct {
	code    string
	message string
}

func (e *invalidIntentError) Error() string { return e.message }

func (s *Server) handleSubmitAction(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	if err := rejectForbiddenKeys(body); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	var req actionRequest
	if err := decodeBody(body, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	arguments, intentErr := validateIntent(req)
	if intentErr != nil {
		writeError(w, r, http.StatusBadRequest, intentErr.code, intentErr.message, nil)
		return
	}

	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}

	// Busy is answered before any run-lock work: a second action must fail
	// fast with DSH_RUN_BUSY instead of queueing behind the execution that
	// currently holds the run lock.
	if rec.isBusy() {
		writeError(w, r, http.StatusTooManyRequests, CodeRunBusy,
			"Another action is still executing for this run.", nil)
		return
	}

	if requestErr := s.checkActionState(rec); requestErr != nil {
		writeError(w, r, requestErr.status, requestErr.code, requestErr.message, requestErr.details)
		return
	}
	if requestErr := s.expireGrantIfDue(rec); requestErr != nil {
		writeError(w, r, requestErr.status, requestErr.code, requestErr.message, requestErr.details)
		return
	}

	spec, registered := s.tools.get(req.Intent.ToolID)
	if !registered {
		s.recordRegistryDenial(rec, req, nil)
		writeError(w, r, http.StatusNotFound, CodeToolNotRegistered,
			fmt.Sprintf("Tool %q is not registered.", req.Intent.ToolID), nil)
		return
	}
	argv, argErr := s.tools.validateArguments(spec.ID, arguments)
	if argErr != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidToolArguments, argErr.Error(), nil)
		return
	}

	// The cancel context is armed inside dispatchSlot, in the same critical
	// section as the busy flag, so a cancel that lands the instant the slot
	// is taken still interrupts the dispatch.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release, busy := rec.dispatchSlot(cancel)
	if busy {
		writeError(w, r, http.StatusTooManyRequests, CodeRunBusy,
			"Another action is still executing for this run.", nil)
		return
	}
	defer release()

	rec.mu.Lock()
	defer rec.mu.Unlock()

	// Re-check under the run lock: an approval, cancellation, or stop may
	// have landed between the fast path and acquiring the dispatch slot.
	// No action id has been consumed yet, so nothing needs releasing.
	switch rec.run.State {
	case harness.StateApproved, harness.StateRunning:
	default:
		state := rec.run.State
		writeError(w, r, http.StatusConflict, CodeTaskStateConflict,
			fmt.Sprintf("Run is in state %q.", state), map[string]any{"state": string(state)})
		return
	}

	// The sandbox runner and its registry are composed first: the registry
	// is the independent allow-list gate that runs before harness policy.
	executor, err := s.executorFor(rec)
	if err != nil {
		writeError(w, r, http.StatusServiceUnavailable, CodeSandboxUnavailable,
			"Sandbox workspace could not be prepared.", nil)
		return
	}

	// The action id is consumed only once this request owns the dispatch
	// slot and a runnable executor, so a busy or state rejection never
	// burns a client's action_id. The caller holds rec.mu.
	if rec.actionIDs[req.ActionID] {
		writeError(w, r, http.StatusConflict, CodeActionAlreadySubmitted,
			"action_id has already been submitted for this run.", nil)
		return
	}
	rec.actionIDs[req.ActionID] = true

	registryDecision := rec.registryAuthorize(spec, req, argv)
	if !registryDecision.Allowed {
		decision := rec.run.EvaluateAndRecordAction(s.actionRequest(rec, spec, req, argv))
		s.store.releaseTask(rec, harness.IsTerminal(rec.run.State))
		_ = rec.closeRunnerLocked()
		writeError(w, r, http.StatusForbidden, CodeToolNotAllowlisted,
			registryDecision.Reason,
			map[string]any{
				"registry_decision": registryDecision.Code,
				"harness_decision":  decision.Code,
			})
		return
	}

	result, execErr := executor.Execute(ctx, sandbox.Spec{
		Tool:                spec.Exec,
		Arguments:           argv,
		Paths:               append([]string{}, req.Intent.PathScope...),
		NetworkDestinations: append([]string{}, req.Intent.NetworkDestinations...),
	})
	s.store.releaseTask(rec, harness.IsTerminal(rec.run.State))
	closeErr := rec.closeRunnerLocked()

	if execErr != nil {
		writeError(w, r, http.StatusServiceUnavailable, CodeSandboxUnavailable,
			"Tool dispatch failed before an outcome could be recorded.", nil)
		return
	}
	if closeErr != nil {
		writeError(w, r, http.StatusServiceUnavailable, CodeSandboxUnavailable,
			"Sandbox workspace could not be torn down.", nil)
		return
	}
	if !result.Decision.Allowed {
		status, code := mapHarnessDenial(result.Decision)
		writeError(w, r, status, code, "Action is outside the approved grant.",
			map[string]any{
				"decision":  result.Decision.Code,
				"stop_code": result.Decision.StopCode,
			})
		return
	}
	writeJSON(w, http.StatusAccepted, actionResponse{
		ActionID:            req.ActionID,
		State:               rec.run.State,
		AcceptedToolID:      spec.ID,
		AuditEventReference: rec.latestAuditReferenceLocked(),
	})
}

// checkActionState applies the contract's state gate before any dispatch
// bookkeeping: terminal and non-dispatchable states conflict, a run still
// awaiting approval requires approval first.
func (s *Server) checkActionState(rec *runRecord) *requestError {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	state := rec.run.State
	switch {
	case harness.IsTerminal(state):
		return &requestError{
			status:  http.StatusConflict,
			code:    CodeTaskStateConflict,
			message: fmt.Sprintf("Run is in terminal state %q.", state),
			details: map[string]any{"state": string(state)},
		}
	case state == harness.StateRequested:
		return &requestError{
			status:  http.StatusPreconditionRequired,
			code:    CodeApprovalRequired,
			message: "Run requires an approved capability grant before actions are accepted.",
		}
	case state != harness.StateApproved && state != harness.StateRunning:
		return &requestError{
			status:  http.StatusConflict,
			code:    CodeTaskStateConflict,
			message: fmt.Sprintf("Run is in state %q; actions are only accepted while approved or running.", state),
			details: map[string]any{"state": string(state)},
		}
	}
	return nil
}

// validateIntent enforces the structured action contract: an action id, a
// runtime, a tool id, a JSON object of arguments, and clean relative path
// scope. Shell, argv, grant, and risk-class vocabulary is refused earlier by
// rejectForbiddenKeys, so an intent can only ever name structured tools.
func validateIntent(req actionRequest) (map[string]any, *invalidIntentError) {
	fail := func(code, message string) (map[string]any, *invalidIntentError) {
		return nil, &invalidIntentError{code: code, message: message}
	}
	if req.ActionID == "" {
		return fail(CodeInvalidActionIntent, "action_id is required")
	}
	if req.Agent.Runtime == "" {
		return fail(CodeInvalidActionIntent, "agent.runtime is required")
	}
	if req.Intent.ToolID == "" {
		return fail(CodeInvalidActionIntent, "intent.tool_id is required")
	}
	// Missing scope means denied: an action must name the repository paths
	// it touches, so an empty path_scope cannot slip past the grant's
	// path checks by never being checked.
	if len(req.Intent.PathScope) == 0 {
		return fail(CodeInvalidActionIntent,
			"intent.path_scope must name at least one repository-relative path")
	}
	arguments := map[string]any{}
	if len(req.Intent.Arguments) > 0 && string(req.Intent.Arguments) != "null" {
		if err := json.Unmarshal(req.Intent.Arguments, &arguments); err != nil {
			return fail(CodeInvalidToolArguments, "intent.arguments must be a JSON object")
		}
	}
	for _, path := range req.Intent.PathScope {
		if !cleanRelativePath(path) {
			return fail(CodeInvalidActionIntent,
				fmt.Sprintf("intent.path_scope entry %q must be a relative repository path", path))
		}
	}
	for _, destination := range req.Intent.NetworkDestinations {
		if destination == "" {
			return fail(CodeInvalidActionIntent, "intent.network_destinations must not contain empty entries")
		}
	}
	return arguments, nil
}

func (s *Server) actionRequest(rec *runRecord, spec ToolSpec, req actionRequest, argv []string) harness.ActionRequest {
	return harness.ActionRequest{
		Tool:                spec.ID,
		Arguments:           append([]string{}, argv...),
		RepositoryURL:       rec.run.RepositoryURL,
		BaseSHA:             rec.run.BaseSHA,
		Paths:               append([]string{}, req.Intent.PathScope...),
		NetworkDestinations: append([]string{}, req.Intent.NetworkDestinations...),
	}
}

// recordRegistryDenial appends the harness-side refusal for a tool the
// allow-list registry would reject, so an over-privileged attempt leaves the
// same continuous evidence chain as a policy denial.
func (s *Server) recordRegistryDenial(rec *runRecord, req actionRequest, argv []string) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	rec.run.EvaluateAndRecordAction(harness.ActionRequest{
		Tool:                req.Intent.ToolID,
		Arguments:           append([]string{}, argv...),
		RepositoryURL:       rec.run.RepositoryURL,
		BaseSHA:             rec.run.BaseSHA,
		Paths:               append([]string{}, req.Intent.PathScope...),
		NetworkDestinations: append([]string{}, req.Intent.NetworkDestinations...),
	})
	s.store.releaseTask(rec, harness.IsTerminal(rec.run.State))
	_ = rec.closeRunnerLocked()
}

// registryAuthorize is the independent allow-list gate in front of the
// harness grant. Its checks mirror the harness rules (same enum arguments,
// same relative-path containment, tools that never demand more risk than the
// run was assessed), so a registry denial coincides with a harness denial
// and the evidence chain agrees with the HTTP response. The caller holds
// rec.mu.
func (rec *runRecord) registryAuthorize(spec ToolSpec, req actionRequest, argv []string) tools.Decision {
	if rec.registry == nil {
		return tools.Decision{Allowed: false, Code: tools.DenyNoDispatcher, Reason: "no tool registry is configured"}
	}
	return rec.registry.Authorize(tools.Request{
		TaskID:    rec.run.TaskID,
		RunID:     rec.run.RunID,
		RiskClass: rec.run.Assessment.RiskClass,
		Call: tools.Call{
			Tool:                spec.ID,
			Arguments:           append([]string{}, argv...),
			Paths:               append([]string{}, req.Intent.PathScope...),
			NetworkDestinations: append([]string{}, req.Intent.NetworkDestinations...),
		},
	})
}

// executorFor lazily composes the sandbox runner and its registry for this
// run, mirroring the CLI composition: registry allow-list first, then the
// sandbox where harness FP-03 policy decides again against the grant. The
// caller holds rec.mu.
func (s *Server) executorFor(rec *runRecord) (*sandbox.Runner, error) {
	if rec.runner != nil {
		return rec.runner, nil
	}
	runner, err := sandbox.New(rec.run, sandbox.Options{WorkspaceRoot: s.cfg.WorkspaceRoot})
	if err != nil {
		return nil, err
	}
	registry := tools.NewRegistry(tools.WithDispatcher(tools.NewSandboxDispatcher(runner)))
	for _, id := range s.tools.ids() {
		spec, _ := s.tools.get(id)
		if err := registry.Register(s.tools.permission(spec)); err != nil {
			_ = runner.Close()
			return nil, fmt.Errorf("register tool %q: %w", id, err)
		}
	}
	rec.runner = runner
	rec.registry = registry
	return runner, nil
}

// expireGrantIfDue turns an idle approved run whose grant has lapsed into
// `expired` and reports the 410 the contract requires.
func (s *Server) expireGrantIfDue(rec *runRecord) *requestError {
	now := s.cfg.Now().UTC()
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.run.Grant == nil || rec.run.Revoked {
		return nil
	}
	if now.Before(rec.run.Grant.ExpiresAt) {
		return nil
	}
	if rec.run.State == harness.StateApproved {
		if err := rec.run.Transition(harness.StateExpired, harness.StopCodeGrantExpired); err != nil {
			return &requestError{
				status:  http.StatusServiceUnavailable,
				code:    CodeEvidenceStoreUnavailable,
				message: "Grant expiry could not be evidenced.",
			}
		}
		s.store.releaseTask(rec, true)
		_ = rec.closeRunnerLocked()
	}
	return &requestError{
		status:  http.StatusGone,
		code:    CodeGrantExpired,
		message: "Capability grant has expired.",
	}
}

// mapHarnessDenial translates a harness FP-03 denial into the contract's
// status and code vocabulary.
func mapHarnessDenial(decision harness.Decision) (int, string) {
	switch decision.Code {
	case harness.DenyGrantExpired, harness.StopCodeGrantExpired:
		return http.StatusGone, CodeGrantExpired
	case harness.DenyGrantRevoked:
		return http.StatusGone, CodeGrantRevoked
	case harness.DenyGrantMissing:
		return http.StatusPreconditionRequired, CodeApprovalRequired
	case harness.DenyStateNotRunning, harness.DenyStateTransitionForbidden:
		return http.StatusConflict, CodeTaskStateConflict
	default:
		return http.StatusForbidden, CodeScopeDenied
	}
}
