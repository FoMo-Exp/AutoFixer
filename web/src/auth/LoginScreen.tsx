import type { ReactElement } from "react";
import type { LoginProvider } from "../api/auth";
import type { AuthStatus } from "./controller";

interface LoginScreenProps {
  status: AuthStatus;
  providers: LoginProvider[];
  message?: string;
  desktop: boolean;
  onSignIn: (providerInstanceId: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
}

function providerLabel(provider: LoginProvider): string {
  return provider.provider_type === "github" ? "GitHub" : "GitLab";
}

function providerHost(provider: LoginProvider): string {
  try {
    return new URL(provider.display_origin).host;
  } catch {
    return provider.display_origin;
  }
}

function BrandMark(): ReactElement {
  return (
    <div className="auth-brand">
      <div className="brand-mark" aria-hidden="true">
        <svg width="30" height="30" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          <rect x="3" y="3.5" width="3.6" height="15" rx="1.2" fill="currentColor" />
          <rect x="15.4" y="3.5" width="3.6" height="15" rx="1.2" fill="currentColor" />
          <circle cx="11" cy="11" r="3" fill="var(--accent)" />
        </svg>
      </div>
      <div>
        <div className="brand-name">ForgePilot</div>
        <div className="brand-caption">Remediation workbench</div>
      </div>
    </div>
  );
}

export function AuthLoadingScreen(): ReactElement {
  return (
    <div className="auth-shell">
      <main className="auth-card" aria-busy="true">
        <BrandMark />
        <h1>Checking your session…</h1>
        <p className="auth-lede">Confirming workspace access with the local ForgePilot service.</p>
      </main>
    </div>
  );
}

export function LoginScreen({
  status,
  providers,
  message,
  desktop,
  onSignIn,
  onCancel,
  onRetry,
}: LoginScreenProps): ReactElement {
  const signingIn = status === "signing_in";
  const expired = status === "expired";
  const failed = status === "error";
  return (
    <div className="auth-shell">
      <main className="auth-card">
        <BrandMark />
        {signingIn ? (
          <>
            <span className="eyebrow">Waiting for the browser</span>
            <h1>Complete sign-in in your browser</h1>
            <p className="auth-lede" role="status" aria-live="polite">
              This window finishes the sign-in automatically. Keep it open until your workspace
              appears.
            </p>
            <div className="auth-actions">
              <button className="button button-quiet" onClick={() => void onCancel()}>
                Cancel sign-in
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="eyebrow">
              {expired ? "Session expired" : failed ? "Sign-in unavailable" : "Enterprise sign-in"}
            </span>
            <h1>{expired ? "Sign in again to continue" : "Sign in to ForgePilot"}</h1>
            <p className="auth-lede">
              {expired
                ? "Your previous session is no longer valid. Sign in with your provider to restore workspace access."
                : "Use your organization's GitHub or GitLab account. Your provider password never reaches ForgePilot."}
            </p>
            {message && (
              <div className="auth-message" role={failed ? "alert" : "status"}>
                {message}
              </div>
            )}
            {providers.length === 0 ? (
              <div className="auth-empty">
                <p>No administrator-approved login provider is available yet.</p>
                <button className="button button-quiet" onClick={() => void onRetry()}>
                  Check again
                </button>
              </div>
            ) : (
              <div className="auth-providers">
                {providers.map((provider) => (
                  <button
                    key={provider.provider_instance_id}
                    className="button button-provider"
                    onClick={() => void onSignIn(provider.provider_instance_id)}
                  >
                    <span className="provider-name">Continue with {providerLabel(provider)}</span>
                    <span className="provider-host">{providerHost(provider)}</span>
                  </button>
                ))}
              </div>
            )}
            {desktop && (
              <p className="auth-footnote">
                Sign-in opens in your system browser. The desktop app receives a session without
                exposing the credential to page code.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

interface NoWorkspaceScreenProps {
  displayName?: string;
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

export function NoWorkspaceScreen({
  displayName,
  onRetry,
  onSignOut,
}: NoWorkspaceScreenProps): ReactElement {
  return (
    <div className="auth-shell">
      <main className="auth-card">
        <BrandMark />
        <span className="eyebrow">No workspace access</span>
        <h1>Your account is not in a workspace yet</h1>
        <p className="auth-lede">
          {displayName ? `${displayName}, ` : ""}you are signed in, but this account has no
          workspace membership. Ask an administrator to add you to a workspace, then check again.
        </p>
        <div className="auth-actions">
          <button className="button button-primary" onClick={() => void onRetry()}>
            Check again
          </button>
          <button className="button button-quiet" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      </main>
    </div>
  );
}
