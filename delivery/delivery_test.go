package delivery

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

type fakeBranchWriter struct {
	called bool
	got    PatchArtifact
	result BranchUpdate
}

func (f *fakeBranchWriter) PushPatch(_ context.Context, patch PatchArtifact) (BranchUpdate, error) {
	f.called = true
	f.got = patch
	return f.result, nil
}

type fakePRClient struct {
	created bool
	updated bool
	got     PullRequestInput
	result  PullRequest
}

func (f *fakePRClient) CreatePullRequest(_ context.Context, input PullRequestInput) (PullRequest, error) {
	f.created = true
	f.got = input
	return f.result, nil
}

func (f *fakePRClient) UpdatePullRequest(_ context.Context, _ int, input PullRequestInput) (PullRequest, error) {
	f.updated = true
	f.got = input
	return f.result, nil
}

func ptr[T any](value T) *T { return &value }

func testPatchReport(t *testing.T, status PatchStatus) PatchReport {
	t.Helper()
	branch, head := "autofixer/task-173-abc1234", "abc1234deadbeef"
	prID := "pr-17"
	if status == PatchPreparedNoPR || status == PatchNotCreated {
		prID = ""
	}
	var pr *string
	if prID != "" {
		pr = &prID
	}
	var branchPtr, headPtr *string
	if status != PatchNotCreated {
		branchPtr, headPtr = &branch, &head
	}
	report := PatchReport{
		TaskID:             "task-173",
		RunID:              "run-173",
		IssuedAt:           time.Date(2026, 10, 22, 1, 0, 0, 0, time.UTC),
		RepositoryURL:      AllowedRepositoryURL,
		BaseSHA:            "base-123",
		PatchStatus:        status,
		Branch:             branchPtr,
		HeadSHA:            headPtr,
		PRID:               pr,
		ChangeSummary:      "Update the protected delivery path.",
		EvidenceReferences: []string{"evidence://events/run-173/3"},
	}
	if status != PatchNotCreated {
		result := 0
		report.Validation = []ValidationEvidence{{
			Tool:           "go test",
			Arguments:      []string{"./...", "token=not-a-secret-in-a-test"},
			ExitStatus:     &result,
			OutputDigest:   harness.Digest{Algorithm: harness.DigestAlgorithmSHA256, Value: "out-123"},
			EventReference: "evidence://events/run-173/4",
		}}
	}
	finalized, err := NewPatchReport(report)
	if err != nil {
		t.Fatalf("NewPatchReport: %v", err)
	}
	return finalized
}

func testRisk(t *testing.T) harness.RiskAssessment {
	t.Helper()
	risk, err := harness.NewRiskAssessment(harness.RiskAssessmentInput{
		TaskID:             "task-173",
		RunID:              "run-173",
		AssessedAt:         time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC),
		AssessorIdentity:   "human:reviewer",
		RationaleReference: "evidence://risk/task-173",
	}, harness.RiskLow, harness.DecisionRiskLowApproved, nil)
	if err != nil {
		t.Fatalf("NewRiskAssessment: %v", err)
	}
	return risk
}

func testSnapshot(head string) harness.ApprovalSnapshot {
	when := time.Date(2026, 10, 22, 2, 0, 0, 0, time.UTC)
	return harness.ApprovalSnapshot{
		ContractVersion: harness.ContractVersion,
		TaskID:          "task-173",
		RunID:           "run-173",
		ObservedAt:      when,
		HeadSHA:         ptr(head),
		QA: harness.QAObservation{
			Status:  "not_requested",
			HeadSHA: ptr(head),
		},
		ReviewDiscussions: harness.DiscussionsObservation{
			Status:     "not_applicable",
			HeadSHA:    ptr(head),
			ObservedAt: when,
		},
		ApprovalQuorum: harness.QuorumObservation{
			Status:  "not_requested",
			HeadSHA: ptr(head),
		},
		MergeQueueAvailable:    true,
		ApprovalSnapshotStatus: harness.SnapshotStatusNotRequested,
		EvidenceReference:      "evidence://approvals/run-173/" + head,
	}
}

