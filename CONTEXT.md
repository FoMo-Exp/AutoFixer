# AutoFixer

AutoFixer is a least-privilege remediation system that prepares auditable changes without bypassing repository governance.

## Language

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
