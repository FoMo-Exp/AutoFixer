package dsh

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
)

const executionIdentity = "dsh-control/v1"

var (
	repositoryIDPattern = regexp.MustCompile(`^github:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$`)
	baseSHAPattern      = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)
	githubURLPattern    = regexp.MustCompile(`^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$`)
)

type grantSummary struct {
	CapabilityGrantVersion string                  `json:"capability_grant_version"`
	IssuedAt               time.Time               `json:"issued_at"`
	ExpiresAt              time.Time               `json:"expires_at"`
	PermittedPaths         []string                `json:"permitted_paths"`
	PermittedTools         []harness.PermittedTool `json:"permitted_tools"`
	MaxWallClockSeconds    int                     `json:"max_wall_clock_seconds"`
	ScopeDigest            string                  `json:"scope_digest"`
}

type requiredAction struct {
	Type        string `json:"type"`
	ScopeDigest string `json:"scope_digest"`
}

type createRunResponse struct {
	RunID          string                 `json:"run_id"`
	State          harness.State          `json:"state"`
	RiskAssessment harness.RiskAssessment `json:"risk_assessment"`
	Grant          *grantSummary          `json:"grant"`
	RequiredAction *requiredAction        `json:"required_action"`
}

func summarizeGrant(grant *harness.CapabilityGrant, scopeDigest string) *grantSummary {
	if grant == nil {
		return nil
	}
	return &grantSummary{
		CapabilityGrantVersion: grant.CapabilityGrantVersion,
		IssuedAt:               grant.IssuedAt,
		ExpiresAt:              grant.ExpiresAt,
		PermittedPaths:         append([]string{}, grant.PermittedPaths...),
		PermittedTools:         append([]harness.PermittedTool{}, grant.PermittedTools...),
		MaxWallClockSeconds:    grant.MaxWallClockSeconds,
		ScopeDigest:            scopeDigest,
	}
}

func (s *Server) handleCreateRun(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	if err := rejectForbiddenKeys(body); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	var req createRequest
	if err := decodeBody(body, &req); err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	if err := validateCreateRequest(&req); err != nil {
		writeError(w, r, http.StatusBadRequest, err.code, err.message, nil)
		return
	}

	now := s.cfg.Now().UTC()
	runID := s.cfg.NewID("run_")
	taskID := req.TaskID
	scope := normalizeScope(req.RequestedScope)

	class, decisionCode := harness.AssessRisk(req.ProposedWork.toHarness())
	assessmentInput := harness.RiskAssessmentInput{
		TaskID:             taskID,
		RunID:              runID,
		AssessedAt:         now,
		AssessorIdentity:   "dsh",
		RationaleReference: "evidence://risk/" + taskID,
	}

	var assessment harness.RiskAssessment
	switch class {
	case harness.RiskProhibited, harness.RiskLow:
		assessment, err = harness.NewRiskAssessment(assessmentInput, class, decisionCode, nil)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, CodeUnavailable,
				"Risk assessment could not be recorded.", nil)
			return
		}
	case harness.RiskElevated:
		// The approval that completes an elevated assessment arrives later
		// through POST /v1/runs/{run_id}/approvals; until then the record
		// carries an explicit null reference and the run stays in
		// `requested`, not executable.
		assessment = provisionalElevatedAssessment(assessmentInput, decisionCode)
	}

	run, err := harness.NewRun(harness.RunConfig{
		TaskID:            taskID,
		RunID:             runID,
		IssueID:           req.Issue.ExternalID,
		ActorIdentity:     req.Request.RequestedBy.ActorID,
		ExecutionIdentity: executionIdentity,
		RepositoryURL:     req.Repository.URL,
		BaseSHA:           req.Repository.BaseSHA,
	}, assessment, s.events)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}

	rec := &runRecord{
		run:            run,
		events:         s.events,
		created:        now,
		summary:        strings.TrimSpace(req.Request.Summary),
		sourceRef:      req.Issue.SourceReference,
		issueID:        req.Issue.ExternalID,
		requestedBy:    req.Request.RequestedBy.ActorID,
		scope:          scope,
		scopeDigest:    scopeDigest(scope),
		repository:     req.Repository,
		issue:          req.Issue,
		approvalExpiry: now.Add(s.cfg.ApprovalWindow),
		actionIDs:      map[string]bool{},
	}

	if err := s.store.claimTask(taskID, runID); err != nil {
		writeError(w, r, http.StatusConflict, CodeTaskAlreadyHasActiveRun,
			"The task already has an active run.", map[string]any{"task_id": taskID})
		return
	}
	s.store.put(rec)

	switch class {
	case harness.RiskProhibited:
		rec.mu.Lock()
		transitionErr := run.Transition(harness.StateRejected, decisionCode)
		terminal := harness.IsTerminal(run.State)
		closeErr := rec.closeRunnerLocked()
		rec.mu.Unlock()
		s.store.releaseTask(rec, terminal)
		if transitionErr != nil {
			writeError(w, r, http.StatusServiceUnavailable, CodeUnavailable,
				"Prohibited work could not be evidenced as rejected.", nil)
			return
		}
		if closeErr != nil {
			writeError(w, r, http.StatusServiceUnavailable, CodeUnavailable,
				"Run workspace could not be torn down.", nil)
			return
		}
		writeError(w, r, http.StatusUnprocessableEntity, CodeRiskProhibited,
			"Prohibited work is rejected rather than downgraded.",
			map[string]any{
				"run_id":                    runID,
				"state":                     string(harness.StateRejected),
				"decision_code":             decisionCode,
				"evidence_bundle_available": true,
			})
		return
	case harness.RiskLow:
		params := s.grantParams(rec, now)
		rec.mu.Lock()
		approveErr := run.Approve(params)
		rec.mu.Unlock()
		s.store.releaseTask(rec, false)
		if approveErr != nil {
			writeError(w, r, http.StatusServiceUnavailable, CodeUnavailable,
				"Capability grant could not be evidenced.", nil)
			return
		}
		rec.mu.Lock()
		summary := summarizeGrant(run.Grant, rec.scopeDigest)
		state := run.State
		rec.mu.Unlock()
		writeJSON(w, http.StatusCreated, createRunResponse{
			RunID:          runID,
			State:          state,
			RiskAssessment: assessment,
			Grant:          summary,
			RequiredAction: nil,
		})
		return
	default:
		writeJSON(w, http.StatusCreated, createRunResponse{
			RunID:          runID,
			State:          run.State,
			RiskAssessment: assessment,
			Grant:          nil,
			RequiredAction: &requiredAction{Type: "approval", ScopeDigest: rec.scopeDigest},
		})
	}
}

