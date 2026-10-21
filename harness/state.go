package harness

// State is a remediation-run state from the FP-01 governance ADR.
type State string

const (
	StateRequested        State = "requested"
	StateApproved         State = "approved"
	StateRunning          State = "running"
	StateAwaitingReview   State = "awaiting_review"
	StateApprovedForMerge State = "approved_for_merge"
	StateStopped          State = "stopped"
	StateTimedOut         State = "timed_out"
	StateExpired          State = "expired"
	StateRejected         State = "rejected"
	StateCancelled        State = "cancelled"
	StateMerged           State = "merged"
)

// adrTransitions mirrors the FP-01 run-state table exactly. Terminal states
// have no outgoing edges: a later attempt is a new run_id in `requested`.
var adrTransitions = map[State]map[State]bool{
	StateRequested: {
		StateApproved:  true,
		StateRejected:  true,
		StateCancelled: true,
	},
	StateApproved: {
		StateRunning:   true,
		StateCancelled: true,
		StateExpired:   true,
	},
	StateRunning: {
		StateAwaitingReview: true,
		StateStopped:        true,
		StateTimedOut:       true,
		StateCancelled:      true,
	},
	StateAwaitingReview: {
		StateApprovedForMerge: true,
		StateStopped:          true,
		StateCancelled:        true,
	},
	StateApprovedForMerge: {
		StateMerged:  true,
		StateStopped: true,
	},
	StateStopped: {
		StateCancelled: true,
		StateApproved:  true, // new grant only
	},
	StateTimedOut:  {},
	StateExpired:   {},
	StateRejected:  {},
	StateCancelled: {},
	StateMerged:    {},
}

// IsValidState reports whether s is one of the eleven ADR state values.
func IsValidState(s State) bool {
	_, ok := adrTransitions[s]
	return ok
}

// IsTerminal reports whether s is terminal for its capability grant.
func IsTerminal(s State) bool {
	edges, ok := adrTransitions[s]
	return ok && len(edges) == 0
}

// CanTransition reports whether the ADR state table permits from -> to.
// Unknown states and self-transitions are denied.
func CanTransition(from, to State) bool {
	edges, ok := adrTransitions[from]
	if !ok || from == to {
		return false
	}
	return edges[to]
}
