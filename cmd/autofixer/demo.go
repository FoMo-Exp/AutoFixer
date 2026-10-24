package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"time"

	"github.com/Luthiel/AutoFixer/agent/loop"
	"github.com/Luthiel/AutoFixer/delivery"
)

// goldenTaskJSON is the single offline golden-task fixture: a controlled,
// low-risk task input whose scripted plan dispatches one allow-listed echo
// tool through the composed planner, registry, sandbox, and harness, then
// produces a not_created evidence bundle. The repository is the one delivery
// allows so the bundle validates.
//
//go:embed testdata/golden-task.json
var goldenTaskJSON []byte

func demoCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("demo", flag.ContinueOnError)
	fs.SetOutput(stderr)
	format := fs.String("format", formatText, "output format: text or json")
	timeout := fs.String("timeout", "", "task timeout as a Go duration, overrides the fixture")
	if err := fs.Parse(args); err != nil {
		return loop.ExitInvalidInput
	}
	if *format != formatText && *format != formatJSON {
		fmt.Fprintf(stderr, "demo: unknown --format %q (want text or json)\n", *format)
		return loop.ExitInvalidInput
	}

	var file fileInput
	if err := json.Unmarshal(goldenTaskJSON, &file); err != nil {
		return writeError(stdout, *format, fmt.Errorf("parse golden task fixture: %w", err), loop.ExitControlFailure, nil)
	}
	if err := delivery.ValidateRepositoryURL(file.Repository.URL); err != nil {
		return writeError(stdout, *format, fmt.Errorf("golden task repository: %w", err), loop.ExitControlFailure, nil)
	}
	var timeoutOverride time.Duration
	if *timeout != "" {
		parsed, err := time.ParseDuration(*timeout)
		if err != nil {
			return writeError(stdout, *format, fmt.Errorf("--timeout: %w", err), loop.ExitInvalidInput, nil)
		}
		timeoutOverride = parsed
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	return finishTask(ctx, file, timeoutOverride, *format, stdout, stderr)
}
