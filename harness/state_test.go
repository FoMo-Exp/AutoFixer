package harness

import "testing"

func TestIsValidState(t *testing.T) {
	valid := []State{
		StateRequested, StateApproved, StateRunning, StateAwaitingReview,
		StateApprovedForMerge, StateStopped, StateTimedOut, StateExpired,
		StateRejected, StateCancelled, StateMerged,
	}
	for _, s := range valid {
		if !IsValidState(s) {
			t.Errorf("IsValidState(%q) = false, want true", s)
		}
	}
	invalid := []State{"", "pending", "Approved", "done", "approved_for_merge ", "unknown"}
	for _, s := range invalid {
		if IsValidState(s) {
			t.Errorf("IsValidState(%q) = true, want false", s)
		}
	}
}

func TestIsTerminal(t *testing.T) {
	terminal := []State{StateTimedOut, StateExpired, StateRejected, StateCancelled, StateMerged}
	for _, s := range terminal {
		if !IsTerminal(s) {
			t.Errorf("IsTerminal(%q) = false, want true", s)
		}
	}
	nonTerminal := []State{StateRequested, StateApproved, StateRunning, StateAwaitingReview, StateApprovedForMerge, StateStopped}
	for _, s := range nonTerminal {
		if IsTerminal(s) {
			t.Errorf("IsTerminal(%q) = true, want false", s)
		}
	}
}

func TestCanTransitionAllowsAdrTableTransitions(t *testing.T) {
	allowed := []struct{ from, to State }{
		{StateRequested, StateApproved},
		{StateRequested, StateRejected},
		{StateRequested, StateCancelled},
		{StateApproved, StateRunning},
		{StateApproved, StateCancelled},
		{StateApproved, StateExpired},
		{StateRunning, StateAwaitingReview},
		{StateRunning, StateStopped},
		{StateRunning, StateTimedOut},
		{StateRunning, StateCancelled},
		{StateAwaitingReview, StateApprovedForMerge},
		{StateAwaitingReview, StateStopped},
		{StateAwaitingReview, StateCancelled},
		{StateApprovedForMerge, StateMerged},
		{StateApprovedForMerge, StateStopped},
		{StateStopped, StateCancelled},
		{StateStopped, StateApproved},
	}
	for _, tc := range allowed {
		if !CanTransition(tc.from, tc.to) {
			t.Errorf("CanTransition(%q, %q) = false, want true", tc.from, tc.to)
		}
	}
}

func TestCanTransitionRejectsEverythingElse(t *testing.T) {
	denied := []struct{ from, to State }{
		// skipping stages
		{StateRequested, StateRunning},
		{StateRequested, StateMerged},
		{StateApproved, StateAwaitingReview},
		{StateApproved, StateMerged},
		{StateRunning, StateMerged},
		{StateRunning, StateApproved},
		{StateAwaitingReview, StateMerged},
		{StateStopped, StateRunning},
		{StateStopped, StateMerged},
		// terminal states are absorbing: a new attempt needs a new run_id
		{StateTimedOut, StateRequested},
		{StateTimedOut, StateApproved},
		{StateTimedOut, StateCancelled},
		{StateExpired, StateRequested},
		{StateExpired, StateApproved},
		{StateExpired, StateRunning},
		{StateRejected, StateRequested},
		{StateRejected, StateApproved},
		{StateCancelled, StateRequested},
		{StateCancelled, StateApproved},
		{StateMerged, StateRequested},
		{StateMerged, StateApproved},
		{StateMerged, StateCancelled},
		// no self-transitions
		{StateRequested, StateRequested},
		{StateRunning, StateRunning},
		// invalid states
		{StateRequested, "pending"},
		{"pending", StateRequested},
		{"", StateRequested},
	}
	for _, tc := range denied {
		if CanTransition(tc.from, tc.to) {
			t.Errorf("CanTransition(%q, %q) = true, want false", tc.from, tc.to)
		}
	}
}