func testPRReport(t *testing.T) PullRequestReport {
	t.Helper()
	patch := testPatchReport(t, PatchProposed)
	report, err := NewPullRequestReport(patch, testRisk(t), testSnapshot("abc1234deadbeef"))
	if err != nil {
		t.Fatalf("NewPullRequestReport: %v", err)
	}
	return report
}

func TestValidateProjectRepositoryAndProtectedScope(t *testing.T) {
	for _, repository := range []string{
		"https://github.com/Luthiel/AutoFixer.git",
		"https://github.com/Luthiel/AutoFixer",
	} {
		if err := ValidateRepositoryURL(repository); err != nil {
			t.Errorf("ValidateRepositoryURL(%q): %v", repository, err)
		}
	}
	for _, repository := range []string{
		"http://github.com/Luthiel/AutoFixer.git",
		"https://github.com/luthiel/AutoFixer.git",
		"https://github.com/Luthiel/AutoFixer.git.evil",
		"https://github.com/Luthiel/AutoFixer.git?token=secret",
	} {
		if err := ValidateRepositoryURL(repository); err == nil {
			t.Errorf("ValidateRepositoryURL(%q): nil, want rejection", repository)
		}
	}
	for _, branch := range []string{"autofixer/DAT-173-fix", "autofixer/nested/fix"} {
		if err := ValidateBranch(branch); err != nil {
			t.Errorf("ValidateBranch(%q): %v", branch, err)
		}
	}
	for _, branch := range []string{"main", "feature/fix", "autofixer/", "autofixer/../main", "autofixer/secret.lock", "autofixer/fix/"} {
		if err := ValidateBranch(branch); err == nil {
			t.Errorf("ValidateBranch(%q): nil, want rejection", branch)
		}
	}
	for _, file := range []string{".github/workflows/ci.yml", ".env", "secrets/token", "docs/adr/new.md", "docs/contracts/task-evidence-contract-v1.md", "../main.go", "/tmp/file"} {
		if err := (PatchArtifact{
			TaskID:        "task-173",
			RepositoryURL: AllowedRepositoryURL,
			BaseSHA:       "base-123",
			Branch:        "autofixer/task-173-abc1234",
			HeadSHA:       "abc1234deadbeef",
			Files:         []PatchFile{{Path: file}},
		}).Validate(); err == nil {
			t.Errorf("PatchArtifact path %q: nil, want protected-resource rejection", file)
		}
	}
}

func TestNewPatchReportRedactsAndVerifiesDigest(t *testing.T) {
	report := testPatchReport(t, PatchProposed)
	if report.ReportDigest == "" {
		t.Fatal("ReportDigest is empty")
	}
	if err := report.Validate(); err != nil {
		t.Fatalf("Validate finalized report: %v", err)
	}
	if strings.Contains(report.Validation[0].Arguments[1], "not-a-secret-in-a-test") {
		t.Fatal("report retained a credential-looking argument")
	}
	report.ChangeSummary = "tampered"
	if err := report.Validate(); err == nil {
		t.Fatal("Validate tampered report: nil, want digest mismatch")
	}
}

func TestPatchReportRequiresValidationForCreatedPatch(t *testing.T) {
	created := testPatchReport(t, PatchProposed)
	created.Validation = nil
	created.ReportDigest = ""
	if _, err := NewPatchReport(created); err == nil {
		t.Fatal("created patch without validation: nil error, want rejection")
	}

	noPatch := testPatchReport(t, PatchNotCreated)
	if len(noPatch.Validation) != 0 {
		t.Fatalf("not_created validation = %d, want zero", len(noPatch.Validation))
	}
	if err := noPatch.Validate(); err != nil {
		t.Fatalf("not_created without validation: %v", err)
	}
}

func TestPullRequestReportRejectsUnboundApprovalSubobservations(t *testing.T) {
	report := testPRReport(t)
	report.ApprovalSnapshot.QA.HeadSHA = nil
	if err := report.Validate(); err == nil {
		t.Fatal("PR report with null QA head: nil error, want rejection")
	}

	report = testPRReport(t)
	report.ApprovalSnapshot.ReviewDiscussions.HeadSHA = ptr("oldhead1234567")
	if err := report.Validate(); err == nil {
		t.Fatal("PR report with stale discussion head: nil error, want rejection")
	}

	report = testPRReport(t)
	report.ApprovalSnapshot.ApprovalQuorum.HeadSHA = nil
	if err := report.Validate(); err == nil {
		t.Fatal("PR report with null quorum head: nil error, want rejection")
	}
}

