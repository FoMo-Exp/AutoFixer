// Command autofixer is the local CLI entry point for the AutoFixer agent
// prototype. It parses arguments, composes the task loop from explicitly
// injected dependencies — the deterministic agent/planner, the allow-list
// agent/tools registry in front of the existing sandbox, the agent/session
// timeline, and the delivery evidence bundle — and maps terminal results to
// output and exit codes. It owns no policy, planning logic, or execution:
// those stay with harness, sandbox, and the composed packages behind
// agent/loop.
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/Luthiel/AutoFixer/agent/loop"
)

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdout, os.Stderr))
}

func runCLI(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printUsage(stderr)
		return loop.ExitInvalidInput
	}
	switch args[0] {
	case "run":
		return runCommand(args[1:], stdout, stderr)
	case "demo":
		return demoCommand(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", args[0])
		printUsage(stderr)
		return loop.ExitInvalidInput
	}
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, "usage: autofixer run --input <task.json|-> [--format text|json] [--timeout <duration>]")
	fmt.Fprintln(w, "       autofixer demo [--format text|json] [--timeout <duration>]")
}
