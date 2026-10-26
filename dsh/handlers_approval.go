package dsh

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

type approvalActor struct {
	ActorID  string `json:"actor_id"`
	Identity string `json:"identity"`
}

type approvalRequest struct {
	ApprovalID  string        `json:"approval_id"`
	Decision    string        `json:"decision"`
	ApprovedBy  approvalActor `json:"approved_by"`
	ApprovedAt  time.Time     `json:"approved_at"`
	ScopeDigest string        `json:"scope_digest"`
}

type approvalResponse struct {
	State               harness.State `json:"state"`
	AuditEventReference string        `json:"audit_event_reference"`
	Grant               *grantSummary `json:"grant"`
}

func (s *Server) handleApproval(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	if err := rejectForbiddenKeys(body); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	var req approvalRequest
	if err := decodeBody(body, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}
	if req.ApprovalID == "" || req.ApprovedBy.ActorID == "" || req.ApprovedBy.Identity == "" {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest,
			"approval_id and approved_by.actor_id/identity are required.", nil)
		return
	}
	if req.Decision != "approve" && req.Decision != "reject" {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest,
			"decision must be approve or reject.", nil)
		return
	}
	if req.ApprovedAt.IsZero() {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, "approved_at is required.", nil)
		return
	}
	if !s.cfg.authorizedIdentity(req.ApprovedBy.Identity) {
		writeError(w, r, http.StatusForbidden, CodeApproverNotAuthorized,
			"Identity is not authorized to record approvals.", nil)
		return
	}

	now := s.cfg.Now().UTC()
	approvedAt := req.ApprovedAt.UTC()

	rec.mu.Lock()
	if rec.approval != nil {
		rec.mu.Unlock()
		writeError(w, r, http.StatusConflict, CodeApprovalAlreadyRecorded,
			"An approval decision is already recorded for this run.", nil)
		return
	}
	switch rec.run.State {
	case harness.StateApproved:
		rec.mu.Unlock()
		writeError(w, r, http.StatusConflict, CodeApprovalAlreadyRecorded,
			"Run is already approved; no further approval is accepted.", nil)
		return
	case harness.StateRequested:
	default:
		state := rec.run.State
		rec.mu.Unlock()
		writeError(w, r, http.StatusConflict, CodeTaskStateConflict,
			fmt.Sprintf("Run is in state %q; approvals are only accepted in requested.", state),
			map[string]any{"state": string(state)})
		return
	}
	if req.ScopeDigest != rec.scopeDigest {
		scope := rec.scopeDigest
		rec.mu.Unlock()
		writeError(w, r, http.StatusConflict, CodeApprovalScopeMismatch,
			"scope_digest does not match the run's requested scope.",
			map[string]any{"expected_scope_digest": scope})
		return
	}
	if approvedAt.After(now) || approvedAt.Before(rec.created) || now.After(rec.approvalExpiry) {
		rec.mu.Unlock()
		writeError(w, r, http.StatusGone, CodeApprovalWindowExpired,
			"Approval is outside the run's approval window.", nil)
		return
	}

	rec.approval = &recordedApproval{
		approvalID:       req.ApprovalID,
		decision:         req.Decision,
		approverActor:    req.ApprovedBy.ActorID,
		approverIdentity: req.ApprovedBy.Identity,
		approvedAt:       approvedAt,
		scopeDigest:      req.ScopeDigest,
	}

	if req.Decision == "reject" {
		transitionErr := rec.run.Transition(harness.StateRejected, "approval_rejected")
		terminal := harness.IsTerminal(rec.run.State)
		closeErr := rec.closeRunnerLocked()
		auditRef := rec.latestAuditReferenceLocked()
		rec.mu.Unlock()
		s.store.releaseTask(rec, terminal)
		if closeErr != nil {
			writeError(w, r, http.StatusServiceUnavailable, CodeEvidenceStoreUnavailable, closeErr.Error(), nil)
			return
		}
		if transitionErr != nil {
			writeError(w, r, http.StatusServiceUnavailable, CodeEvidenceStoreUnavailable,
				"Rejection could not be evidenced.", nil)
			return
		}
		writeJSON(w, http.StatusOK, approvalResponse{State: harness.StateRejected, AuditEventReference: auditRef})
		return
	}

	// IssueGrant requires the approval to precede issuance; when the client
	// records approval at the same instant as the server clock, issuance is
	// nudged one nanosecond forward instead of refusing a valid decision.
	issuedAt := now
	if !approvedAt.Before(issuedAt) {
		issuedAt = approvedAt.Add(time.Nanosecond)
	}
	params := s.grantParams(rec, issuedAt)
	rec.run.Assessment.ElevatedApprovalReference = &harness.ApprovalReference{
		Reference:        fmt.Sprintf("evidence://grant-approvals/%s", rec.run.RunID),
		ApproverIdentity: req.ApprovedBy.Identity,
		ApprovedAt:       approvedAt,
	}
	approveErr := rec.run.Approve(params)
	if approveErr != nil {
		rec.mu.Unlock()
		if errors.Is(approveErr, harness.ErrProhibitedRisk) {
			writeError(w, r, http.StatusConflict, CodeTaskStateConflict,
				"Prohibited work cannot be granted.", nil)
			return
		}
		writeError(w, r, http.StatusServiceUnavailable, CodeEvidenceStoreUnavailable,
			"Capability grant could not be evidenced.",
			map[string]any{"reason": approveErr.Error()})
		return
	}
	summary := summarizeGrant(rec.run.Grant, rec.scopeDigest)
	state := rec.run.State
	auditRef := rec.latestAuditReferenceLocked()
	rec.mu.Unlock()
	s.store.releaseTask(rec, false)

	writeJSON(w, http.StatusOK, approvalResponse{
		State:               state,
		AuditEventReference: auditRef,
		Grant:               summary,
	})
}

// latestAuditReferenceLocked names the newest event while rec.mu is held.
func (rec *runRecord) latestAuditReferenceLocked() string {
	events := rec.events.Events(rec.run.RunID)
	if len(events) == 0 {
		return ""
	}
	last := events[len(events)-1]
	return fmt.Sprintf("evidence://events/%s/%d", last.RunID, last.Sequence)
}