func TestProtectedDeliveryCreatesPRWithBoundReport(t *testing.T) {
	client := &fakePRClient{result: PullRequest{
		ID: "pr-id", Number: 17, URL: "https://github.com/Luthiel/AutoFixer/pull/17",
		RepositoryURL: AllowedRepositoryURL, BaseBranch: AllowedBaseBranch,
		HeadBranch: "autofixer/task-173-abc1234", HeadSHA: "abc1234deadbeef",
	}}
	adapter := NewProtectedPRAdapter(client)
	report := testPRReport(t)
	pr, err := adapter.CreateOrUpdatePR(context.Background(), DeliveryRequest{
		TaskID: "task-173", IssueKey: "DAT-173", RepositoryURL: AllowedRepositoryURL,
		BaseBranch: AllowedBaseBranch, Branch: "autofixer/task-173-abc1234", BaseSHA: "base-123", HeadSHA: "abc1234deadbeef",
		Report: report,
	})
	if err != nil {
		t.Fatalf("CreateOrUpdatePR: %v", err)
	}
	if !client.created || client.updated {
		t.Fatalf("provider calls = created:%v updated:%v, want create only", client.created, client.updated)
	}
	if pr.Number != 17 || !strings.Contains(client.got.Body, "task-173") ||
		!strings.Contains(client.got.Body, "Update the protected delivery path.") ||
		!strings.Contains(client.got.Body, "abc1234deadbeef") || !strings.Contains(client.got.Body, "risk_low_approved") {
		t.Fatalf("PR result/body did not retain required report fields: %+v", client.got)
	}
}

func TestProtectedDeliveryUpdatesPRAndRejectsProviderDrift(t *testing.T) {
	client := &fakePRClient{result: PullRequest{
		ID: "pr-id", Number: 17, URL: "https://github.com/Luthiel/AutoFixer/pull/17",
		RepositoryURL: AllowedRepositoryURL, BaseBranch: AllowedBaseBranch,
		HeadBranch: "autofixer/task-173-abc1234", HeadSHA: "oldhead1234567",
	}}
	adapter := NewProtectedPRAdapter(client)
	_, err := adapter.CreateOrUpdatePR(context.Background(), DeliveryRequest{
		TaskID: "task-173", IssueKey: "DAT-173", RepositoryURL: AllowedRepositoryURL,
		Branch: "autofixer/task-173-abc1234", BaseSHA: "base-123", HeadSHA: "abc1234deadbeef", ExistingPR: 17,
		Report: testPRReport(t),
	})
	if err == nil || !client.updated {
		t.Fatalf("update result = err:%v updated:%v, want provider update and drift rejection", err, client.updated)
	}
}

func TestProtectedDeliveryPushesOnlyBoundSafePatch(t *testing.T) {
	writer := &fakeBranchWriter{result: BranchUpdate{
		RepositoryURL: AllowedRepositoryURL, Branch: "autofixer/task-173-abc1234", HeadSHA: "abc1234deadbeef",
	}}
	adapter := NewProtectedDeliveryAdapter(writer, nil)
	patch := PatchArtifact{
		TaskID: "task-173", RepositoryURL: AllowedRepositoryURL, BaseSHA: "base-123", Branch: "autofixer/task-173-abc1234", HeadSHA: "abc1234deadbeef",
		Files: []PatchFile{{Path: "delivery/pr.go", ArtifactDigest: "sha256:patch"}},
	}
	if _, err := adapter.PushPatch(context.Background(), patch); err != nil {
		t.Fatalf("PushPatch: %v", err)
	}
	if !writer.called || writer.got.Branch != patch.Branch {
		t.Fatalf("writer call = called:%v branch:%q", writer.called, writer.got.Branch)
	}
}

