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

**Lesson**:
A workspace-scoped, evidence-cited statement or procedure learned from completed remediation work, carrying a version, provenance, and lifecycle state.
_Avoid_: chat history, personal note, model weight update

**Workspace memory**:
The workspace-scoped store of working context, episodes, facts, lessons, and institutional policy available to later runs; it is advisory and never grants authority.
_Avoid_: global memory, cross-workspace knowledge base

**Enterprise template**:
A scrubbed, versioned memory item explicitly published by an enterprise administrator for other workspaces to adopt locally; adoption never exposes the source workspace's data.
_Avoid_: shared workspace memory, global lesson

**Recursive self-improvement (RSI)**:
The governed loop that proposes, evaluates, canaries, and rolls back changes to workspace memory and retrieval policy from observed outcomes, without modifying guardrails, approvals, or capability grants.
_Avoid_: autonomous self-modification, unrestricted self-training
