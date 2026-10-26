package dsh

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
)

type healthResponse struct {
	Service         string          `json:"service"`
	Status          string          `json:"status"`
	Protocol        protocolInfo    `json:"protocol"`
	ContractVersion string          `json:"contract_version"`
	PolicyVersion   string          `json:"policy_version"`
	Capabilities    map[string]bool `json:"capabilities"`
}

type protocolInfo struct {
	Supported []string `json:"supported"`
	Default   string   `json:"default"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, r, http.StatusMethodNotAllowed, CodeInvalidRequest, "Only GET is supported.", nil)
		return
	}
	if protocol := r.Header.Get(HeaderProtocol); protocol != "" && protocol != ProtocolVersion {
		writeError(w, r, http.StatusUpgradeRequired, CodeProtocolUnsupported,
			fmt.Sprintf("Protocol version %q is unsupported; dsh speaks %q.", protocol, ProtocolVersion), nil)
		return
	}
	writeJSON(w, http.StatusOK, healthResponse{
		Service: serviceName,
		Status:  "ready",
		Protocol: protocolInfo{
			Supported: []string{ProtocolVersion},
			Default:   ProtocolVersion,
		},
		ContractVersion: ContractVersion,
		PolicyVersion:   PolicyVersion,
		Capabilities: map[string]bool{
			"local_transport_only": true,
			"execution_control":    true,
			"event_read":           true,
			"evidence_bundle":      true,
			"provider_write":       false,
		},
	})
}

type executionCounts struct {
	ActionsTotal   int `json:"actions_total"`
	ActionsAllowed int `json:"actions_allowed"`
	ActionsDenied  int `json:"actions_denied"`
}

type grantStatus struct {
	State       string                   `json:"state"` // none | active | revoked | expired
	ScopeDigest string                   `json:"scope_digest"`
	Grant       *harness.CapabilityGrant `json:"grant"`
}

type runResponse struct {
	RunID            string                    `json:"run_id"`
	TaskID           string                    `json:"task_id"`
	IssueID          string                    `json:"issue_id"`
	State            harness.State             `json:"state"`
	RiskAssessment   harness.RiskAssessment    `json:"risk_assessment"`
	GrantStatus      grantStatus               `json:"grant_status"`
	ExecutionCounts  executionCounts           `json:"execution_counts"`
	PatchReport      *delivery.PatchReport     `json:"patch_report"`
	ApprovalSnapshot *harness.ApprovalSnapshot `json:"approval_snapshot"`
	BundleAvailable  bool                      `json:"bundle_available"`
	CreatedAt        time.Time                 `json:"created_at"`
}

func (s *Server) handleGetRun(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}
	now := s.cfg.Now().UTC()
	rec.mu.Lock()
	defer rec.mu.Unlock()

	run := rec.run
	events := rec.events.Events(run.RunID)
	state := run.State
	finalized := bundleFinalized(state)

	response := runResponse{
		RunID:          run.RunID,
		TaskID:         run.TaskID,
		IssueID:        run.IssueID,
		State:          state,
		RiskAssessment: run.Assessment,
		GrantStatus: grantStatus{
			State:       grantState(run, now),
			ScopeDigest: rec.scopeDigest,
			Grant:       copyGrant(run.Grant),
		},
		ExecutionCounts: countExecutions(events),
		BundleAvailable: finalized && assessmentComplete(run.Assessment),
		CreatedAt:       rec.created,
	}
	if finalized {
		if report, err := buildPatchReport(rec, events, now); err == nil {
			response.PatchReport = &report
		}
	}
	snapshot := buildApprovalSnapshot(run, now)
	response.ApprovalSnapshot = &snapshot

	writeJSON(w, http.StatusOK, response)
}

func grantState(run *harness.Run, now time.Time) string {
	if run.Grant == nil {
		return "none"
	}
	switch {
	case !now.Before(run.Grant.ExpiresAt):
		// Expiry outranks revocation: leaving `approved` for `expired`
		// revokes the grant too, but the caller needs the deadline answer.
		return "expired"
	case run.Revoked:
		return "revoked"
	default:
		return "active"
	}
}

func copyGrant(grant *harness.CapabilityGrant) *harness.CapabilityGrant {
	if grant == nil {
		return nil
	}
	copied := *grant
	copied.PermittedPaths = append([]string{}, grant.PermittedPaths...)
	copied.PermittedTools = append([]harness.PermittedTool{}, grant.PermittedTools...)
	copied.NetworkDestinations = append([]string{}, grant.NetworkDestinations...)
	return &copied
}

func countExecutions(events []harness.ExecutionEvent) executionCounts {
	var counts executionCounts
	for _, event := range events {
		if event.EventType != harness.EventTypeToolInvocation || event.DecisionOrStopCode == nil {
			continue
		}
		// Completion events echo the same decision as the dispatch event
		// that started the action; only the dispatch (no output digest)
		// counts as one action attempt.
		if event.OutputDigest != nil {
			continue
		}
		counts.ActionsTotal++
		if *event.DecisionOrStopCode == harness.AllowWithinGrant {
			counts.ActionsAllowed++
		} else {
			counts.ActionsDenied++
		}
	}
	return counts
}

// bundleFinalized reports whether the evidence chain may be assembled. A
// stopped run is finalizable: it is the state a denied or out-of-grant
// dispatch lands in, and the acceptance criteria require a terminal bundle
// for those refusals even though the ADR still allows stopped → cancelled
// or approved afterwards.
func bundleFinalized(state harness.State) bool {
	return harness.IsTerminal(state) || state == harness.StateStopped
}

// assessmentComplete reports whether the risk assessment may appear in a
// finalized evidence bundle: an elevated assessment without its pre-grant
// approval reference is not yet contract-complete.
func assessmentComplete(assessment harness.RiskAssessment) bool {
	if assessment.RiskClass != harness.RiskElevated {
		return true
	}
	return assessment.ElevatedApprovalReference != nil &&
		assessment.ElevatedApprovalReference.Reference != "" &&
		assessment.ElevatedApprovalReference.ApproverIdentity != ""
}

type eventsResponse struct {
	Events            []harness.ExecutionEvent `json:"events"`
	NextAfterSequence int                      `json:"next_after_sequence"`
	HasMore           bool                     `json:"has_more"`
}

const (
	defaultEventLimit = 100
	maxEventLimit     = 1000
)

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}
	after := 0
	if raw := r.URL.Query().Get("after_sequence"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			writeError(w, r, http.StatusBadRequest, CodeInvalidEventCursor,
				"after_sequence must be a non-negative integer.", nil)
			return
		}
		after = parsed
	}
	limit := defaultEventLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxEventLimit {
			writeError(w, r, http.StatusBadRequest, CodeInvalidLimit,
				fmt.Sprintf("limit must be an integer between 1 and %d.", maxEventLimit), nil)
			return
		}
		limit = parsed
	}

	rec.mu.Lock()
	events := rec.events.Events(rec.run.RunID)
	rec.mu.Unlock()

	page := []harness.ExecutionEvent{}
	next := after
	hasMore := false
	for _, event := range events {
		if event.Sequence <= after {
			continue
		}
		if len(page) == limit {
			hasMore = true
			break
		}
		page = append(page, event)
		next = event.Sequence
	}
	writeJSON(w, http.StatusOK, eventsResponse{
		Events:            page,
		NextAfterSequence: next,
		HasMore:           hasMore,
	})
}

type bundleResponse struct {
	RunID  string                  `json:"run_id"`
	State  harness.State           `json:"state"`
	Bundle delivery.EvidenceBundle `json:"bundle"`
}

func (s *Server) handleEvidenceBundle(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}
	bundle, state, requestErr := s.evidenceBundle(rec)
	if requestErr != nil {
		writeError(w, r, requestErr.status, requestErr.code, requestErr.message, requestErr.details)
		return
	}
	rec.mu.Lock()
	runID := rec.run.RunID
	rec.mu.Unlock()
	writeJSON(w, http.StatusOK, bundleResponse{RunID: runID, State: state, Bundle: *bundle})
}

func (s *Server) evidenceBundle(rec *runRecord) (*delivery.EvidenceBundle, harness.State, *requestError) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	state := rec.run.State
	if !bundleFinalized(state) {
		return nil, state, &requestError{
			status:  http.StatusConflict,
			code:    CodeEvidenceBundleNotFinalized,
			message: "Evidence bundle is only available for a stopped or terminal run.",
			details: map[string]any{"state": string(state)},
		}
	}
	if !assessmentComplete(rec.run.Assessment) {
		return nil, state, &requestError{
			status:  http.StatusConflict,
			code:    CodeEvidenceBundleNotFinalized,
			message: "Elevated run has no recorded approval, so its assessment is not finalizable.",
			details: map[string]any{"reason": "approval_reference_missing", "state": string(state)},
		}
	}
	events := rec.events.Events(rec.run.RunID)
	bundle, err := buildEvidenceBundle(rec, events, s.cfg.Now().UTC())
	if err != nil {
		return nil, state, &requestError{
			status:  http.StatusServiceUnavailable,
			code:    CodeEvidenceStoreUnavailable,
			message: "Evidence bundle could not be assembled.",
			details: map[string]any{"reason": err.Error()},
		}
	}
	return bundle, state, nil
}

type artifactResponse struct {
	RunID        string         `json:"run_id"`
	ArtifactType string         `json:"artifact_type"`
	Digest       harness.Digest `json:"digest"`
	Content      any            `json:"content"`
}

func (s *Server) handleArtifact(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.store.get(r.PathValue("run_id"))
	if !ok {
		writeError(w, r, http.StatusNotFound, CodeRunNotFound, "Run not found.", nil)
		return
	}
	artifactID := r.PathValue("artifact_id")
	switch artifactID {
	case "patch_diff", "validation_summary":
		rec.mu.Lock()
		finalized := bundleFinalized(rec.run.State)
		rec.mu.Unlock()
		if !finalized {
			writeError(w, r, http.StatusConflict, CodeArtifactNotFinalized,
				"Artifact is not available for a non-terminal run.", nil)
			return
		}
		// These artifacts are only produced by a delivery step outside the
		// local control plane; a finalized run has simply never had one,
		// so the contract's 404 ARTIFACT_NOT_FOUND is the truthful answer.
		writeError(w, r, http.StatusNotFound, CodeArtifactNotFound,
			fmt.Sprintf("Artifact %q is not produced by the local control plane.", artifactID), nil)
		return
	case "patch_report":
		rec.mu.Lock()
		state := rec.run.State
		var content any
		var requestErr *requestError
		if !bundleFinalized(state) {
			requestErr = &requestError{
				status:  http.StatusConflict,
				code:    CodeArtifactNotFinalized,
				message: "Patch report is only available for a stopped or terminal run.",
			}
		} else {
			events := rec.events.Events(rec.run.RunID)
			report, err := buildPatchReport(rec, events, s.cfg.Now().UTC())
			if err != nil {
				requestErr = &requestError{
					status:  http.StatusServiceUnavailable,
					code:    CodeEvidenceStoreUnavailable,
					message: "Patch report could not be assembled.",
				}
			} else {
				content = report
			}
		}
		rec.mu.Unlock()
		if requestErr != nil {
			writeError(w, r, requestErr.status, requestErr.code, requestErr.message, requestErr.details)
			return
		}
		s.writeArtifact(w, r, rec, artifactID, content)
		return
	case "evidence_bundle":
		bundle, _, requestErr := s.evidenceBundle(rec)
		if requestErr != nil {
			if requestErr.code == CodeEvidenceBundleNotFinalized {
				requestErr.code = CodeArtifactNotFinalized
			}
			writeError(w, r, requestErr.status, requestErr.code, requestErr.message, requestErr.details)
			return
		}
		s.writeArtifact(w, r, rec, artifactID, bundle)
		return
	case "redacted_execution_log":
		rec.mu.Lock()
		events := rec.events.Events(rec.run.RunID)
		rec.mu.Unlock()
		if len(events) == 0 {
			writeError(w, r, http.StatusConflict, CodeArtifactNotFinalized,
				"No execution evidence exists for this run yet.", nil)
			return
		}
		s.writeArtifact(w, r, rec, artifactID, executionLogFrom(events))
		return
	default:
		writeError(w, r, http.StatusNotFound, CodeArtifactNotFound,
			fmt.Sprintf("Artifact %q does not exist.", artifactID), nil)
		return
	}
}

func (s *Server) writeArtifact(w http.ResponseWriter, r *http.Request, rec *runRecord, artifactID string, content any) {
	raw, err := marshalCanonical(content)
	if err != nil {
		writeError(w, r, http.StatusServiceUnavailable, CodeEvidenceStoreUnavailable,
			"Artifact could not be encoded.", nil)
		return
	}
	writeJSON(w, http.StatusOK, artifactResponse{
		RunID:        rec.id(),
		ArtifactType: artifactID,
		Digest: harness.Digest{
			Algorithm: harness.DigestAlgorithmSHA256,
			Value:     sha256Hex(raw),
		},
		Content: content,
	})
}