func TestCheckMergeEligibilityRequiresEveryGate(t *testing.T) {
	adapter := NewProtectedPRAdapter(nil)
	report := testPRReport(t)
	result, err := adapter.CheckMergeEligibility(report)
	if err != nil {
		t.Fatalf("CheckMergeEligibility: %v", err)
	}
	if result.Eligible || result.Code != harness.DenyApprovalQANotPassed {
		t.Fatalf("result = %+v, want QA denial", result)
	}

	when := time.Date(2026, 10, 22, 2, 0, 0, 0, time.UTC)
	head := "abc1234deadbeef"
	report.ApprovalSnapshot.QA = harness.QAObservation{
		Status: "passed", HeadSHA: &head, Identity: ptr("qa:team"), ApprovedAt: ptr(when),
	}
	report.ApprovalSnapshot.RequiredChecks = []harness.CheckObservation{{
		Name: "required", Status: "passed", HeadSHA: &head, ObservedAt: when,
	}}
	report.ApprovalSnapshot.ReviewDiscussions = harness.DiscussionsObservation{
		Status: "resolved", HeadSHA: &head, ObservedAt: when,
	}
	report.ApprovalSnapshot.ApprovalQuorum = harness.QuorumObservation{
		Status: "satisfied", HeadSHA: &head, Approvals: []harness.Approval{
			{Identity: "Luthiel", HeadSHA: &head, ApprovedAt: when},
			{Identity: "Ludwig-Planck", HeadSHA: &head, ApprovedAt: when},
		},
	}
	result, err = adapter.CheckMergeEligibility(report)
	if err != nil || !result.Eligible || result.Code != harness.AllowMergeQueueEligible {
		t.Fatalf("eligible result = %+v err=%v, want merge-queue eligibility", result, err)
	}
}

func testEvidenceBundle(t *testing.T, status PatchStatus) EvidenceBundle {
	t.Helper()
	report := testPatchReport(t, status)
	if status != PatchNotCreated {
		report.EvidenceReferences = []string{"evidence://events/run-173/1"}
		report.Validation[0].EventReference = "evidence://events/run-173/1"
		var err error
		report, err = NewPatchReport(report)
		if err != nil {
			t.Fatalf("NewPatchReport for bundle: %v", err)
		}
	}
	snapshot := testSnapshot("abc1234deadbeef")
	event := harness.ExecutionEvent{
		ContractVersion:     harness.ContractVersion,
		EventID:             "evt-run-173-1",
		Sequence:            1,
		EventType:           harness.EventTypeStateTransition,
		RunID:               "run-173",
		TaskID:              "task-173",
		IssueID:             "issue-173",
		ActorIdentity:       "agent:runner",
		ExecutionIdentity:   "runtime:autofixer",
		OccurredAt:          time.Date(2026, 10, 22, 2, 1, 0, 0, time.UTC),
		PolicyVersion:       harness.DefaultPolicyVersion,
		RepositoryURL:       AllowedRepositoryURL,
		BaseSHA:             "base-123",
		Branch:              ptr("autofixer/task-173-abc1234"),
		HeadSHA:             ptr("abc1234deadbeef"),
		ApprovalSnapshotRef: "evidence://approvals/run-173/abc1234deadbeef",
		EventDigest:         "event-digest-1",
		DigestAlgorithm:     harness.DigestAlgorithmSHA256,
	}
	if status == PatchNotCreated {
		report.EvidenceReferences = []string{"evidence://events/run-173/1"}
		var err error
		report, err = NewPatchReport(report)
		if err != nil {
			t.Fatalf("NewPatchReport for no-patch bundle: %v", err)
		}
		snapshot.HeadSHA = nil
		snapshot.QA.HeadSHA = nil
		snapshot.ReviewDiscussions.HeadSHA = nil
		snapshot.ApprovalQuorum.HeadSHA = nil
		snapshot.EvidenceReference = "evidence://approvals/run-173/no-pr"
		event.Branch = nil
		event.HeadSHA = nil
	}
	return EvidenceBundle{
		ContractVersion: harness.ContractVersion,
		TaskInput: TaskInput{
			ContractVersion: harness.ContractVersion,
			TaskID:          "task-173",
			IssueID:         "issue-173",
			RequestedAt:     time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC),
			Repository:      TaskRepository{URL: AllowedRepositoryURL, BaseSHA: "base-123"},
			RequestedWork:   RequestedWork{Summary: "bounded remediation", SourceReference: "issue://issue-173"},
		},
		RiskAssessment:     testRisk(t),
		ExecutionEvents:    []harness.ExecutionEvent{event},
		PatchReport:        report,
		ApprovalSnapshot:   snapshot,
		EvidenceReferences: []string{"evidence://events/run-173/1", "evidence://risk/task-173", snapshot.EvidenceReference},
	}
}

