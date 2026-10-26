package dsh

import (
	"encoding/json"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

var updateFixtures = flag.Bool("update", false, "rewrite docs/fixtures/dsh-control-v1 golden files")

// fixtureDir is the Node-consumable fixture set the contract promises: real
// frozen-env responses, byte-stable, so an external client can assert shapes
// without standing up the control plane.
const fixtureDir = "../docs/fixtures/dsh-control-v1"

// checkFixture compares a response body against its golden file, or rewrites
// it under -update.
func checkFixture(t *testing.T, name string, payload []byte) {
	t.Helper()
	path := filepath.Join(fixtureDir, name)
	// Fixtures store the response pretty-printed for human review; the
	// comparison normalizes both sides through the same encoding.
	var normalized any
	if err := json.Unmarshal(payload, &normalized); err != nil {
		t.Fatalf("fixture %s payload is not JSON: %v", name, err)
	}
	encoded, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		t.Fatalf("encode fixture %s: %v", name, err)
	}
	encoded = append(encoded, '\n')

	if *updateFixtures {
		if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
			t.Fatalf("create fixture dir: %v", err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatalf("write fixture %s: %v", name, err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s (run go test ./dsh -update to create): %v", name, err)
	}
	if string(want) != string(encoded) {
		t.Fatalf("fixture %s diverged from live response:\n--- golden ---\n%s\n--- live ---\n%s",
			name, want, encoded)
	}
}

// TestContractFixtures walks the frozen-env golden flows the Node contract
// tests consume: health, tool schemas, low/elevated/prohibited creates,
// approval, a dispatched action, and the contract error envelopes.
func TestContractFixtures(t *testing.T) {
	env := startEnv(t)

	status, raw := env.doWith("GET", "/v1/health", nil, map[string]*string{
		HeaderProtocol:  nil,
		HeaderBootToken: nil,
		HeaderRequestID: nil,
	})
	wantStatus(t, status, raw, http.StatusOK)
	checkFixture(t, "health.json", raw)

	toolsPayload, err := json.Marshal(defaultToolSpecs())
	if err != nil {
		t.Fatalf("marshal tools: %v", err)
	}
	checkFixture(t, "tools.json", toolsPayload)

	status, raw = env.do("POST", "/v1/runs", lowRiskCreate("tsk_fixture_low"))
	wantStatus(t, status, raw, http.StatusCreated)
	checkFixture(t, "create-low-risk.json", raw)
	low := decodeInto[createRunResponse](t, raw)

	status, raw = env.do("POST", "/v1/runs", elevatedCreate("tsk_fixture_elevated"))
	wantStatus(t, status, raw, http.StatusCreated)
	checkFixture(t, "create-elevated.json", raw)

	status, raw = env.do("POST", "/v1/runs", prohibitedCreate("tsk_fixture_prohibited"))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("prohibited create status = %d, want %d", status, http.StatusUnprocessableEntity)
	}
	checkFixture(t, "create-prohibited-error.json", raw)

	// The approval fixture uses its own elevated run so the earlier ones
	// stay in their recorded states.
	status, raw = env.do("POST", "/v1/runs", elevatedCreate("tsk_fixture_approve"))
	wantStatus(t, status, raw, http.StatusCreated)
	approvable := decodeInto[createRunResponse](t, raw)
	status, raw = env.do("POST", "/v1/runs/"+approvable.RunID+"/approvals",
		approvalBody("apr_fixture", "approve", approvable.RequiredAction.ScopeDigest))
	wantStatus(t, status, raw, http.StatusOK)
	checkFixture(t, "approval.json", raw)

	status, raw = env.do("POST", "/v1/runs/"+low.RunID+"/actions", echoAction("act_fixture"))
	wantStatus(t, status, raw, http.StatusAccepted)
	checkFixture(t, "action-accepted.json", raw)

	status, raw = env.doWith("GET", "/v1/health", nil, map[string]*string{
		HeaderProtocol: strPtr("2"),
	})
	checkFixture(t, "error-protocol-unsupported.json", raw)
	if status != http.StatusUpgradeRequired {
		t.Fatalf("protocol mismatch status = %d", status)
	}

	status, raw = env.doWith("GET", "/v1/runs/"+low.RunID, nil, map[string]*string{
		HeaderBootToken: strPtr("not-the-token"),
	})
	checkFixture(t, "error-boot-token.json", raw)
	if status != http.StatusForbidden {
		t.Fatalf("boot token status = %d", status)
	}

	status, raw = env.do("POST", "/v1/runs", map[string]any{
		"task_id":    "tsk_fixture_forbidden",
		"risk_class": "low",
	})
	checkFixture(t, "error-forbidden-vocabulary.json", raw)
	if status != http.StatusBadRequest {
		t.Fatalf("forbidden vocabulary status = %d", status)
	}

	unregistered := echoAction("act_fixture_unregistered")
	unregistered.Intent.ToolID = "sh"
	status, raw = env.do("POST", "/v1/runs/"+low.RunID+"/actions", unregistered)
	checkFixture(t, "error-tool-not-registered.json", raw)
	if status != http.StatusNotFound {
		t.Fatalf("unregistered tool status = %d", status)
	}
}