type invalidFieldError struct {
	code    string
	message string
}

func (e *invalidFieldError) Error() string { return e.message }

func validateCreateRequest(req *createRequest) *invalidFieldError {
	fail := func(code, message string) *invalidFieldError {
		return &invalidFieldError{code: code, message: message}
	}
	switch {
	case req.TaskID == "":
		return fail(CodeInvalidRequest, "task_id is required")
	case req.Issue.Provider == "":
		return fail(CodeInvalidRequest, "issue.provider is required")
	case req.Issue.ExternalID == "":
		return fail(CodeInvalidRequest, "issue.external_id is required")
	case req.Issue.SourceReference == "":
		return fail(CodeInvalidRequest, "issue.source_reference is required")
	case req.Request.Summary == "":
		return fail(CodeInvalidRequest, "request.summary is required")
	case req.Request.RequestedBy.ActorID == "":
		return fail(CodeInvalidRequest, "request.requested_by.actor_id is required")
	case req.Repository.BaseRef == "":
		return fail(CodeInvalidRequest, "repository.base_ref is required")
	case req.RequestedScope.MaxWallClockSeconds <= 0:
		return fail(CodeInvalidRequest, "requested_scope.max_wall_clock_seconds must be positive")
	}
	idMatch := repositoryIDPattern.FindStringSubmatch(req.Repository.RepositoryID)
	urlMatch := githubURLPattern.FindStringSubmatch(req.Repository.URL)
	if idMatch == nil || urlMatch == nil || idMatch[1] != urlMatch[1] || idMatch[2] != urlMatch[2] {
		return fail(CodeInvalidRepositoryIdentity,
			"repository.repository_id must be github:<owner>/<repo> matching repository.url")
	}
	// The pilot may only touch its own repository. Rejecting here keeps a
	// foreign-repo run from being created only to fail evidence assembly
	// (and the terminal-bundle promise) for the rest of its life.
	if err := delivery.ValidateRepositoryURL(req.Repository.URL); err != nil {
		return fail(CodeInvalidRepositoryIdentity,
			"repository.url is not the allowed AutoFixer repository")
	}
	if !baseSHAPattern.MatchString(req.Repository.BaseSHA) {
		return fail(CodeInvalidBaseSHA, "repository.base_sha must be a hexadecimal commit id")
	}
	for _, hint := range req.RequestedScope.PathHints {
		if normalizePathHint(hint) == "" {
			return fail(CodeInvalidRequest, fmt.Sprintf("requested_scope.path_hints entry %q is not a repository-relative path", hint))
		}
	}
	return nil
}