func TestEvidenceBundleBindsEventsAndReferencesToCurrentHead(t *testing.T) {
	bundle := testEvidenceBundle(t, PatchProposed)
	if err := bundle.Validate(); err != nil {
		t.Fatalf("valid evidence bundle: %v", err)
	}

	bundle.ExecutionEvents[0].HeadSHA = ptr("deadbeef1234567")
	if err := bundle.Validate(); err == nil {
		t.Fatal("bundle with event on another head: nil error, want rejection")
	}

	bundle = testEvidenceBundle(t, PatchProposed)
	report := bundle.PatchReport
	report.Validation[0].EventReference = "evidence://events/run-173/99"
	var err error
	bundle.PatchReport, err = NewPatchReport(report)
	if err != nil {
		t.Fatalf("NewPatchReport with unresolved validation reference: %v", err)
	}
	if err := bundle.Validate(); err == nil {
		t.Fatal("bundle with unresolved validation reference: nil error, want rejection")
	}
}

func TestNotCreatedEvidenceBundleRequiresNullRevisionBindings(t *testing.T) {
	bundle := testEvidenceBundle(t, PatchNotCreated)
	if err := bundle.Validate(); err != nil {
		t.Fatalf("valid not_created bundle: %v", err)
	}

	bundle = testEvidenceBundle(t, PatchNotCreated)
	bundle.ExecutionEvents[0].HeadSHA = ptr("abc1234deadbeef")
	if err := bundle.Validate(); err == nil {
		t.Fatal("not_created bundle with a head-bound event: nil error, want rejection")
	}
}

func TestEvidenceBundleAllowsPrePatchEventsAndBindsLaterEvents(t *testing.T) {
	bundle := testEvidenceBundle(t, PatchProposed)
	first := bundle.ExecutionEvents[0]
	first.Branch = nil
	first.HeadSHA = nil
	second := first
	second.EventID = "evt-run-173-2"
	second.Sequence = 2
	second.PreviousEventDigest = ptr(first.EventDigest)
	second.EventDigest = "event-digest-2"
	second.Branch = ptr("autofixer/task-173-abc1234")
	second.HeadSHA = ptr("abc1234deadbeef")
	bundle.ExecutionEvents = []harness.ExecutionEvent{first, second}

	report := bundle.PatchReport
	report.EvidenceReferences = []string{"evidence://events/run-173"}
	report.Validation[0].EventReference = "evidence://events/run-173"
	var err error
	bundle.PatchReport, err = NewPatchReport(report)
	if err != nil {
		t.Fatalf("NewPatchReport with run-level event reference: %v", err)
	}
	bundle.EvidenceReferences = []string{"evidence://events/run-173", "evidence://risk/task-173", bundle.ApprovalSnapshot.EvidenceReference}
	if err := bundle.Validate(); err != nil {
		t.Fatalf("pre-patch null event followed by bound event: %v", err)
	}

	bundle.ExecutionEvents[1].HeadSHA = nil
	if err := bundle.Validate(); err == nil {
		t.Fatal("event that loses its head binding: nil error, want rejection")
	}

	bundle = testEvidenceBundle(t, PatchProposed)
	first = bundle.ExecutionEvents[0]
	first.Branch = nil
	first.HeadSHA = nil
	second = first
	second.EventID = "evt-run-173-2"
	second.Sequence = 2
	second.PreviousEventDigest = ptr(first.EventDigest)
	second.EventDigest = "event-digest-2"
	second.Branch = ptr("autofixer/task-173-other")
	second.HeadSHA = ptr("abc1234deadbeef")
	bundle.ExecutionEvents = []harness.ExecutionEvent{first, second}
	if err := bundle.Validate(); err == nil {
		t.Fatal("event with a mismatched branch: nil error, want rejection")
	}
}
