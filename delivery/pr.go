package delivery

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/Luthiel/AutoFixer/harness"
)

// BranchWriter is the narrow repository mutation capability needed to publish
// a prepared patch. A production implementation supplies its own scoped
// GitHub client; raw credentials never enter the delivery package.
type BranchWriter interface {
	PushPatch(context.Context, PatchArtifact) (BranchUpdate, error)
}

// PRClient is deliberately limited to create/update operations. There is no
// merge, review-dismissal, check-waiver, tag, secret, or workflow operation in
// this interface, so the adapter cannot invoke those side effects.
type PRClient interface {
	CreatePullRequest(context.Context, PullRequestInput) (PullRequest, error)
	UpdatePullRequest(context.Context, int, PullRequestInput) (PullRequest, error)
}

// BranchUpdate is the provider's acknowledgement of a patch push.
type BranchUpdate struct {
	RepositoryURL string
	Branch        string
	HeadSHA       string
}

// PullRequestInput contains only fields needed to open/update a proposal.
type PullRequestInput struct {
	RepositoryURL string
	BaseBranch    string
	HeadBranch    string
	HeadSHA       string
	Title         string
	Body          string
}

// PullRequest is the provider result, checked by the adapter before it is
// handed back to the caller.
type PullRequest struct {
	ID            string
	Number        int
	URL           string
	RepositoryURL string
	BaseBranch    string
	HeadBranch    string
	HeadSHA       string
}

// DeliveryRequest is the complete, side-effecting handoff request. ExistingPR
// selects update versus create; a zero value creates a new PR.
type DeliveryRequest struct {
	TaskID        string
	IssueKey      string
	RepositoryURL string
	BaseBranch    string
	Branch        string
	BaseSHA       string
	HeadSHA       string
	Title         string
	Patch         *PatchArtifact
	Report        PullRequestReport
	ExistingPR    int
}

// ProtectedDeliveryAdapter validates every write boundary, delegates only to
// injected clients, and never performs a merge. It is safe to use with a
// controlled mock in tests without configuring a real GitHub credential.
type ProtectedDeliveryAdapter struct {
	branches BranchWriter
	prs      PRClient
}

// ProtectedPRAdapter is the concise name for the PR-focused adapter.
type ProtectedPRAdapter = ProtectedDeliveryAdapter

// NewProtectedDeliveryAdapter builds an adapter with optional branch and PR
// capabilities. A nil capability is rejected when that operation is called.
func NewProtectedDeliveryAdapter(branches BranchWriter, prs PRClient) *ProtectedDeliveryAdapter {
	return &ProtectedDeliveryAdapter{branches: branches, prs: prs}
}

// NewProtectedPRAdapter builds an adapter for PR create/update operations.
// Branch pushing remains unavailable unless the caller uses
// NewProtectedDeliveryAdapter with a BranchWriter.
func NewProtectedPRAdapter(prs PRClient) *ProtectedPRAdapter {
	return NewProtectedDeliveryAdapter(nil, prs)
}

