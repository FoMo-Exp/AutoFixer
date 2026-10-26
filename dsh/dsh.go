// Package dsh implements the local dsh-control/v1 control plane defined by
// docs/contracts/dsh-control-v1.md and docs/adr/0003-pi-orchestration-and-dsh-control-contract.md.
//
// The server binds only a Unix Domain Socket (or a Windows Named Pipe), never
// a TCP port, and every request except /v1/health must carry the protocol
// header, the ephemeral boot token, and a request id. Policy authority stays
// where the prototype already keeps it: harness classifies risk, issues and
// checks capability grants, and appends the evidence chain; the allow-list
// registry and the sandbox are the independent gates in front of execution.
// This package adds transport, request validation, and the endpoint surface —
// it invents no risk class, grant, shell command, or merge permission.
package dsh

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Luthiel/AutoFixer/harness"
)

// Contract and protocol constants reported by /v1/health and required on
// every other request.
const (
	ContractVersion = "1.0.0"
	PolicyVersion   = "dsh-policy-1"
	ProtocolVersion = "1"

	serviceName = "dsh"
)

// Header names mandated by the contract.
const (
	HeaderProtocol      = "X-DSH-Protocol"
	HeaderBootToken     = "X-DSH-Boot-Token"
	HeaderRequestID     = "X-Request-Id"
	HeaderIdempotency   = "Idempotency-Key"
	HeaderContentType   = "Content-Type"
	contentTypeJSON     = "application/json"
	maxRequestBodyBytes = 1 << 20
)

// Networks the control plane may listen on. Anything else — TCP above all —
// is refused, which is what keeps the control boundary local-only.
const (
	NetworkUnix = "unix"
	NetworkPipe = "pipe"
)

// Config configures one control-plane server.
type Config struct {
	// SocketPath is the Unix socket path, or the Windows pipe name when
	// Network is NetworkPipe. Required.
	SocketPath string
	// Network is NetworkUnix (default) or NetworkPipe.
	Network string
	// Approvers holds the identities allowed to record approvals and
	// cancellations. Empty means nobody is authorized, which fails closed.
	Approvers []string
	// Now supplies the clock; tests inject a deterministic one. Defaults
	// to time.Now.
	Now func() time.Time
	// NewID mints server-derived identifiers (run ids). Defaults to a
	// random hex string with the given prefix.
	NewID func(prefix string) string
	// WorkspaceRoot bounds sandbox workspaces; empty uses the system
	// temp directory.
	WorkspaceRoot string
	// ApprovalWindow bounds how long an elevated run stays approvable
	// after creation. Zero uses defaultApprovalWindow.
	ApprovalWindow time.Duration
}

const defaultApprovalWindow = 15 * time.Minute

func (c *Config) applyDefaults() error {
	if c.SocketPath == "" {
		return errors.New("dsh: socket path is required")
	}
	switch c.Network {
	case "":
		c.Network = NetworkUnix
	case NetworkUnix, NetworkPipe:
	default:
		return fmt.Errorf("dsh: network %q is not a local-only transport (allowed: unix, pipe)", c.Network)
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.NewID == nil {
		c.NewID = func(prefix string) string {
			var buf [8]byte
			if _, err := rand.Read(buf[:]); err != nil {
				return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano())
			}
			return prefix + hex.EncodeToString(buf[:])
		}
	}
	if len(c.Approvers) == 0 {
		return errors.New("dsh: at least one authorized approver identity is required")
	}
	if c.ApprovalWindow <= 0 {
		c.ApprovalWindow = defaultApprovalWindow
	}
	return nil
}

// authorizedIdentity reports whether identity may approve or cancel runs.
func (c Config) authorizedIdentity(identity string) bool {
	if identity == "" {
		return false
	}
	for _, approver := range c.Approvers {
		if approver == identity {
			return true
		}
	}
	return false
}

// Server is one local control-plane instance.
type Server struct {
	cfg       Config
	bootToken string
	tokenPath string

	store  *store
	tools  *toolRegistry
	events *harness.EventStore

	httpSrv *http.Server
	ln      net.Listener

	mu        sync.Mutex
	started   bool
	closed    bool
	closeOnce sync.Once
	closeErr  error
}

// New builds a server. Call Listen to bind the local transport and Serve (or
// Start) to begin accepting requests.
func New(cfg Config) (*Server, error) {
	if err := cfg.applyDefaults(); err != nil {
		return nil, err
	}
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:       cfg,
		bootToken: token,
		tokenPath: tokenFilePath(cfg.Network, cfg.SocketPath),
		store:     newStore(),
		tools:     newToolRegistry(defaultToolSpecs()),
		events:    harness.NewEventStore(),
	}
	mux := http.NewServeMux()
	s.routes(mux)
	s.httpSrv = &http.Server{
		Handler:      s.handler(mux),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		ConnContext:  stampConnNetwork,
	}
	return s, nil
}

// BootToken is the ephemeral token every non-health request must present.
func (s *Server) BootToken() string { return s.bootToken }

