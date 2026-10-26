package dsh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
)

type connNetworkKey struct{}

// stampConnNetwork records the transport a connection arrived on so the
// handler can refuse anything that is not a local pipe or socket.
func stampConnNetwork(ctx context.Context, conn net.Conn) context.Context {
	network := ""
	switch conn.RemoteAddr().(type) {
	case *net.UnixAddr:
		network = NetworkUnix
	default:
		network = conn.RemoteAddr().Network()
	}
	return context.WithValue(ctx, connNetworkKey{}, network)
}

// localTransport reports whether the request arrived over the control
// plane's local transport. Connections whose network is unknown (in-process
// handler tests) are refused too: only unix and pipe are ever accepted.
func localTransport(r *http.Request) bool {
	network, _ := r.Context().Value(connNetworkKey{}).(string)
	return network == NetworkUnix || network == NetworkPipe
}

func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	limited := io.LimitReader(r.Body, maxRequestBodyBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	if len(body) > maxRequestBodyBytes {
		return nil, fmt.Errorf("request body exceeds %d bytes", maxRequestBodyBytes)
	}
	return body, nil
}

type readCloser struct {
	*bytes.Reader
}

func (readCloser) Close() error { return nil }

func newReadCloser(body []byte) io.ReadCloser {
	return readCloser{Reader: bytes.NewReader(body)}
}

// decodeBody strictly decodes a JSON request body: unknown fields are
// rejected so a client cannot smuggle policy vocabulary (grants, risk
// classes, shell or argv payloads) past the endpoint schema.
func decodeBody(body []byte, dst any) error {
	if len(bytes.TrimSpace(body)) == 0 {
		return errors.New("request body is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	if decoder.More() {
		return errors.New("request body must contain a single JSON object")
	}
	return nil
}

// forbiddenRequestKeys are payload keys no dsh-control/v1 request may carry.
// Node and Pi must not submit their own grant, risk classification, provider
// credential, merge permission, or a raw shell/argv payload: those decisions
// belong to dsh.
var forbiddenRequestKeys = map[string]bool{
	"shell":               true,
	"argv":                true,
	"command":             true,
	"cmd":                 true,
	"grant":               true,
	"capability_grant":    true,
	"risk_class":          true,
	"risk":                true,
	"provider_credential": true,
	"credential":          true,
	"credentials":         true,
	"secret":              true,
	"secrets":             true,
	"provider_token":      true,
	"api_key":             true,
	"merge_permission":    true,
	"merge":               true,
}

// rejectForbiddenKeys walks a decoded payload and refuses any object key in
// the forbidden set, at any depth. It runs before endpoint decoding so the
// rejection is uniform across the surface.
func rejectForbiddenKeys(body []byte) error {
	var payload any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	var walk func(value any, path string) error
	walk = func(value any, path string) error {
		switch typed := value.(type) {
		case map[string]any:
			for key, child := range typed {
				if forbiddenRequestKeys[key] {
					return fmt.Errorf("field %q is not permitted in a dsh-control/v1 request", joinPath(path, key))
				}
				if err := walk(child, joinPath(path, key)); err != nil {
					return err
				}
			}
		case []any:
			for i, child := range typed {
				if err := walk(child, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(payload, "")
}

func joinPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// captureWriter buffers a response so an idempotent replay can be recorded
// and later returned byte-for-byte.
type captureWriter struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
	wrote  bool
}

func (c *captureWriter) WriteHeader(status int) {
	if c.wrote {
		return
	}
	c.wrote = true
	c.status = status
	c.ResponseWriter.WriteHeader(status)
}

func (c *captureWriter) Write(chunk []byte) (int, error) {
	if !c.wrote {
		c.WriteHeader(http.StatusOK)
	}
	c.body.Write(chunk)
	return c.ResponseWriter.Write(chunk)
}

func idempotencyFingerprint(method, path string, body []byte) string {
	payload := append([]byte(method+"\n"+path+"\n"), body...)
	return sha256Hex(payload)
}
