package dsh

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHealthNeedsNoCredentials(t *testing.T) {
	env := startEnv(t)
	status, raw := env.doWith("GET", "/v1/health", nil, map[string]*string{
		HeaderProtocol:  nil,
		HeaderBootToken: nil,
		HeaderRequestID: nil,
	})
	wantStatus(t, status, raw, http.StatusOK)

	health := decodeInto[healthResponse](t, raw)
	if health.Service != "dsh" || health.Status != "ready" {
		t.Fatalf("unexpected health identity: %+v", health)
	}
	if len(health.Protocol.Supported) != 1 || health.Protocol.Supported[0] != "1" || health.Protocol.Default != "1" {
		t.Fatalf("unexpected protocol block: %+v", health.Protocol)
	}
	if health.ContractVersion != "1.0.0" || health.PolicyVersion != "dsh-policy-1" {
		t.Fatalf("unexpected versions: %q / %q", health.ContractVersion, health.PolicyVersion)
	}
	if !health.Capabilities["local_transport_only"] || health.Capabilities["provider_write"] {
		t.Fatalf("unexpected capabilities: %+v", health.Capabilities)
	}
}

func TestHealthRejectsUnsupportedProtocol(t *testing.T) {
	env := startEnv(t)
	status, raw := env.doWith("GET", "/v1/health", nil, map[string]*string{
		HeaderProtocol: strPtr("2"),
	})
	body := wantError(t, status, raw, http.StatusUpgradeRequired, CodeProtocolUnsupported)
	// Health carries no request-id requirement, but an id sent by the client
	// is still echoed in the error envelope.
	if body.Error.RequestID == "" {
		t.Fatalf("error envelope must echo the provided request id: %+v", body.Error)
	}
}

func TestAuthGatesEveryNonHealthEndpoint(t *testing.T) {
	env := startEnv(t)

	status, raw := env.doWith("GET", "/v1/runs/run_x", nil, map[string]*string{
		HeaderProtocol: nil,
	})
	wantError(t, status, raw, http.StatusUpgradeRequired, CodeProtocolUnsupported)

	status, raw = env.doWith("GET", "/v1/runs/run_x", nil, map[string]*string{
		HeaderBootToken: strPtr("not-the-token"),
	})
	wantError(t, status, raw, http.StatusForbidden, CodeScopeDenied)

	status, raw = env.doWith("GET", "/v1/runs/run_x", nil, map[string]*string{
		HeaderRequestID: nil,
	})
	body := wantError(t, status, raw, http.StatusBadRequest, CodeInvalidRequest)
	if body.Error.RequestID != "" {
		t.Fatalf("envelope must not invent a request id the client never sent: %+v", body.Error)
	}
}

func TestWritesRequireIdempotencyKey(t *testing.T) {
	env := startEnv(t)
	status, raw := env.doWith("POST", "/v1/runs", lowRiskCreate("tsk_missing_key"), map[string]*string{
		HeaderIdempotency: nil,
	})
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidRequest)
}

func TestIdempotencyReplaysAndConflicts(t *testing.T) {
	env := startEnv(t)
	fixed := strPtr("idem_fixed")

	oneStatus, oneRaw := env.doWith("POST", "/v1/runs", lowRiskCreate("tsk_idem_2"), map[string]*string{
		HeaderIdempotency: fixed,
	})
	wantStatus(t, oneStatus, oneRaw, http.StatusCreated)

	twoStatus, twoRaw := env.doWith("POST", "/v1/runs", lowRiskCreate("tsk_idem_2"), map[string]*string{
		HeaderIdempotency: fixed,
	})
	wantStatus(t, twoStatus, twoRaw, http.StatusCreated)
	if string(twoRaw) != string(oneRaw) {
		t.Fatalf("idempotent replay diverged:\n first: %s\nsecond: %s", oneRaw, twoRaw)
	}

	otherStatus, otherRaw := env.doWith("POST", "/v1/runs", lowRiskCreate("tsk_idem_3"), map[string]*string{
		HeaderIdempotency: fixed,
	})
	wantError(t, otherStatus, otherRaw, http.StatusConflict, CodeIdempotencyConflict)
}

func TestNonLocalConnectionsAreRefused(t *testing.T) {
	env := startEnv(t)
	handler := env.server.httpSrv.Handler

	// A request stamped with a TCP origin never reaches a route.
	tcpRequest := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/v1/health", nil)
	tcpRequest = tcpRequest.WithContext(stampConnContext(tcpRequest, "tcp"))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, tcpRequest)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("tcp-stamped request status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
	body := decodeError(t, recorder.Body.Bytes())
	if body.Error.Code != CodeScopeDenied {
		t.Fatalf("tcp-stamped request code = %q, want %q", body.Error.Code, CodeScopeDenied)
	}

	// The bound listener itself must be the unix socket, never a port.
	if addr := env.server.Addr(); addr == nil || addr.Network() != NetworkUnix {
		t.Fatalf("listener network = %v, want unix", addr)
	}
	if _, err := os.Stat(env.server.SocketPath()); err != nil {
		t.Fatalf("socket file missing: %v", err)
	}
}

