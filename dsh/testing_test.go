package dsh

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Luthiel/AutoFixer/delivery"
)

// frozenClock pins every server-derived timestamp so contract fixtures stay
// byte-stable. The instant sits far enough in the future that a grant's
// wall-clock deadline is still in the future for the real sandbox clock, so
// dispatches run normally instead of expiring on arrival.
func frozenClock() time.Time {
	return time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)
}

type testEnv struct {
	t      *testing.T
	server *Server
	client *http.Client
	reqSeq atomic.Int64
}

func startEnv(t *testing.T, mods ...func(*Config)) *testEnv {
	t.Helper()
	var idSeq atomic.Int64
	var socketSeq atomic.Int64
	// The socket path stays short: sun_path caps Unix socket paths at 104
	// bytes on macOS, which a nested t.TempDir() path can exceed.
	cfg := Config{
		SocketPath: filepath.Join(os.TempDir(), fmt.Sprintf("dsh-test-%d-%d.sock", os.Getpid(), socketSeq.Add(1))),
		Approvers:  []string{"github:aphrodite"},
		Now:        func() time.Time { return frozenClock() },
		NewID: func(prefix string) string {
			return fmt.Sprintf("%s%016x", prefix, idSeq.Add(1))
		},
	}
	for _, mod := range mods {
		mod(&cfg)
	}
	server, err := New(cfg)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	if err := server.Start(); err != nil {
		t.Fatalf("start server: %v", err)
	}
	t.Cleanup(func() {
		if err := server.Close(); err != nil {
			t.Errorf("close server: %v", err)
		}
	})
	if addr := server.Addr(); addr == nil || addr.Network() != NetworkUnix {
		t.Fatalf("server must bind the local unix transport, got %v", addr)
	}

	env := &testEnv{t: t, server: server}
	env.client = &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", cfg.SocketPath)
			},
		},
	}
	return env
}

// do issues one authenticated request and returns the status and body.
func (e *testEnv) do(method, path string, body any) (int, []byte) {
	e.t.Helper()
	return e.doWith(method, path, body, nil)
}

// doWith issues a request with explicit header overrides; a nil value for a
// managed header means "send no value", which is how auth rejections are
// exercised.
func (e *testEnv) doWith(method, path string, body any, headers map[string]*string) (int, []byte) {
	e.t.Helper()

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			e.t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, "http://dsh.local"+path, reader)
	if err != nil {
		e.t.Fatalf("new request: %v", err)
	}
	requestID := fmt.Sprintf("req_%d", e.reqSeq.Add(1))
	set := func(key, value string) {
		if override, present := headers[key]; present {
			if override == nil {
				return
			}
			req.Header.Set(key, *override)
			return
		}
		req.Header.Set(key, value)
	}
	set(HeaderProtocol, ProtocolVersion)
	set(HeaderBootToken, e.server.BootToken())
	set(HeaderRequestID, requestID)
	set(HeaderContentType, contentTypeJSON)
	if method == http.MethodPost {
		set(HeaderIdempotency, "idem_"+requestID)
	}
	for key, override := range headers {
		if override == nil {
			req.Header.Del(key)
		} else {
			req.Header.Set(key, *override)
		}
	}

	res, err := e.client.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		e.t.Fatalf("read body: %v", err)
	}
	return res.StatusCode, raw
}

// headerless returns a pointer to an empty header value override.
func headerless() *string { return new(string) }

func strPtr(value string) *string { return &value }

func decodeInto[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode response %s: %v", raw, err)
	}
	return out
}

type errorBody struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		RequestID string         `json:"request_id"`
		Retryable bool           `json:"retryable"`
		Details   map[string]any `json:"details"`
	} `json:"error"`
}

func decodeError(t *testing.T, raw []byte) errorBody {
	t.Helper()
	return decodeInto[errorBody](t, raw)
}

func wantError(t *testing.T, status int, raw []byte, wantStatus int, wantCode string) errorBody {
	t.Helper()
	if status != wantStatus {
		t.Fatalf("status = %d, want %d (body %s)", status, wantStatus, raw)
	}
	body := decodeError(t, raw)
	if body.Error.Code != wantCode {
		t.Fatalf("error code = %q, want %q (body %s)", body.Error.Code, wantCode, raw)
	}
	return body
}

func wantStatus(t *testing.T, status int, raw []byte, want int) {
	t.Helper()
	if status != want {
		t.Fatalf("status = %d, want %d (body %s)", status, want, raw)
	}
}

// lowRiskCreate builds a localized reversible change, which classifies low
// and is granted without an approval step. The repository is the pilot's
// only allowed mutation target — delivery refuses any other URL when the
// evidence bundle is assembled.
func lowRiskCreate(taskID string, tools ...string) createRequest {
	if len(tools) == 0 {
		tools = []string{"echo"}
	}
	return createRequest{
		TaskID: taskID,
		Issue: issueRef{
			Provider:        "github",
			ExternalID:      "1234",
			SourceReference: "https://github.com/Luthiel/AutoFixer/issues/1234",
		},
		Repository: repositoryRef{
			RepositoryID: "github:Luthiel/AutoFixer",
			URL:          delivery.AllowedRepositoryURL,
			BaseRef:      "main",
			BaseSHA:      "ab12cd3ef456789012345678901234567890abcd",
		},
		Request: taskRequest{
			Summary:            "Fix export exception.",
			AcceptanceCriteria: []string{"Focused test passes"},
			RequestedBy:        requestedBy{ActorID: "usr_01J", DisplayName: "Aphrodite Luminare"},
		},
		ProposedWork: proposedWork{LocalizedReversibleChange: true},
		RequestedScope: requestedScope{
			PathHints:           []string{"web/src/export/**"},
			ToolCapabilities:    tools,
			MaxWallClockSeconds: 60,
		},
	}
}

// elevatedCreate signals a broad refactor, which classifies elevated and
// stays in `requested` until an approval records the pre-grant decision.
func elevatedCreate(taskID string) createRequest {
	req := lowRiskCreate(taskID, "echo")
	req.ProposedWork = proposedWork{BroadRefactor: true}
	return req
}

func prohibitedCreate(taskID string) createRequest {
	req := lowRiskCreate(taskID)
	req.ProposedWork = proposedWork{RequestsSecretAccess: true}
	return req
}

func echoAction(actionID string) actionRequest {
	return actionRequest{
		ActionID: actionID,
		Agent:    actionAgent{Runtime: "pi", SessionID: "pis_01", TurnID: "turn_1"},
		Intent: actionIntent{
			ToolID:    "echo",
			Arguments: json.RawMessage(`{"message":"hello"}`),
			PathScope: []string{"web/src/export/export-button.test.ts"},
			Rationale: "Verify the regression.",
		},
	}
}

func approvalBody(approvalID, decision, digest string) map[string]any {
	return map[string]any{
		"approval_id": approvalID,
		"decision":    decision,
		"approved_by": map[string]any{
			"actor_id": "usr_01J",
			"identity": "github:aphrodite",
		},
		"approved_at":  frozenClock().Format(time.RFC3339),
		"scope_digest": digest,
	}
}

func cancelBody(identity string) map[string]any {
	return map[string]any{
		"requested_by": map[string]any{
			"actor_id": "usr_01J",
			"identity": identity,
		},
		"reason": "User stopped the task.",
	}
}
