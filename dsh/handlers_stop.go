package dsh

import (
	"net/http"

	"github.com/Luthiel/AutoFixer/harness"
)

// Complete local preparation (DAT-258).
//
// A preparation run ends in one of two truthful ways. If it still holds an
// active dispatch it is busy and cannot be frozen; if it already reached a
// terminal state, that state is the answer. Otherwise the orchestrator's
// completion signal stops the run: the grant is revoked, the prepared change
// is frozen from the still-live workspace, and the run reports `stopped`.
//
// This is deliberately not a cancel. Cancellation discards the preparation and
// reports `cancelled`; completion preserves the change as a candidate revision.
// A run that never dispatched anything has nothing to preserve, so completing
// it cancels it with `stop_preparation_empty` instead of claiming it ran.

type stopRequest struct {
	RequestedBy approvalActor `json:"requested_by"`
	Reason      string        `json:"reason"`
}

type stopResponse struct {
	State               harness.State `json:"state"`
	Stopped             bool          `json:"stopped"`
	Prepared            bool          `json:"prepared"`
	AuditEventReference string        `json:"audit_event_reference"`
}

func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	if err := rejectForbiddenKeys(body); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	var req stopRequest
	if err := decodeBody(body, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	if req.RequestedBy.ActorID == "" || req.RequestedBy.Identity == "" {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest,
			"requested_by.actor_id and requested_by.identity are required.", nil)
		return
	}
	if !s.cfg.authorizedIdentity(req.RequestedBy.Identity) {
		writeError(w, r, http.StatusForbidden, CodeApproverNotAuthorized,
			"Identity is not authorized to stop runs.", nil)
		return
	}
	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}

	// Completion is idempotent: a retried stop observes the existing
	// completed state and its frozen revision instead of failing or freezing
	// a second time. Any other terminal state is not a completion and keeps
	// its truthful answer.
	rec.mu.Lock()
	current := rec.run.State
	if current == harness.StateStopped {
		alreadyPrepared := rec.prepared
		rec.mu.Unlock()
		writeJSON(w, http.StatusOK, stopResponse{
			State:               current,
			Stopped:             true,
			Prepared:            alreadyPrepared,
			AuditEventReference: rec.latestAuditReference(),
		})
		return
	}
	rec.mu.Unlock()
	if harness.IsTerminal(current) {
		writeError(w, r, http.StatusConflict, CodeTaskStateConflict,
			"The run already ended in a terminal state that is not a completion.",
			map[string]any{"state": string(current)})
		return
	}
	// A running dispatch owns the run lock and must finish its own evidence
	// first. Completion is a quiescent point, never an interrupt.
	if rec.hasDispatchInFlight() {
		writeError(w, r, http.StatusTooManyRequests, CodeRunBusy,
			"A tool execution is still in flight for this run.", nil)
		return
	}

	rec.mu.Lock()
	state := rec.run.State
	var transitionErr error
	stopped := false
	switch state {
	case harness.StateStopped:
		// A concurrent stop completed between the check above and this lock:
		// observe it instead of treating the run as un-completable.
		prepared := rec.prepared
		rec.mu.Unlock()
		writeJSON(w, http.StatusOK, stopResponse{
			State:               harness.StateStopped,
			Stopped:             true,
			Prepared:            prepared,
			AuditEventReference: rec.latestAuditReference(),
		})
		return
	case harness.StateRunning, harness.StateAwaitingReview:
		transitionErr = rec.run.Transition(harness.StateStopped, harness.StopCodePreparationCompleted)
		stopped = transitionErr == nil
	case harness.StateApproved:
		// Nothing executed under the grant, so no revision exists to freeze.
		// Cancellation is the truthful outcome.
		transitionErr = rec.run.Transition(harness.StateCancelled, harness.StopCodePreparationEmpty)
	default:
		rec.mu.Unlock()
		writeError(w, r, http.StatusConflict, CodeTaskStateConflict,
			"The run is not in a state that can complete local preparation.",
			map[string]any{"state": string(state)})
		return
	}
	if transitionErr != nil {
		rec.mu.Unlock()
		writeError(w, r, http.StatusServiceUnavailable, CodeStopControlFailure,
			"Run completion could not be evidenced.", map[string]any{"reason": transitionErr.Error()})
		return
	}
	state = rec.run.State
	closeErr := rec.closeRunnerLocked()
	// closeRunnerLocked freezes the prepared change, so the binding event (if
	// any) is part of the chain this response points at.
	prepared := rec.prepared
	auditRef := rec.latestAuditReferenceLocked()
	rec.mu.Unlock()
	s.store.releaseTask(rec, harness.IsTerminal(state))
	if closeErr != nil {
		writeError(w, r, http.StatusServiceUnavailable, CodeStopControlFailure,
			closeErr.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, stopResponse{
		State:               state,
		Stopped:             stopped,
		Prepared:            prepared,
		AuditEventReference: auditRef,
	})
}
