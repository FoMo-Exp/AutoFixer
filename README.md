# AutoFixer

AutoFixer is a least-privilege remediation prototype. It prepares and
validates auditable remediation evidence without bypassing repository
governance.

## Current developer entry point

This revision provides Go packages and their offline test fixtures; it does
**not** yet provide an `autofixer` executable, subcommands, or a supported
end-user command line. The reproducible developer demo is therefore the test
suite:

```sh
go test ./...
```

For the three focused demo paths (successful state-machine flow, refusal, and
cancellation), the expected evidence fields, and the prototype's safety
boundaries, see [the prototype demo guide](docs/prototype-demo.md).

The versioned record contract is in
[`docs/contracts/task-evidence-contract-v1.md`](docs/contracts/task-evidence-contract-v1.md).

## AFP-05 integration status

Command syntax, input files, and emitted report locations remain **pending
AFP-05 integration**. Do not infer or automate a command such as
`autofixer run` from the packages or examples in this repository. Once AFP-05
is merged, this README and the demo guide must be updated from its implemented
`--help` surface and observed output.
