package dsh

import (
	"net/http"

	"github.com/Luthiel/AutoFixer/harness"
)

type cancelRequest struct {
	RequestedBy approvalActor `json:"requested_by"`
	Reason      string        `json:"reason"`
}

type cancelResponse struct {
	State                 harness.State `json:"state"`
	CancellationRequested bool          `json:"cancellation_requested"`
	AuditEventReference   string        `json:"audit_event_reference"`
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	if err := rejectForbiddenKeys(body); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	var req cancelRequest
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
		writeError(w, r, http.StatusForbidden, CodeCancellerNotAuthorized,
			"Identity is not authorized to cancel runs.", nil)
		return
	}
	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}

	if state := rec.terminalState(); state != "" {
		writeJSON(w, http.StatusOK, cancelResponse{
			State:                 state,
			CancellationRequested: false,
			AuditEventReference:   rec.latestAuditReference(),
		})
		return
	}

	// A running tool is interrupted first, without holding rec.mu: the
	// dispatch owns that lock while it executes, and its own evidence chain
	// records the cancelled terminal state.
	if rec.hasDispatchInFlight() {
		rec.interruptDispatch()
	}

	rec.mu.Lock()
	if !harness.IsTerminal(rec.run.State) {
		if err := rec.run.Transition(harness.StateCancelled, "cancellation_requested"); err != nil {
			rec.mu.Unlock()
			writeError(w, r, http.StatusServiceUnavailable, CodeCancellationControlFailure,
				"Cancellation could not be evidenced.", map[string]any{"reason": err.Error()})
			return
		}
	}
	state := rec.run.State
	auditRef := rec.latestAuditReferenceLocked()
	closeErr := rec.closeRunnerLocked()
	rec.mu.Unlock()
	s.store.releaseTask(rec, harness.IsTerminal(state))
	if closeErr != nil {
		writeError(w, r, http.StatusServiceUnavailable, CodeCancellationControlFailure,
			closeErr.Error(), nil)
		return
	}
	writeJSON(w, http.StatusAccepted, cancelResponse{
		State:                 state,
		CancellationRequested: true,
		AuditEventReference:   auditRef,
	})
}
