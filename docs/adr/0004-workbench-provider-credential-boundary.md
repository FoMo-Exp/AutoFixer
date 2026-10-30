# ADR 0004: Workbench provider-account credential boundary

**Status:** Accepted

**Date:** 2026-10-28

## Context

The workbench Settings feature lets an operator bind a personal access token
(PAT) for GitHub or GitLab so the task composer can discover repositories and
branches. ADR-0003 states that "Node, Pi, and UI are not trusted to … read
provider credentials" — a boundary written for the *service-side* credential
plane, where a compromise of Node or Pi could exfiltrate credentials the
service holds. Operator-entered Git provider PATs are a different case: the
operator owns the credential, types it into their own desktop app, and its
purpose is UI convenience (discovery), never task execution.

Binding provider accounts therefore requires a decision about where the
token lives and which network edges may carry it, without weakening the
ADR-0003 execution boundary.

## Decision

1. **The Node service and dsh never see provider tokens.** Provider
   discovery is entirely a workbench concern: the Node API surface
   (`forgepilot-api/v1`) and the dsh control plane are unchanged, and task
   execution keeps using the repository ids the operator selects — dsh
   continues to enforce its own repository governance.
2. **Tokens live only in the Electron main process.** The renderer sends a
   typed token over the settings IPC bridge once, for verification; it is
   persisted in `<userData>/provider-accounts.json` (0600, atomic replace)
   and no IPC response ever contains it. Renderer state holds the token only
   while the operator is typing it, same as any password field.
3. **Provider requests are pinned to the bound instance origin.** The main
   process derives the API base from the validated instance URL (https
   origin; GitHub.com → api.github.com, GHE → /api/v3, GitLab → /api/v4) and
   refuses any request whose origin deviates, so a crafted repository or
   owner name cannot redirect a stored token.
4. **The settings IPC surface reuses the API proxy's trust guard.** Only the
   app window's top frame (validated trusted-sender + trusted URL) may call
   `forgepilot:settings:*`.

This narrows, and does not widen, the ADR-0003 boundary: the untrusted
parties there were Node/Pi-side processes; here the holder is the operator's
own desktop app, and the credential never crosses into the service plane.
A future decision to move discovery server-side would require its own ADR.

## Consequences

- PATs are stored as plaintext JSON with owner-only permissions, matching
  the existing local token-file pattern (dsh boot token, Node api-token).
  Moving to the OS keychain is a possible follow-up, not a blocker.
- Binding a provider account requires the desktop app; plain-browser
  development degrades to free-text repository/branch input.
- The operator's PAT scope determines discovery visibility; the workbench
  requests no scopes and cannot widen them.
