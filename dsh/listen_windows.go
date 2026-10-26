//go:build windows

package dsh

import (
	"fmt"
	"net"
	"strings"

	"github.com/Microsoft/go-winio"
)

// listen binds a Windows Named Pipe. The default pipe DACL grants access to
// the creating user only, so the pipe is as local-only as the Unix socket.
func listen(network, socketPath string) (net.Listener, error) {
	if network != NetworkPipe && network != NetworkUnix {
		return nil, fmt.Errorf("dsh: transport %q is not available on this platform", network)
	}
	if network == NetworkUnix {
		return listenWindowsUnix(socketPath)
	}
	name := socketPath
	if !strings.HasPrefix(name, `\\.\pipe\`) {
		name = `\\.\pipe\` + name
	}
	ln, err := winio.ListenPipe(name, &winio.PipeConfig{})
	if err != nil {
		return nil, fmt.Errorf("dsh: listen on named pipe: %w", err)
	}
	return ln, nil
}

func listenWindowsUnix(socketPath string) (net.Listener, error) {
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("dsh: listen on unix socket: %w", err)
	}
	return ln, nil
}