// PushPatch validates and delegates a patch push. The provider must still
// enforce its own short-lived token scope; this method only permits the
// project-level repository, autofixer branch, and safe source paths.
func (a *ProtectedDeliveryAdapter) PushPatch(ctx context.Context, patch PatchArtifact) (BranchUpdate, error) {
	if a == nil || a.branches == nil {
		return BranchUpdate{}, errors.New("delivery: branch writer is not configured")
	}
	if err := patch.Validate(); err != nil {
		return BranchUpdate{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	update, err := a.branches.PushPatch(ctx, patch)
	if err != nil {
		return BranchUpdate{}, fmt.Errorf("delivery: push patch: %w", err)
	}
	if update.RepositoryURL != patch.RepositoryURL || update.Branch != patch.Branch || update.HeadSHA != patch.HeadSHA {
		return BranchUpdate{}, errors.New("delivery: branch writer returned an unbound revision")
	}
	return update, nil
}

var issueKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]+-[0-9]+$`)

// CreateOrUpdatePR creates or updates an issue-linked PR and embeds the
// complete report in its body. The adapter validates the returned provider
// object against the requested current head to prevent evidence drift.
func (a *ProtectedDeliveryAdapter) CreateOrUpdatePR(ctx context.Context, req DeliveryRequest) (PullRequest, error) {
	if a == nil || a.prs == nil {
		return PullRequest{}, errors.New("delivery: pull-request client is not configured")
	}
	if err := validateDeliveryRequest(req); err != nil {
		return PullRequest{}, err
	}
	body, err := req.Report.MarshalBody()
	if err != nil {
		return PullRequest{}, err
	}
	title := req.Title
	if title == "" {
		title = req.IssueKey + ": propose remediation for " + req.TaskID
	}
	if !strings.Contains(title, req.IssueKey) {
		return PullRequest{}, fmt.Errorf("delivery: PR title must contain issue key %q", req.IssueKey)
	}
	input := PullRequestInput{
		RepositoryURL: req.RepositoryURL,
		BaseBranch:    req.BaseBranchOrMain(),
		HeadBranch:    req.Branch,
		HeadSHA:       req.HeadSHA,
		Title:         title,
		Body:          body,
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var pr PullRequest
	if req.ExistingPR > 0 {
		pr, err = a.prs.UpdatePullRequest(ctx, req.ExistingPR, input)
	} else {
		pr, err = a.prs.CreatePullRequest(ctx, input)
	}
	if err != nil {
		return PullRequest{}, fmt.Errorf("delivery: create or update PR: %w", err)
	}
	if err := validateReturnedPR(pr, req); err != nil {
		return PullRequest{}, err
	}
	return pr, nil
}

// CreateOrUpdate is an alias kept as the short adapter entry point.
func (a *ProtectedDeliveryAdapter) CreateOrUpdate(ctx context.Context, req DeliveryRequest) (PullRequest, error) {
	return a.CreateOrUpdatePR(ctx, req)
}

func validateDeliveryRequest(req DeliveryRequest) error {
	if req.TaskID == "" || req.BaseSHA == "" || req.HeadSHA == "" {
		return errors.New("delivery: delivery request is missing task or revision identity")
	}
	if !issueKeyPattern.MatchString(req.IssueKey) {
		return fmt.Errorf("delivery: invalid issue key %q", req.IssueKey)
	}
	if err := ValidateRepositoryURL(req.RepositoryURL); err != nil {
		return err
	}
	baseBranch := req.BaseBranch
	if baseBranch == "" {
		baseBranch = AllowedBaseBranch
	}
	if err := ValidateBaseBranch(baseBranch); err != nil {
		return err
	}
	if err := ValidateTaskBranch(req.TaskID, req.Branch, req.HeadSHA); err != nil {
		return err
	}
	if err := req.Report.Validate(); err != nil {
		return err
	}
	if req.Report.TaskID != req.TaskID || req.Report.CurrentHeadSHA != req.HeadSHA || req.Report.PatchReport.RepositoryURL != req.RepositoryURL ||
		req.Report.PatchReport.BaseSHA != req.BaseSHA || req.Report.PatchReport.Branch == nil || *req.Report.PatchReport.Branch != req.Branch {
		return errors.New("delivery: PR request and report are not bound to the same task, branch, repository, or head")
	}
	if req.Patch != nil {
		if err := req.Patch.Validate(); err != nil {
			return err
		}
		if req.Patch.TaskID != req.TaskID || req.Patch.RepositoryURL != req.RepositoryURL || req.Patch.BaseSHA != req.BaseSHA || req.Patch.Branch != req.Branch || req.Patch.HeadSHA != req.HeadSHA {
			return errors.New("delivery: patch artifact is not bound to the PR request")
		}
	}
	return nil
}

func validateReturnedPR(pr PullRequest, req DeliveryRequest) error {
	if pr.ID == "" || pr.Number <= 0 || pr.URL == "" {
		return errors.New("delivery: provider returned an incomplete pull request")
	}
	if pr.RepositoryURL != req.RepositoryURL || pr.BaseBranch != req.BaseBranchOrMain() || pr.HeadBranch != req.Branch || pr.HeadSHA != req.HeadSHA {
		return errors.New("delivery: provider returned a pull request bound to the wrong revision")
	}
	return nil
}

func (r DeliveryRequest) BaseBranchOrMain() string {
	if r.BaseBranch == "" {
		return AllowedBaseBranch
	}
	return r.BaseBranch
}

// CheckMergeEligibility evaluates the report's current-head snapshot. It
// returns a denial for every missing gate and has no provider call, so it
// cannot enqueue or merge a PR.
func (a *ProtectedDeliveryAdapter) CheckMergeEligibility(report PullRequestReport) (harness.EligibilityResult, error) {
	if err := report.Validate(); err != nil {
		return harness.EligibilityResult{Eligible: false, Status: harness.SnapshotStatusIneligible, Code: "deny_invalid_report"}, err
	}
	if report.ApprovalSnapshot.HeadSHA == nil || *report.ApprovalSnapshot.HeadSHA != report.CurrentHeadSHA {
		return harness.EligibilityResult{Eligible: false, Status: harness.SnapshotStatusIneligible, Code: harness.DenySnapshotHeadMismatch}, nil
	}
	result := report.ApprovalSnapshot.Evaluate()
	return result, nil
}