func TestRejectsForbiddenPolicyVocabulary(t *testing.T) {
	env := startEnv(t)

	cases := []struct {
		name string
		path string
		body map[string]any
	}{
		{"risk class on create", "/v1/runs", map[string]any{
			"task_id":    "tsk_forbidden",
			"risk_class": "low",
		}},
		{"grant on approval", "/v1/runs/run_x/approvals", map[string]any{
			"approval_id": "apr_1",
			"grant":       map[string]any{"capability_grant_version": "x"},
		}},
		{"shell on action", "/v1/runs/run_x/actions", map[string]any{
			"action_id": "act_1",
			"shell":     "rm -rf /",
		}},
		{"argv nested in intent", "/v1/runs/run_x/actions", map[string]any{
			"action_id": "act_2",
			"intent":    map[string]any{"tool_id": "echo", "argv": []string{"sh"}},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, raw := env.do("POST", tc.path, tc.body)
			wantError(t, status, raw, http.StatusBadRequest, CodeInvalidRequest)
		})
	}
}

func TestUnknownEndpointUsesErrorEnvelope(t *testing.T) {
	env := startEnv(t)
	status, raw := env.do("GET", "/v2/runs", nil)
	body := wantError(t, status, raw, http.StatusNotFound, CodeInvalidRequest)
	if !strings.Contains(body.Error.Message, "endpoint") {
		t.Fatalf("unexpected message %q", body.Error.Message)
	}
}

func TestTokenFileIsPrivate(t *testing.T) {
	env := startEnv(t)
	info, err := os.Stat(env.server.TokenPath())
	if err != nil {
		t.Fatalf("token file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token file mode = %o, want 600", perm)
	}
	raw, err := os.ReadFile(env.server.TokenPath())
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	if strings.TrimSpace(string(raw)) != env.server.BootToken() {
		t.Fatalf("token file does not carry the boot token")
	}
}

func TestCreateValidatesRepositoryIdentityAndBaseSHA(t *testing.T) {
	env := startEnv(t)

	badIdentity := lowRiskCreate("tsk_bad_identity")
	badIdentity.Repository.URL = "https://github.com/other/repo.git"
	status, raw := env.do("POST", "/v1/runs", badIdentity)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidRepositoryIdentity)

	badSHA := lowRiskCreate("tsk_bad_sha")
	badSHA.Repository.BaseSHA = "not-a-sha"
	status, raw = env.do("POST", "/v1/runs", badSHA)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidBaseSHA)

	// A consistent but foreign repository is refused at the create boundary:
	// evidence assembly could never succeed for it, so the run must not exist.
	foreign := lowRiskCreate("tsk_foreign_repo")
	foreign.Repository.RepositoryID = "github:acme/payments"
	foreign.Repository.URL = "https://github.com/acme/payments.git"
	status, raw = env.do("POST", "/v1/runs", foreign)
	body := wantError(t, status, raw, http.StatusBadRequest, CodeInvalidRepositoryIdentity)
	if !strings.Contains(body.Error.Message, "allowed AutoFixer repository") {
		t.Fatalf("unexpected message %q", body.Error.Message)
	}
}

func TestTaskCannotHaveTwoActiveRuns(t *testing.T) {
	env := startEnv(t)
	status, raw := env.do("POST", "/v1/runs", lowRiskCreate("tsk_active"))
	wantStatus(t, status, raw, http.StatusCreated)

	status, raw = env.do("POST", "/v1/runs", lowRiskCreate("tsk_active"))
	wantError(t, status, raw, http.StatusConflict, CodeTaskAlreadyHasActiveRun)
}

func TestEventCursorAndLimitValidation(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_cursor"))

	status, raw := env.do("GET", "/v1/runs/"+created.RunID+"/events?after_sequence=-1", nil)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidEventCursor)

	status, raw = env.do("GET", "/v1/runs/"+created.RunID+"/events?limit=0", nil)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidLimit)

	status, raw = env.do("GET", "/v1/runs/"+created.RunID+"/events?after_sequence=abc", nil)
	wantError(t, status, raw, http.StatusBadRequest, CodeInvalidEventCursor)
}

