# AutoFixer

AutoFixer is a least-privilege remediation system that prepares auditable changes without bypassing repository governance.

## Language

**Enterprise**:
The organization that owns its AutoFixer workspaces and governs access to its
repositories, operational data, and remediation activity.
_Avoid_: repository owner, workspace

**Workspace**:
An enterprise's collaboration space for one repository, with selected members
and teams. A developer may belong to multiple workspaces.
_Avoid_: local working directory, multi-repository project

**Team**:
A workspace group with an active human leader and a declared area of
responsibility, used to route issues when individual ownership is insufficient.
_Avoid_: agent squad, automatic approval authority

**Change approval**:
A human decision permitting delivery of a specific proposed change after
reviewing its summary, diff, and validation evidence, before a PR is created.
_Avoid_: PR review, security recovery approval, approval quorum

**Remediation run**:
A bounded attempt to diagnose one reported problem and prepare a proposed repository change under a task-specific capability grant.
_Avoid_: autonomous deployment, unattended fix

**Capability grant**:
The explicit, time-bounded set of repository, tool, and network actions allowed to one remediation run.
_Avoid_: blanket access, agent permission

**Approval quorum**:
The simultaneous approvals by Luthiel and Ludwig-Planck on the current pull-request head.
_Avoid_: owner approval, maintainer approval

**Stop condition**:
An observable event that ends a remediation run and requires human triage before further action.
_Avoid_: recoverable warning
