import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { IdentityClient, LoginProvider, WorkspaceSession } from "../api/identity";
import type { AuthStatus } from "./controller";
import { Select } from "../ui/Select";
import { describeError } from "../workspaces/identity-format";
import blackHoleImage from "../assets/startup-blackhole-realistic.png";
import { BlackHoleMotion } from "./BlackHoleMotion";
import { CodeAccretionStreams } from "./CodeAccretionStreams";

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
    <div className="auth-shell auth-mode-shell">
      <div className="auth-mode-backdrop" aria-hidden="true" />
      <div className="auth-mode-visual" aria-hidden="true">
        <img className="auth-mode-black-hole" src={blackHoleImage} alt="" />
        <BlackHoleMotion />
        <CodeAccretionStreams />
      </div>
      <header className="auth-mode-header">
        <BrandMark caption="受控修复工作台" />
        <span>双闸门 · 人工把关</span>
      </header>
      <main className="auth-mode-main">
        <section className="auth-mode-headline" aria-labelledby="auth-mode-title">
          <h1 id="auth-mode-title">让信号穿过双闸门</h1>
          <p>先选择工作区入口，再开始一条可审查的修复路径。</p>
        </section>
        <div className="auth-mode-visual-space" aria-hidden="true" />
        <section className="auth-mode-choices" aria-label="选择登录方式">
          <div className="auth-mode-choice-list">
            <button className="button button-provider auth-mode-option" onClick={onEnterprise}>
              <span className="provider-name">企业登录</span>
              <span className="provider-host">组织 GitHub / GitLab</span>
            </button>
            <button className="button button-provider auth-mode-option" onClick={onPersonal}>
              <span className="provider-name">个人登录</span>
              <span className="provider-host">本机个人工作区</span>
            </button>
          </div>
        </section>
      </main>
      <footer className="auth-mode-footer">信号进入后，每一步修复都会等待人工把关。</footer>
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
  onBack,
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
            {onBack && (
              <button className="button button-quiet" onClick={onBack}>
                返回登录方式
              </button>
            )}
          </>
        )}
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
    <div className="auth-shell">
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
              返回登录方式
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
