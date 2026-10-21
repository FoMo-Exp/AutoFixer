package harness

import (
	"testing"
	"time"
)

func strptr(s string) *string { return &s }

func timep(t time.Time) *time.Time { return &t }

func baseSnapshot(head string) ApprovalSnapshot {
	observed := time.Date(2026, 10, 21, 10, 0, 0, 0, time.UTC)
	return ApprovalSnapshot{
		ContractVersion: ContractVersion,
		TaskID:          "task-1",
		RunID:           "run-1",
		ObservedAt:      observed,
		HeadSHA:         strptr(head),
		QA: QAObservation{
			Status: "passed", HeadSHA: strptr(head),
			Identity: strptr("qa:team"), ApprovedAt: timep(observed.Add(-30 * time.Minute)),
		},
		RequiredChecks: []CheckObservation{
			{Name: "required-check", Status: "passed", HeadSHA: strptr(head), ObservedAt: observed.Add(-25 * time.Minute)},
		},
		ReviewDiscussions: DiscussionsObservation{
			Status: "resolved", HeadSHA: strptr(head), ObservedAt: observed.Add(-20 * time.Minute),
		},
		ApprovalQuorum: QuorumObservation{
			Status: "satisfied", HeadSHA: strptr(head),
			Approvals: []Approval{
				{Identity: "Luthiel", HeadSHA: strptr(head), ApprovedAt: observed.Add(-15 * time.Minute)},
				{Identity: "Ludwig-Planck", HeadSHA: strptr(head), ApprovedAt: observed.Add(-10 * time.Minute)},
			},
		},
		EvidenceReference: "evidence://approvals/run-1/" + head,
	}
}

func TestEvaluateMergeEligibleWhenAllFourConditionsHold(t *testing.T) {
	s := baseSnapshot("head222")
	res := s.Evaluate()
	if !res.Eligible {
		t.Fatalf("Eligible = false, want true (status %q code %q)", res.Status, res.Code)
	}
	if res.Status != SnapshotStatusEligible {
		t.Errorf("Status = %q, want %q", res.Status, SnapshotStatusEligible)
	}
	if !s.MergeQueueEligible {
		t.Error("snapshot MergeQueueEligible not updated to true")
	}
	if s.ApprovalSnapshotStatus != SnapshotStatusEligible {
		t.Errorf("snapshot ApprovalSnapshotStatus = %q, want %q", s.ApprovalSnapshotStatus, SnapshotStatusEligible)
	}
}

func TestEvaluateRejectsWithoutHead(t *testing.T) {
	s := baseSnapshot("head222")
	s.HeadSHA = nil
	res := s.Evaluate()
	if res.Eligible || res.Status != SnapshotStatusNotRequested || res.Code != DenyApprovalNoHead {
		t.Errorf("res = %+v, want not eligible / %q / %q", res, SnapshotStatusNotRequested, DenyApprovalNoHead)
	}
	if s.MergeQueueEligible {
		t.Error("MergeQueueEligible must be false")
	}
}

func TestEvaluateDeniesFailingComponents(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*ApprovalSnapshot)
		code   string
	}{
		{"qa not passed", func(s *ApprovalSnapshot) { s.QA.Status = "pending" }, DenyApprovalQANotPassed},
		{"qa failed", func(s *ApprovalSnapshot) { s.QA.Status = "failed" }, DenyApprovalQANotPassed},
		{"qa bound to old head", func(s *ApprovalSnapshot) {
			s.QA.HeadSHA = strptr("oldhead")
			s.QA.Identity = strptr("qa:team")
		}, DenyApprovalQAStaleHead},
		{"qa passed without head binding", func(s *ApprovalSnapshot) { s.QA.HeadSHA = nil }, DenyApprovalQAStaleHead},
		{"no required checks observed", func(s *ApprovalSnapshot) { s.RequiredChecks = nil }, DenyApprovalChecksMissing},
		{"required check failed", func(s *ApprovalSnapshot) { s.RequiredChecks[0].Status = "failed" }, DenyApprovalChecksNotPassed},
		{"required check on old head", func(s *ApprovalSnapshot) { s.RequiredChecks[0].HeadSHA = strptr("oldhead") }, DenyApprovalChecksStaleHead},
		{"discussions open", func(s *ApprovalSnapshot) { s.ReviewDiscussions.Status = "open" }, DenyApprovalDiscussionsUnresolved},
		{"discussions on old head", func(s *ApprovalSnapshot) { s.ReviewDiscussions.HeadSHA = strptr("oldhead") }, DenyApprovalDiscussionsStaleHead},
		{"only one approver", func(s *ApprovalSnapshot) {
			s.ApprovalQuorum.Approvals = s.ApprovalQuorum.Approvals[:1]
		}, DenyApprovalQuorumIncomplete},
		{"approvals from the wrong people", func(s *ApprovalSnapshot) {
			s.ApprovalQuorum.Approvals = []Approval{
				{Identity: "Luthiel", HeadSHA: strptr("head222"), ApprovedAt: time.Now()},
				{Identity: "someone-else", HeadSHA: strptr("head222"), ApprovedAt: time.Now()},
			}
		}, DenyApprovalQuorumIncomplete},
		{"approvals expired on old head", func(s *ApprovalSnapshot) {
			for i := range s.ApprovalQuorum.Approvals {
				s.ApprovalQuorum.Approvals[i].HeadSHA = strptr("oldhead")
			}
			s.ApprovalQuorum.HeadSHA = strptr("oldhead")
		}, DenyApprovalQuorumStaleHead},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := baseSnapshot("head222")
			tc.mutate(&s)
			res := s.Evaluate()
			if res.Eligible {
				t.Fatal("Eligible = true, want false")
			}
			if res.Code != tc.code {
				t.Errorf("Code = %q, want %q", res.Code, tc.code)
			}
			if res.Status != SnapshotStatusIneligible {
				t.Errorf("Status = %q, want %q", res.Status, SnapshotStatusIneligible)
			}
			if s.MergeQueueEligible {
				t.Error("MergeQueueEligible must stay false")
			}
			if s.ApprovalSnapshotStatus != SnapshotStatusIneligible {
				t.Errorf("snapshot ApprovalSnapshotStatus = %q, want %q", s.ApprovalSnapshotStatus, SnapshotStatusIneligible)
			}
		})
	}
}

func TestEvaluateReportsFirstFailingComponentInOrder(t *testing.T) {
	s := baseSnapshot("head222")
	s.QA.Status = "pending"
	s.ApprovalQuorum.Approvals = s.ApprovalQuorum.Approvals[:1]
	res := s.Evaluate()
	if res.Code != DenyApprovalQANotPassed {
		t.Errorf("Code = %q, want %q (QA evaluated before quorum)", res.Code, DenyApprovalQANotPassed)
	}
}

func TestRequiredApproversAreTheQuorumFromContext(t *testing.T) {
	if len(RequiredApprovers) != 2 || RequiredApprovers[0] != "Luthiel" || RequiredApprovers[1] != "Ludwig-Planck" {
		t.Errorf("RequiredApprovers = %v, want [Luthiel Ludwig-Planck]", RequiredApprovers)
	}
}