// SocketPath is the bound transport address.
func (s *Server) SocketPath() string { return s.cfg.SocketPath }

// TokenPath is the 0600 file the boot token is written to, so an external
// client (the Node orchestration layer) can discover it without a TCP
// handshake.
func (s *Server) TokenPath() string { return s.tokenPath }

// Listen binds the local transport and writes the boot-token file. It is
// idempotent. The socket's parent directory must be a private directory
// owned by this user, so neither the socket nor the token can be planted or
// swapped through a shared world-writable path.
func (s *Server) Listen() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("dsh: server is closed")
	}
	if s.started {
		return nil
	}
	// On unix the token sits beside the socket, so one directory check
	// covers both; pipe mode derives its token path inside the runtime dir.
	if err := ensureSecureDir(filepath.Dir(s.tokenPath)); err != nil {
		return err
	}
	ln, err := listen(s.cfg.Network, s.cfg.SocketPath)
	if err != nil {
		return err
	}
	if err := writeTokenFile(s.tokenPath, s.bootToken); err != nil {
		_ = ln.Close()
		return err
	}
	s.ln = ln
	s.started = true
	return nil
}

// Addr returns the bound address, or nil before Listen.
func (s *Server) Addr() net.Addr {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln == nil {
		return nil
	}
	return s.ln.Addr()
}

// Start binds the transport and serves in the background.
func (s *Server) Start() error {
	if err := s.Listen(); err != nil {
		return err
	}
	go func() { _ = s.Serve() }()
	return nil
}

// Serve accepts requests until the server is closed. It blocks.
func (s *Server) Serve() error {
	if err := s.Listen(); err != nil {
		return err
	}
	s.mu.Lock()
	ln := s.ln
	s.mu.Unlock()
	err := s.httpSrv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

// Close stops accepting requests, removes the socket and token files, and
// tears down every run workspace. It is safe to call more than once.
func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		started := s.started
		ln := s.ln
		s.mu.Unlock()

		var errs []error
		if started {
			if err := s.httpSrv.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errs = append(errs, err)
			}
		}
		if ln != nil {
			// http.Server.Close already closes its listener; a second close
			// reports net.ErrClosed, which is the desired end state.
			if err := ln.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				errs = append(errs, err)
			}
		}
		if err := removeSocketFile(s.cfg.Network, s.cfg.SocketPath); err != nil {
			errs = append(errs, err)
		}
		if err := os.Remove(s.tokenPath); err != nil && !os.IsNotExist(err) {
			errs = append(errs, err)
		}
		errs = append(errs, s.store.closeRuns()...)
		s.closeErr = errors.Join(errs...)
	})
	return s.closeErr
}

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/health", s.handleHealth)
	mux.HandleFunc("POST /v1/runs", s.handleCreateRun)
	mux.HandleFunc("GET /v1/runs/{run_id}", s.handleGetRun)
	mux.HandleFunc("POST /v1/runs/{run_id}/approvals", s.handleApproval)
	mux.HandleFunc("POST /v1/runs/{run_id}/actions", s.handleSubmitAction)
	mux.HandleFunc("POST /v1/runs/{run_id}/cancel", s.handleCancel)
	mux.HandleFunc("GET /v1/runs/{run_id}/events", s.handleEvents)
	mux.HandleFunc("GET /v1/runs/{run_id}/evidence-bundle", s.handleEvidenceBundle)
	mux.HandleFunc("GET /v1/runs/{run_id}/artifacts/{artifact_id}", s.handleArtifact)
	// Unknown paths and methods answer in the contract's error envelope
	// instead of the mux's plain-text 404.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusNotFound, CodeInvalidRequest,
			"No such dsh-control/v1 endpoint.", map[string]any{"path": r.URL.Path})
	})
}

func (s *Server) handler(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !localTransport(r) {
			writeError(w, r, http.StatusForbidden, CodeScopeDenied,
				"Control plane accepts only local UDS or named-pipe connections.", nil)
			return
		}
		if r.URL.Path == "/v1/health" {
			s.handleHealth(w, r)
			return
		}
		if err := s.authenticate(r); err != nil {
			writeError(w, r, err.status, err.code, err.message, err.details)
			return
		}
		if r.Method == http.MethodPost {
			s.serveIdempotent(w, r, mux)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) authenticate(r *http.Request) *requestError {
	protocol := r.Header.Get(HeaderProtocol)
	if protocol != ProtocolVersion {
		return &requestError{
			status:  http.StatusUpgradeRequired,
			code:    CodeProtocolUnsupported,
			message: fmt.Sprintf("Protocol version %q is unsupported; dsh speaks %q.", protocol, ProtocolVersion),
		}
	}
	token := r.Header.Get(HeaderBootToken)
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.bootToken)) != 1 {
		return &requestError{
			status:  http.StatusForbidden,
			code:    CodeScopeDenied,
			message: "Local control token is missing or invalid.",
			details: map[string]any{"reason": "boot_token"},
		}
	}
	if requestID := r.Header.Get(HeaderRequestID); requestID == "" || len(requestID) > 128 {
		return &requestError{
			status:  http.StatusBadRequest,
			code:    CodeInvalidRequest,
			message: "X-Request-Id is required and must be at most 128 bytes.",
		}
	}
	return nil
}

