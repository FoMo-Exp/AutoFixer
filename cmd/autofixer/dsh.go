package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Luthiel/AutoFixer/agent/loop"
	"github.com/Luthiel/AutoFixer/dsh"
)

// dshCommand runs the local dsh-control/v1 server over a Unix socket (a
// Named Pipe on Windows) until it receives an interrupt or termination
// signal. It binds no TCP port: the control boundary stays local-only.
func dshCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: autofixer dsh serve --socket <path> [--approver <identity>]...")
		return loop.ExitInvalidInput
	}
	if args[0] != "serve" {
		fmt.Fprintf(stderr, "unknown dsh subcommand %q\n", args[0])
		fmt.Fprintln(stderr, "usage: autofixer dsh serve --socket <path> [--approver <identity>]...")
		return loop.ExitInvalidInput
	}

	flags := flag.NewFlagSet("dsh serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	socket := flags.String("socket", defaultSocketPath(), "unix socket path (or pipe name on Windows)")
	network := flags.String("network", dsh.NetworkUnix, "local transport: unix or pipe")
	workspace := flags.String("workspace-root", "", "directory sandboxes create their workspaces under")
	var approvers multiFlag
	flags.Var(&approvers, "approver", "identity allowed to approve and cancel runs (repeatable)")
	if err := flags.Parse(args[1:]); err != nil {
		return loop.ExitInvalidInput
	}
	if *socket == "" {
		fmt.Fprintln(stderr, "--socket is required")
		return loop.ExitInvalidInput
	}
	if len(approvers) == 0 {
		approvers = multiFlag{"github:aphrodite"}
	}

	server, err := dsh.New(dsh.Config{
		SocketPath:    *socket,
		Network:       *network,
		Approvers:     approvers,
		WorkspaceRoot: *workspace,
	})
	if err != nil {
		fmt.Fprintf(stderr, "dsh: %v\n", err)
		return loop.ExitInvalidInput
	}
	if err := server.Start(); err != nil {
		fmt.Fprintf(stderr, "dsh: %v\n", err)
		return loop.ExitControlFailure
	}

	fmt.Fprintf(stdout, "dsh-control/v1 listening on %s (%s)\n", server.SocketPath(), *network)
	fmt.Fprintf(stdout, "boot token file: %s\n", server.TokenPath())
	fmt.Fprintln(stdout, "press Ctrl-C to stop")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- server.Close() }()
	select {
	case err := <-done:
		if err != nil {
			fmt.Fprintf(stderr, "dsh: shutdown: %v\n", err)
			return loop.ExitControlFailure
		}
	case <-shutdownCtx.Done():
		fmt.Fprintln(stderr, "dsh: shutdown timed out")
		return loop.ExitControlFailure
	}
	return loop.ExitOK
}

func defaultSocketPath() string {
	return fmt.Sprintf("%s/dsh-control.sock", os.TempDir())
}

type multiFlag []string

func (m *multiFlag) String() string { return fmt.Sprint([]string(*m)) }

func (m *multiFlag) Set(value string) error {
	if value == "" {
		return fmt.Errorf("approver identity must not be empty")
	}
	*m = append(*m, value)
	return nil
}
