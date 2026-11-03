import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  IdentityClient,
  InvitationPreview,
  InvitationRedemption,
  LoginProvider,
  SessionInfo,
} from "../api/identity";
import { loginPath } from "../api/identity";
import { ErrorNotice } from "./ErrorNotice";
import type { ErrorDescription } from "./identity-format";
import { describeError, formatTimestamp, isUnauthenticated } from "./identity-format";
import { stashInviteToken } from "./invite-token";

interface InviteJoinProps {
  client: IdentityClient;
  /** Captured from the landing URL fragment; cleared from history already. */
  token: string;
  /** Called when the visitor leaves the invitation flow. */
  onDismiss: () => void;
}

type JoinPhase = "session" | "sign-in" | "preview" | "ready" | "joining" | "joined" | "denied";

export function InviteJoin({ client, token, onDismiss }: InviteJoinProps): ReactElement {
  const [phase, setPhase] = useState<JoinPhase>("session");
  const [session, setSession] = useState<SessionInfo>();
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [preview, setPreview] = useState<InvitationPreview>();
  const [joined, setJoined] = useState<InvitationRedemption>();
  const [error, setError] = useState<ErrorDescription>();
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);

  const loadPreview = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setPhase("preview");
    try {
      const result = await client.previewInvitation(token);
      setPreview(result);
      setPhase("ready");
    } catch (caught) {
      setError(describeError(caught));
      setPhase("denied");
    } finally {
      setBusy(false);
    }
  }, [client, token]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setPhase("session");
    client
      .getSession()
      .then((activeSession) => {
        if (requestRef.current !== requestId) return;
        setSession(activeSession);
        return loadPreview();
      })
      .catch((caught: unknown) => {
        if (requestRef.current !== requestId) return;
        if (isUnauthenticated(caught)) {
          setPhase("sign-in");
          void client
            .listLoginProviders()
            .then(setProviders)
            .catch(() => setProviders([]));
          return;
        }
        setError(describeError(caught));
        setPhase("denied");
      });
    return () => {
      requestRef.current += 1;
    };
  }, [client, loadPreview]);

  async function join(): Promise<void> {
    setPhase("joining");
    setError(undefined);
    try {
      const result = await client.redeemInvitation(token);
      setJoined(result);
      setPhase("joined");
    } catch (caught) {
      setError(describeError(caught));
      setPhase("denied");
    }
  }

  function startLogin(providerInstanceId: string): void {
    stashInviteToken(token, typeof window === "undefined" ? undefined : window.sessionStorage);
    window.location.assign(loginPath(providerInstanceId, "/"));
  }

  const browserSignIn = typeof window !== "undefined" && /^https?:$/.test(window.location.protocol);

  return (
    <div className="invite-screen">
      <section className="invite-card" aria-labelledby="invite-title">
        <div className="invite-card-heading">
          <span className="eyebrow">Workspace invitation</span>
          <h1 id="invite-title">
            {phase === "joined" && joined
              ? joined.workspace.name
              : (preview?.workspace.name ?? "Join a workspace")}
          </h1>
        </div>

        {error && <ErrorNotice error={error} onDismiss={() => setError(undefined)} />}

        {phase === "session" && <p className="card-empty">Checking your session…</p>}
        {phase === "preview" && <p className="card-empty">Checking this invitation…</p>}

        {phase === "sign-in" && (
          <div className="invite-section">
            <p className="identity-meta">
              {browserSignIn
                ? "Sign in to accept this invitation."
                : "Sign in to the ForgePilot app to accept this invitation."}
            </p>
            {browserSignIn && providers.length > 0 ? (
              <div className="invite-providers">
                {providers.map((provider) => (
                  <button
                    key={provider.provider_instance_id}
                    className="button button-secondary"
                    onClick={() => startLogin(provider.provider_instance_id)}
                  >
                    {`Continue with ${provider.provider_type === "github" ? "GitHub" : "GitLab"}`}
                  </button>
                ))}
              </div>
            ) : (
              browserSignIn && <p className="identity-meta">No sign-in provider is configured.</p>
            )}
          </div>
        )}

        {(phase === "preview" || phase === "ready" || phase === "joining") && preview && (
          <div className="invite-section">
            <dl className="invite-details">
              <div>
                <dt>Enterprise</dt>
                <dd>{preview.enterprise.name}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>Member</dd>
              </div>
              <div>
                <dt>Invited by</dt>
                <dd>{preview.inviter.display_name}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{formatTimestamp(preview.expires_at)}</dd>
              </div>
            </dl>
            {preview.already_joined && <span className="identity-badge">Already joined</span>}
            <div className="invite-actions">
              <button
                className="button button-primary"
                disabled={busy || phase === "joining"}
                onClick={() => void join()}
              >
                {phase === "joining"
                  ? "Joining…"
                  : preview.already_joined
                    ? "Continue"
                    : "Join workspace"}
              </button>
              <button className="button button-quiet" onClick={onDismiss}>
                Not now
              </button>
            </div>
          </div>
        )}

        {phase === "denied" && !joined && (
          <div className="invite-actions">
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => void loadPreview()}
            >
              Try again
            </button>
            <button className="button button-quiet" onClick={onDismiss}>
              Close
            </button>
          </div>
        )}

        {phase === "joined" && joined && (
          <div className="invite-section">
            <p className="identity-meta">{`Joined as ${joined.membership.role}`}</p>
            <div className="invite-actions">
              <button className="button button-primary" onClick={onDismiss}>
                Open workspace
              </button>
            </div>
          </div>
        )}

        {session && (
          <p className="identity-meta invite-session">
            {`Signed in as ${session.user.display_name}`}
          </p>
        )}
      </section>
    </div>
  );
}