type requestError struct {
	status  int
	code    string
	message string
	details map[string]any
}

// serveIdempotent reads the request body once, joins or claims the key
// atomically, replays a recorded response for a completed key, and waits for
// the owner when the same key is already in flight — so two concurrent
// identical POSTs execute exactly once. Retryable failures (429/503) are
// delivered to in-flight waiters but never frozen into the ledger: a client
// following the standard retry pattern re-executes instead of replaying a
// cached failure forever.
func (s *Server) serveIdempotent(w http.ResponseWriter, r *http.Request, mux *http.ServeMux) {
	key := r.Header.Get(HeaderIdempotency)
	if key == "" || len(key) > 256 {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest,
			"Idempotency-Key is required on write requests.", nil)
		return
	}
	body, err := readBody(r)
	if err != nil {
		writeError(w, r, http.StatusBadRequest, CodeInvalidRequest, err.Error(), nil)
		return
	}
	r.Body = newReadCloser(body)

	fingerprint := idempotencyFingerprint(r.Method, r.URL.Path, body)
	entry, owner, conflict := s.store.beginIdempotent(key, fingerprint, s.cfg.Now().UTC())
	if conflict {
		writeError(w, r, http.StatusConflict, CodeIdempotencyConflict,
			"Idempotency-Key was already used with a different payload.", nil)
		return
	}
	if !owner {
		<-entry.done
		w.Header().Set(HeaderContentType, contentTypeJSON)
		w.WriteHeader(entry.status)
		_, _ = w.Write(entry.body)
		return
	}

	finished := false
	defer func() {
		if !finished {
			// A panic escaped the handler; release waiters with a
			// non-recorded failure so their retry re-executes.
			s.store.finishIdempotent(key, entry, http.StatusInternalServerError,
				[]byte(`{"error":{"code":"DSH_UNAVAILABLE","message":"handler failed","request_id":"","retryable":true,"details":{}}}`),
				false)
		}
	}()
	capture := &captureWriter{ResponseWriter: w, status: http.StatusOK}
	mux.ServeHTTP(capture, r)
	finished = true
	s.store.finishIdempotent(key, entry, capture.status, capture.body.Bytes(),
		!retryableStatus(capture.status))
}

// retryableStatus reports whether a response invites a same-key retry: the
// classes writeError marks `retryable: true`.
func retryableStatus(status int) bool {
	return status == http.StatusServiceUnavailable || status == http.StatusTooManyRequests
}

// randomToken mints the ephemeral per-start boot token.
func randomToken() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("dsh: mint boot token: %w", err)
	}
	return hex.EncodeToString(buf[:]), nil
}

// ensureSecureDir creates the private runtime directory on first use and
// always verifies it: a shared or symlinked parent would let a stranger
// plant the socket or the boot-token file.
func ensureSecureDir(dir string) error {
	if dir == "" || dir == "." {
		return errors.New("dsh: runtime files must live in an explicit private directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("dsh: create runtime directory: %w", err)
	}
	return verifySecureDir(dir)
}

// writeTokenFile creates the boot-token file exclusively, so a pre-planted
// regular file, symlink, or directory at the path is refused rather than
// truncated or followed. A leftover regular file from a previous run of ours
// (same owner, inside our private runtime directory) is reopened and
// rewritten.
func writeTokenFile(path, token string) error {
	file, err := openExclusive(path, 0o600)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("dsh: write boot token file: %w", err)
		}
		file, err = openOwned(path)
		if err != nil {
			return fmt.Errorf("dsh: boot token file %q already exists and is not a file this server may rewrite: %w", path, err)
		}
	}
	defer func() { _ = file.Close() }()
	if err := verifyOwnedFile(file); err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("dsh: restrict boot token file permissions: %w", err)
	}
	if _, err := file.WriteString(token + "\n"); err != nil {
		return fmt.Errorf("dsh: write boot token file: %w", err)
	}
	return nil
}

// DefaultRuntimeDir is the private per-user directory the CLI places the
// default socket and token in, away from shared world-writable paths.
func DefaultRuntimeDir() string {
	return defaultRuntimeDir()
}

func tokenFilePath(network, socketPath string) string {
	if network == NetworkPipe {
		// The pipe name is attacker-visible, so the token file name is a
		// digest of it inside our private runtime directory rather than a
		// fixed shared path.
		sum := sha256.Sum256([]byte(socketPath))
		return filepath.Join(defaultRuntimeDir(), "dsh-token-"+hex.EncodeToString(sum[:8])+".token")
	}
	return socketPath + ".token"
}

func removeSocketFile(network, socketPath string) error {
	if network == NetworkPipe {
		return nil
	}
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