// normalizeScope copies the requested scope with non-nil lists so its digest
// and the grant it produces are stable regardless of omitted fields.
func normalizeScope(scope requestedScope) requestedScope {
	out := requestedScope{MaxWallClockSeconds: scope.MaxWallClockSeconds}
	out.PathHints = []string{}
	for _, hint := range scope.PathHints {
		out.PathHints = append(out.PathHints, normalizePathHint(hint))
	}
	out.ToolCapabilities = []string{}
	for _, capability := range scope.ToolCapabilities {
		if capability != "" {
			out.ToolCapabilities = append(out.ToolCapabilities, capability)
		}
	}
	return out
}

// normalizePathHint turns a contract-style glob hint ("web/src/export/**")
// into the repository-relative root the harness grant matches on. Anything
// that cannot be expressed as a clean relative root is refused at create
// time rather than silently widening or narrowing the grant.
func normalizePathHint(hint string) string {
	trimmed := strings.TrimSpace(hint)
	for _, suffix := range []string{"/**", "/*"} {
		if strings.HasSuffix(trimmed, suffix) {
			trimmed = strings.TrimSuffix(trimmed, suffix)
		}
	}
	if trimmed == "" || strings.Contains(trimmed, "*") || strings.Contains(trimmed, "\\") {
		return ""
	}
	if !cleanRelativePath(trimmed) {
		return ""
	}
	return trimmed
}

// grantParams builds the capability grant from the registered tool surface
// and the requested scope. Unregistered capabilities never enter the grant,
// so asking for a shell or an unknown tool grants nothing.
func (s *Server) grantParams(rec *runRecord, issuedAt time.Time) harness.GrantParams {
	wall := rec.scope.MaxWallClockSeconds
	permitted := []harness.PermittedTool{}
	for _, capability := range rec.scope.ToolCapabilities {
		spec, ok := s.tools.get(capability)
		if !ok {
			continue
		}
		permitted = append(permitted, harness.PermittedTool{
			Identity:         spec.ID,
			AllowedArguments: permittedArguments(spec),
		})
	}
	return harness.GrantParams{
		TaskID:                 rec.run.TaskID,
		RunID:                  rec.run.RunID,
		IssuedAt:               issuedAt,
		ExpiresAt:              issuedAt.Add(time.Duration(wall) * time.Second),
		CapabilityGrantVersion: fmt.Sprintf("dsh-grant-%s", rec.run.RunID),
		PolicyVersion:          harness.DefaultPolicyVersion,
		RepositoryURL:          rec.run.RepositoryURL,
		BaseSHA:                rec.run.BaseSHA,
		PermittedPaths:         append([]string{}, rec.scope.PathHints...),
		PermittedTools:         permitted,
		NetworkDestinations:    []string{},
		MaxWallClockSeconds:    wall,
		ResourceLimits:         harness.ResourceLimits{MaxMemoryMB: 512, MaxCPUSeconds: wall},
		MayCreatePatch:         false,
		MayCreateOrUpdatePR:    false,
	}
}

// provisionalElevatedAssessment records the pre-approval classification. The
// approval reference is attached only when an approval is recorded, so the
// evidence chain never claims a grant decision that has not happened.
func provisionalElevatedAssessment(in harness.RiskAssessmentInput, decisionCode string) harness.RiskAssessment {
	policyVersion := in.PolicyVersion
	if policyVersion == "" {
		policyVersion = harness.DefaultPolicyVersion
	}
	return harness.RiskAssessment{
		ContractVersion:           harness.ContractVersion,
		TaskID:                    in.TaskID,
		RunID:                     in.RunID,
		AssessedAt:                in.AssessedAt,
		AssessorIdentity:          in.AssessorIdentity,
		RiskClass:                 harness.RiskElevated,
		DecisionCode:              decisionCode,
		RationaleReference:        in.RationaleReference,
		PolicyVersion:             policyVersion,
		ElevatedApprovalReference: nil,
	}
}