func TestUnknownArtifactIsNotFound(t *testing.T) {
	env := startEnv(t)
	created := createRun(t, env, lowRiskCreate("tsk_artifact"))
	status, raw := env.do("GET", "/v1/runs/"+created.RunID+"/artifacts/evidence_log", nil)
	wantError(t, status, raw, http.StatusNotFound, CodeArtifactNotFound)
}

// stampConnContext attaches a transport label the way the server's
// ConnContext does, so a handler-level test can imitate a TCP origin.
func stampConnContext(r *http.Request, network string) context.Context {
	return context.WithValue(r.Context(), connNetworkKey{}, network)
}

// TestTokenFileRefusesSymlink plants a symlink at the token path pointing at
// a victim file: Listen must refuse, and the victim must stay untouched.
func TestTokenFileRefusesSymlink(t *testing.T) {
	dir := filepath.Join(os.TempDir(), fmt.Sprintf("dsh-symlink-%d", os.Getpid()))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	victim := filepath.Join(dir, "victim.txt")
	if err := os.WriteFile(victim, []byte("precious"), 0o600); err != nil {
		t.Fatalf("write victim: %v", err)
	}
	socketPath := filepath.Join(dir, "dsh.sock")
	tokenPath := socketPath + ".token"
	if err := os.Symlink(victim, tokenPath); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	server, err := New(Config{
		SocketPath: socketPath,
		Approvers:  []string{"github:aphrodite"},
	})
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	if err := server.Listen(); err == nil {
		_ = server.Close()
		t.Fatalf("Listen must refuse a pre-planted token symlink")
	}
	raw, err := os.ReadFile(victim)
	if err != nil {
		t.Fatalf("read victim: %v", err)
	}
	if string(raw) != "precious" {
		t.Fatalf("victim file was modified through the symlink: %q", raw)
	}
}

// TestConcurrentSameKeyExecutesOnce fires two identical POSTs with one
// idempotency key; both must observe the same single run.
func TestConcurrentSameKeyExecutesOnce(t *testing.T) {
	env := startEnv(t)
	body := lowRiskCreate("tsk_same_key")
	key := strPtr("idem_same_key")

	const workers = 2
	type result struct {
		status int
		raw    []byte
	}
	results := make(chan result, workers)
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		go func() {
			<-start
			status, raw := env.doWith("POST", "/v1/runs", body, map[string]*string{
				HeaderIdempotency: key,
			})
			results <- result{status, raw}
		}()
	}
	close(start)

	var runID string
	for i := 0; i < workers; i++ {
		res := <-results
		wantStatus(t, res.status, res.raw, http.StatusCreated)
		created := decodeInto[createRunResponse](t, res.raw)
		if runID == "" {
			runID = created.RunID
		} else if created.RunID != runID {
			t.Fatalf("concurrent same-key creates diverged: %q vs %q", runID, created.RunID)
		}
	}
	// Exactly one run exists for the task.
	status, raw := env.do("GET", "/v1/runs/"+runID, nil)
	wantStatus(t, status, raw, http.StatusOK)
}

// TestRetryableFailureIsNotFrozenIntoLedger proves a 429 is delivered but
// not recorded: the same key retried after the busy window re-executes
// (observing the run's new state) instead of replaying the cached 429.
func TestRetryableFailureIsNotFrozenIntoLedger(t *testing.T) {
	env := startEnv(t, func(cfg *Config) {
		cfg.Now = time.Now
	})
	created := createRun(t, env, lowRiskCreate("tsk_retryable", "sleep"))

	sleepAction := func(actionID string) actionRequest {
		req := echoAction(actionID)
		req.Intent.ToolID = "sleep"
		req.Intent.Arguments = json.RawMessage(`{"seconds":"5"}`)
		return req
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		env.do("POST", "/v1/runs/"+created.RunID+"/actions", sleepAction("act_holder"))
	}()

	time.Sleep(300 * time.Millisecond)
	busyKey := strPtr("idem_busy_action")
	status, raw := env.doWith("POST", "/v1/runs/"+created.RunID+"/actions",
		sleepAction("act_retry"), map[string]*string{HeaderIdempotency: busyKey})
	wantError(t, status, raw, http.StatusTooManyRequests, CodeRunBusy)

	status, raw = cancelRun(t, env, created.RunID, "github:aphrodite")
	wantStatus(t, status, raw, http.StatusAccepted)
	<-done

	// Same key, same payload: the ledger must not replay the cached 429.
	// The run is now cancelled, so a re-execution answers 409.
	status, raw = env.doWith("POST", "/v1/runs/"+created.RunID+"/actions",
		sleepAction("act_retry"), map[string]*string{HeaderIdempotency: busyKey})
	wantError(t, status, raw, http.StatusConflict, CodeTaskStateConflict)
}
