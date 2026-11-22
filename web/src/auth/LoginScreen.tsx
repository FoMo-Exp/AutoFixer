import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { IdentityClient, LoginProvider, WorkspaceSession } from "../api/identity";
import type { AuthStatus } from "./controller";
import { Select } from "../ui/Select";
import { describeError } from "../workspaces/identity-format";
import { EffectLayer } from "../ui/EffectLayer";
import { LOGIN_EFFECT_SETTINGS } from "../ui/image-effects";
import blackHoleImage from "../assets/startup-blackhole-realistic.png";

const loginVideoSrc = new URL("../../assets/login-ASIIC.mp4", import.meta.url).href;

interface LoginScreenProps {
  status: AuthStatus;
  providers: LoginProvider[];
  message?: string;
  desktop: boolean;
  onSignIn: (providerInstanceId: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
  onBack?: () => void;
}

export function LoginModeScreen({
  onEnterprise,
  onPersonal,
}: {
  onEnterprise: () => void;
  onPersonal: () => void;
}): ReactElement {
  return (
    <div className="auth-shell auth-login-shell" lang="en">
      <main className="auth-login-frame">
        <LoginEffectVisual />
        <section
          className="auth-login-form-column auth-login-mode-column"
          aria-labelledby="auth-mode-title"
        >
          <BrandMark caption="Remediation workbench" />
          <h1 id="auth-mode-title">Welcome back</h1>
          <div className="auth-login-mode-options">
            <button className="auth-login-mode-enterprise" onClick={onEnterprise}>
              <span>Continue with organization</span>
              <span>GitHub / GitLab</span>
            </button>
            <div className="auth-login-divider" aria-hidden="true">
              <span>or</span>
            </div>
            <button className="auth-login-mode-local" onClick={onPersonal}>
              <span>Use a local workspace</span>
              <span>This device only</span>
            </button>
          </div>
        </section>
      </main>
    </div>
  );
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

function BrandMark({ caption = "Remediation workbench" }: { caption?: string } = {}): ReactElement {
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
        <div className="brand-caption">{caption}</div>
      </div>
    </div>
  );
}

export function AuthLoadingScreen(): ReactElement {
  return (
    <div className="auth-shell auth-mode-shell auth-loading-shell" lang="en" aria-busy="true">
      <div className="auth-mode-backdrop" aria-hidden="true" />
      <div className="auth-mode-visual" aria-hidden="true">
        <img className="auth-mode-black-hole" src={blackHoleImage} alt="" />
      </div>
      <div className="auth-mode-frame" aria-hidden="true" />
      <header className="auth-mode-header">
        <BrandMark caption="Remediation workbench" />
      </header>
      <main className="auth-loading-main">
        <h1 className="visually-hidden">Confirming workspace session</h1>
        <div className="auth-loading" role="status" aria-live="polite">
          <span className="auth-loading-label">Confirming workspace session</span>
          <span className="auth-loading-bar" aria-hidden="true" />
        </div>
      </main>
      <footer className="auth-mode-footer">
        <span>Connecting to the local ForgePilot service</span>
        <span className="auth-mode-protocol">forgepilot-api/v1</span>
      </footer>
    </div>
  );
}

function LoginEffectVisual(): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <section className="auth-login-visual-column" aria-label="ForgePilot introduction">
      <div className="auth-login-media auth-login-media-full">
        <video
          aria-hidden="true"
          autoPlay
          className="auth-login-video"
          loop
          muted
          playsInline
          preload="metadata"
          ref={videoRef}
          src={loginVideoSrc}
        />
        <EffectLayer
          sourceRef={videoRef}
          settings={LOGIN_EFFECT_SETTINGS}
          lightSurfacePaletteReveal={{
            centerX: 0.5,
            centerY: 0.5,
            radiusX: 0.56,
            radiusY: 0.54,
            feather: 0.22,
            coreRadiusX: 0.26,
            coreRadiusY: 0.29,
            shadowFloor: 0.84,
            shadowSaturation: 0.84,
          }}
        />
        <div className="auth-login-media-copy">
          <span>ForgePilot remediation workspace</span>
          <h2>
            Repairs stay
            <br />
            in human hands.
          </h2>
          <p>Each run is bounded. Every change stays reviewable.</p>
        </div>
      </div>
    </section>
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
  onBack,
}: LoginScreenProps): ReactElement {
  const signingIn = status === "signing_in";
  const expired = status === "expired";
  const failed = status === "error";

  return (
    <div className="auth-shell auth-login-shell" lang="en">
      <main className="auth-login-frame">
        <LoginEffectVisual />

        <section className="auth-login-form-column" aria-labelledby="auth-login-title">
          <BrandMark />
          {signingIn ? (
            <>
              <span className="auth-login-eyebrow">Waiting for the browser</span>
              <h1 id="auth-login-title">Complete sign-in in your browser</h1>
              <p className="auth-lede" role="status" aria-live="polite">
                This window finishes sign-in automatically. Keep it open until your workspace
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
              <span className="auth-login-eyebrow">
                {expired
                  ? "Session expired"
                  : failed
                    ? "Sign-in unavailable"
                    : "Enterprise sign-in"}
              </span>
              <h1 id="auth-login-title">Welcome back</h1>
              <p className="auth-lede">
                {expired
                  ? "Your previous session has expired. Continue with an approved provider to restore workspace access."
                  : "Continue with your organization’s approved identity provider."}
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
                      className="button button-provider auth-login-provider"
                      onClick={() => void onSignIn(provider.provider_instance_id)}
                    >
                      <span className="auth-provider-mark" aria-hidden="true">
                        {provider.provider_type === "github" ? "GH" : "GL"}
                      </span>
                      <span className="auth-provider-copy">
                        <span className="provider-name">
                          Continue with {providerLabel(provider)}
                        </span>
                        <span className="provider-host">{providerHost(provider)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {desktop && (
                <p className="auth-footnote">
                  Sign-in finishes in your system browser. This window receives the session after
                  approval.
                </p>
              )}
              {onBack && (
                <button className="button button-quiet auth-login-back" onClick={onBack}>
                  Back to sign-in options
                </button>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

interface NoWorkspaceScreenProps {
  displayName?: string;
  session?: WorkspaceSession;
  client: IdentityClient;
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onJoinToken: (token: string) => void;
  onBack?: () => void;
}

export function NoWorkspaceScreen({
  displayName,
  session,
  client,
  onRetry,
  onSignOut,
  onJoinToken,
  onBack,
}: NoWorkspaceScreenProps): ReactElement {
  const isEnterpriseAdmin =
    session?.enterprise_roles.some((item) => item.role === "admin") ?? false;
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isEnterpriseAdmin) return;
    void client
      .listLoginProviders()
      .then((items) => {
        setProviders(items);
        setProviderId((current) => current || items[0]?.provider_instance_id || "");
      })
      .catch((caught: unknown) => setError(describeError(caught).message));
  }, [client, isEnterpriseAdmin]);

  const providerOptions = useMemo(
    () =>
      providers.map((provider) => ({
        value: provider.provider_instance_id,
        label: `${provider.provider_type === "github" ? "GitHub" : "GitLab"} · ${providerHost(provider)}`,
      })),
    [providers],
  );

  async function createWorkspace(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await client.createWorkspace({
        name: name.trim(),
        repository_id: repositoryId.trim(),
        provider_instance_id: providerId,
      });
      await onRetry();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  function joinWorkspace(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const token = inviteToken.trim();
    if (!token) return;
    setInviteToken("");
    onJoinToken(token);
  }

  return (
    <div className="auth-shell" lang="en">
      <main className="auth-card">
        <BrandMark />
        <span className="eyebrow">No workspace access</span>
        <h1>{isEnterpriseAdmin ? "Set up your first workspace" : "Join a workspace"}</h1>
        <p className="auth-lede">{displayName ? `${displayName} · ` : ""}Workspace access</p>
        {error && (
          <div className="auth-message" role="alert">
            {error}
          </div>
        )}
        {isEnterpriseAdmin && (
          <form
            className="identity-form onboarding-form"
            onSubmit={(event) => void createWorkspace(event)}
          >
            <label className="field-block">
              <span className="field-label">
                Workspace name <span className="required-dot">*</span>
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
              />
            </label>
            <label className="field-block">
              <span className="field-label">
                Provider instance <span className="required-dot">*</span>
              </span>
              <Select
                value={providerId}
                options={providerOptions}
                onChange={setProviderId}
                disabled={!providers.length}
                ariaLabel="Provider instance"
              />
            </label>
            <label className="field-block">
              <span className="field-label">
                Repository ID <span className="required-dot">*</span>
              </span>
              <input
                value={repositoryId}
                onChange={(event) => setRepositoryId(event.target.value)}
                placeholder="github:org/repository"
                required
              />
            </label>
            <button className="button button-primary" disabled={busy || !providerId}>
              {busy ? "Creating…" : "Create workspace"}
            </button>
          </form>
        )}
        <form className="identity-form onboarding-form" onSubmit={joinWorkspace}>
          <label className="field-block">
            <span className="field-label">
              Invitation code <span className="required-dot">*</span>
            </span>
            <input
              value={inviteToken}
              onChange={(event) => setInviteToken(event.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <button className="button button-secondary" disabled={!inviteToken.trim()}>
            Preview invitation
          </button>
        </form>
        <div className="auth-actions">
          {onBack && (
            <button className="button button-quiet" onClick={onBack}>
              Back to sign-in options
            </button>
          )}
          <button className="button button-quiet" onClick={() => void onRetry()}>
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
