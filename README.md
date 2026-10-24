# AutoFixer

AutoFixer is a least-privilege remediation prototype. It prepares and
validates auditable remediation evidence without bypassing repository
governance.

## Current developer entry point

This revision provides a Go CLI, `autofixer`, that composes the offline
agent prototype end to end: controlled task input → deterministic plan →
allow-listed tool dispatch through the existing sandbox and harness policy →
application evidence timeline → delivery evidence bundle. The reproducible
developer demo is the golden task:

```sh
go run ./cmd/autofixer demo
```

The same composition runs any controlled task input file:

```sh
go run ./cmd/autofixer run --input cmd/autofixer/testdata/golden-task.json --format json
```

Commands, flags, and output were confirmed against the implemented `--help`
surface and an observed local run. For the focused demo paths (successful
state-machine flow, refusal, and cancellation), the expected evidence fields,
and the prototype's safety boundaries, see
[the prototype demo guide](docs/prototype-demo.md).

The full offline verification suite is:

```sh
go test ./...
```

The versioned record contract is in
[`docs/contracts/task-evidence-contract-v1.md`](docs/contracts/task-evidence-contract-v1.md).

## Safety boundaries

The demo is local and offline. It never opens a real pull request, modifies
`main`, or requires a GitHub credential. The registry allow-list and the
harness capability grant are independent deny-by-default gates; a tool must
clear both before it runs. Terminal outcomes — completion, illegal plan,
risk refusal, tool or grant denial, cancellation, and timeout — all leave an
auditable evidence bundle with no bypass side effects.
