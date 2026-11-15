import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ApiConfigurationError, ApiError, ForgePilotClient } from "./api/client";
import type { ArtifactMetadata, RunSummary, Task, TaskEvent, TaskStatus } from "./api/client";
import { IdentityClient } from "./api/identity";
import type { Workspace } from "./api/identity";
import { resolveApiConfig } from "./api/config";
import type { ApiConfig } from "./api/config";
import { useAuth } from "./auth/useAuth";
import type { AuthApi } from "./auth/useAuth";
import {
  AuthLoadingScreen,
  LoginModeScreen,
  LoginScreen,
  NoWorkspaceScreen,
} from "./auth/LoginScreen";
import { useTaskStream } from "./api/hooks";
import { IssuesWorkbench } from "./issues/IssuesWorkbench";
import { MemoryWorkbench } from "./memory/MemoryWorkbench";
import { RsiWorkbench } from "./memory/RsiWorkbench";
import { DashboardWorkbench } from "./dashboard/DashboardWorkbench";
import { SecurityWorkbench } from "./security/SecurityWorkbench";
import { CreateIdempotencyKeys } from "./api/idempotency";
import {
  clearStoredWorkspaceId,
  readStoredWorkspaceId,
  resolveWorkspace,
  storeWorkspaceId,
} from "./workspaces/selection";
import {
  WorkspaceChooser,
  WorkspaceSwitcher,
  WorkspaceUnavailableScreen,
} from "./workspaces/WorkspaceSwitcher";
import { RepositoryPicker } from "./settings/RepositoryPicker";
import { SettingsDialog } from "./settings/SettingsDialog";
import { captureInviteToken } from "./workspaces/invite-token";
import { InviteJoin } from "./workspaces/InviteJoin";
import { WorkspaceAdminDialog } from "./workspaces/WorkspaceAdminDialog";
import {
  approvalScopeDigest,
  buildTimelineRows,
  eventLabel,
  eventSummary,
  formatDate,
  formatStatus,
  piTurnSummary,
  progressPercent,
  shortId,
  TERMINAL_STATUSES,
} from "./ui/format";
import type { PiTurnRow } from "./ui/format";
import { HeroLogo } from "./ui/HeroLogo";
import { piSummaryHeadline, piSummaryStateLabel, resolvePiSummary } from "./ui/pi-summary";
import { redactText, sanitizeValue } from "./ui/redaction";
import { Select } from "./ui/Select";
import { applyScrollMode, getScrollMode } from "./ui/scroll-mode";
import type { ScrollMode } from "./ui/scroll-mode";
import { useStackFold } from "./ui/use-stack-fold";
import { useAmbientDrift } from "./ui/use-ambient-drift";
import { useSurfaceTabIndicator } from "./ui/use-surface-tab-indicator";
import { applyGlassMode, useGlassMode } from "./ui/glass";
import type { GlassMode } from "./ui/glass";
import { useLiquidGlass } from "./ui/use-liquid-glass";
import { useScrollFade } from "./ui/use-scroll-fade";

const STATUS_FILTERS: Array<"all" | TaskStatus> = [
  "all",
  "awaiting_approval",
  "executing",
  "awaiting_review",
  "approved_for_merge",
  "stopped",
  "merged",
  "cancelled",
];

interface CreateTaskForm {
  repositoryId: string;
  baseRef: string;
  summary: string;
  sourceReference: string;
  acceptanceCriteria: string;
}

const INITIAL_FORM: CreateTaskForm = {
  repositoryId: "github:FoMo-Exp/AutoFixer",
  baseRef: "main",
  summary: "",
  sourceReference: "",
  acceptanceCriteria: "",
};

/** A workspace task is created against the workspace's own repository binding. */
function initialForm(workspace: Workspace | undefined): CreateTaskForm {
  if (workspace === undefined) return INITIAL_FORM;
  return { ...INITIAL_FORM, repositoryId: workspace.repository.repository_id };
}

type ServiceStatus = "connecting" | "connected" | "offline";

type SurfaceView = "home" | "tasks" | "issues" | "memory" | "rsi" | "dashboard" | "security";

/**
 * Browser-tab glyphs for the top surface strip. They are decorative: the
 * accessible name stays the tab's text label.
 */
const SURFACE_ICONS: Record<SurfaceView, ReactElement> = {
  home: (
    <svg
      className="surface-tab-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
    </svg>
  ),
  tasks: (
    <svg
      className="surface-tab-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9 6h11M9 12h11M9 18h7" />
      <path d="m3 6 1.2 1.2L6.5 5" />
      <path d="m3 12 1.2 1.2L6.5 11" />
    </svg>
  ),
  issues: (
    <svg
      className="surface-tab-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </svg>
  ),
  memory: (
    <svg
      className="surface-tab-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  ),
  rsi: (
    <svg
      className="surface-tab-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  ),
  dashboard: (
    <svg
      className="surface-tab-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  security: (
    <svg
      className="surface-tab-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6l-7-3Z" />
    </svg>
  ),
};

function SurfaceIcon({ surface }: { surface: SurfaceView }): ReactElement {
  return SURFACE_ICONS[surface];
}

/** Droplet = the near-clear liquid material; frosted square = the dense one. */
function GlassModeIcon({ mode }: { mode: GlassMode }): ReactElement {
  if (mode === "liquid") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3.2c3.4 4.1 5.8 7.2 5.8 10.1a5.8 5.8 0 1 1-11.6 0C6.2 10.4 8.6 7.3 12 3.2Z" />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="5" />
      <path d="M8 13.5c1.3-1.6 2.7-1.6 4 0s2.7 1.6 4 0" />
    </svg>
  );
}

function isTaskArchived(task: Task): boolean {
  return task.archived ?? task.status === "cancelled";
}

interface WorkbenchProps {
  config: ApiConfig;
  auth: AuthApi;
  identityClient: IdentityClient;
  /** Undefined only for the legacy local-operator seam and startup failures. */
  workspace?: Workspace;
  workspaces: Workspace[];
  onSelectWorkspace: (workspaceId: string) => void;
  onWorkspaceUnavailable: () => void;
  initialSurface?: SurfaceView;
  onSurfaceChange?: (surface: SurfaceView) => void;
}

const NOOP = (): void => undefined;

function useApiClient(
  config: ApiConfig,
  authRef: { current: AuthApi },
  workspaceId: string | null,
): ForgePilotClient {
  return useMemo(
    () =>
      new ForgePilotClient({
        baseUrl: config.baseUrl,
        token: config.token,
        workspaceId,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        csrfToken: () => authRef.current.csrfToken(),
        refreshCsrfToken: () => authRef.current.refreshCsrfToken(),
        onUnauthorized: () => authRef.current.handleUnauthorized(),
        onForbidden: (error) => authRef.current.handleForbidden(error.message),
      }),
    [authRef, config, workspaceId],
  );
}

export default function App(): ReactElement {
  const config = useMemo(resolveApiConfig, []);
  const [loginMode, setLoginMode] = useState<"choose" | "enterprise" | "personal">("choose");
  const [inviteToken, setInviteToken] = useState<string>();
  const inviteTokenRef = useRef<string | undefined>(undefined);

  // Registered before useAuth so the fragment is captured and cleared before
  // the auth controller's session request can observe it.
  useEffect(() => {
    const token = captureInviteToken(
      window.location.hash,
      window.history,
      window.sessionStorage,
      `${window.location.pathname}${window.location.search}`,
    );
    if (!token) return;
    inviteTokenRef.current = token;
    setInviteToken(token);
  }, []);

  const auth = useAuth(config);
  const authRef = useRef(auth);
  authRef.current = auth;
  const identityClient = useMemo(
    () =>
      new IdentityClient({
        baseUrl: config.baseUrl,
        token: config.token,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        csrfToken: () => authRef.current.csrfToken(),
        refreshCsrfToken: () => authRef.current.refreshCsrfToken(),
        onUnauthorized: () => authRef.current.handleUnauthorized(),
        onForbidden: (error) => authRef.current.handleForbidden(error.message),
      }),
    [config],
  );

  if (inviteToken) {
    return (
      <InviteJoin
        client={identityClient}
        token={inviteToken}
        onDismiss={() => {
          inviteTokenRef.current = undefined;
          setInviteToken(undefined);
          void auth.retry();
        }}
      />
    );
  }
  if (auth.status === "checking") return <AuthLoadingScreen />;
  if (loginMode === "choose") {
    return (
      <LoginModeScreen
        onEnterprise={() => {
          void window.forgePilotAuth?.setMode?.("enterprise").then(() => {
            setLoginMode("enterprise");
          });
          if (!window.forgePilotAuth?.setMode) setLoginMode("enterprise");
        }}
        onPersonal={() => {
          void window.forgePilotAuth?.setMode?.("personal").then(() => {
            setLoginMode("personal");
          });
          if (!window.forgePilotAuth?.setMode) setLoginMode("personal");
        }}
      />
    );
  }
  if (loginMode === "personal") {
    const personalAuth = { ...auth, status: "legacy" as const, session: undefined };
    return (
      <Workbench
        config={config}
        auth={personalAuth}
        identityClient={identityClient}
        workspaces={[]}
        onSelectWorkspace={NOOP}
        onWorkspaceUnavailable={NOOP}
      />
    );
  }
  if (config.startupError && auth.status !== "signed_in" && auth.status !== "legacy") {
    return (
      <Workbench
        config={config}
        auth={auth}
        identityClient={identityClient}
        workspaces={[]}
        onSelectWorkspace={NOOP}
        onWorkspaceUnavailable={NOOP}
      />
    );
  }
  if (auth.status === "no_workspace") {
    return (
      <NoWorkspaceScreen
        displayName={auth.session?.user.display_name}
        session={auth.session}
        client={identityClient}
        onRetry={auth.retry}
        onSignOut={auth.signOut}
        onJoinToken={setInviteToken}
        onBack={() => setLoginMode("choose")}
      />
    );
  }
  if (
    auth.status === "signed_out" ||
    auth.status === "signing_in" ||
    auth.status === "expired" ||
    auth.status === "error"
  ) {
    return (
      <LoginScreen
        status={auth.status}
        providers={auth.providers}
        message={auth.message}
        desktop={auth.desktop}
        onSignIn={auth.signIn}
        onCancel={auth.cancelSignIn}
        onRetry={auth.retry}
        onBack={() => setLoginMode("choose")}
      />
    );
  }
  if (auth.status === "legacy") {
    return (
      <LoginScreen
        status="signed_out"
        providers={[]}
        desktop={auth.desktop}
        onSignIn={auth.signIn}
        onCancel={auth.cancelSignIn}
        onRetry={auth.retry}
        onBack={() => setLoginMode("choose")}
      />
    );
  }
  return (
    <WorkspaceGate
      config={config}
      auth={auth}
      identityClient={identityClient}
      onJoinToken={(token) => {
        inviteTokenRef.current = token;
        setInviteToken(token);
      }}
    />
  );
}

type WorkspaceLoadStatus = "loading" | "ready" | "error";

/**
 * Resolves the caller's accessible workspaces before any task request runs.
 * The task surface is not mounted until a workspace is chosen, so a task
 * call can never fall back to another workspace's scope.
 */
function WorkspaceGate({
  config,
  auth,
  identityClient,
  onJoinToken,
}: {
  config: ApiConfig;
  auth: AuthApi;
  identityClient: IdentityClient;
  onJoinToken: (token: string) => void;
}): ReactElement {
  const userId = auth.session?.user.id ?? "";
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [status, setStatus] = useState<WorkspaceLoadStatus>("loading");
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    typeof window === "undefined" ? undefined : readStoredWorkspaceId(window.localStorage, userId),
  );
  const [surface, setSurface] = useState<SurfaceView>("home");
  const changeSurface = useCallback((next: SurfaceView): void => setSurface(next), []);
  const requestRef = useRef(0);

  const load = useCallback(
    async (mode: "initial" | "refresh"): Promise<void> => {
      const requestId = ++requestRef.current;
      if (mode === "initial") setStatus("loading");
      try {
        const items = await identityClient.listAllWorkspaces();
        if (requestId !== requestRef.current) return;
        setWorkspaces(items);
        setStatus("ready");
        setError(undefined);
      } catch (caught) {
        if (requestId !== requestRef.current) return;
        // 401 flips the auth gate; a silent refresh keeps the current view.
        if (caught instanceof ApiError && caught.status === 401) return;
        if (mode === "refresh") return;
        setStatus("error");
        setError(errorMessage(caught));
      }
    },
    [identityClient],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const selected = resolveWorkspace(workspaces, selectedId);

  // A stored selection that is no longer a live membership is cleared rather
  // than left to resurrect if the membership returns later.
  useEffect(() => {
    if (status !== "ready" || typeof window === "undefined") return;
    const stored = readStoredWorkspaceId(window.localStorage, userId);
    if (stored !== undefined && !workspaces.some((item) => item.id === stored)) {
      clearStoredWorkspaceId(window.localStorage, userId);
      setSelectedId((current) => (current === stored ? undefined : current));
    }
  }, [status, workspaces, userId]);

  const selectWorkspace = useCallback(
    (workspaceId: string): void => {
      if (!workspaces.some((item) => item.id === workspaceId)) return;
      storeWorkspaceId(window.localStorage, userId, workspaceId);
      setSelectedId(workspaceId);
    },
    [userId, workspaces],
  );

  const reload = useCallback(async (): Promise<void> => {
    await load("initial");
  }, [load]);

  const refreshWorkspaces = useCallback((): void => {
    void load("refresh");
  }, [load]);

  // Coming back to the window re-reads live memberships, so a grant or a
  // revocation made elsewhere updates the switcher without a task request.
  useEffect(() => {
    const onFocus = (): void => refreshWorkspaces();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshWorkspaces]);

  if (status === "loading") return <AuthLoadingScreen />;
  if (status === "error") {
    return <WorkspaceUnavailableScreen message={error} onRetry={reload} onSignOut={auth.signOut} />;
  }
  if (workspaces.length === 0) {
    return (
      <NoWorkspaceScreen
        displayName={auth.session?.user.display_name}
        session={auth.session}
        client={identityClient}
        onRetry={reload}
        onSignOut={auth.signOut}
        onJoinToken={onJoinToken}
      />
    );
  }
  if (selected === undefined) {
    return (
      <WorkspaceChooser
        workspaces={workspaces}
        displayName={auth.session?.user.display_name}
        onSelect={selectWorkspace}
        onSignOut={auth.signOut}
      />
    );
  }
  return (
    <Workbench
      key={selected.id}
      config={config}
      auth={auth}
      identityClient={identityClient}
      workspace={selected}
      workspaces={workspaces}
      onSelectWorkspace={selectWorkspace}
      onWorkspaceUnavailable={refreshWorkspaces}
      initialSurface={surface}
      onSurfaceChange={changeSurface}
    />
  );
}

function Workbench({
  config,
  auth,
  identityClient,
  workspace,
  workspaces,
  onSelectWorkspace,
  onWorkspaceUnavailable,
  initialSurface,
  onSurfaceChange,
}: WorkbenchProps): ReactElement {
  const authRef = useRef(auth);
  authRef.current = auth;
  const client = useApiClient(config, authRef, workspace?.id ?? null);
  const readOnly = workspace?.role === "viewer";
  // Callbacks key off this scalar, never the workspace object: a membership
  // refresh rebuilds the list and would otherwise re-run every load effect.
  const scoped = workspace !== undefined;
  // Team leadership decides which items a member may govern; every page is
  // read so a leader of a later-page team keeps standing.
  const loadMemoryTeams = useCallback(
    (workspaceId: string) => identityClient.listAllWorkspaceTeams(workspaceId),
    [identityClient],
  );
  // The workspace directory belongs to the identity surface; every surface's
  // selector reads it here instead of through the task client.
  const loadWorkspaces = useCallback(() => identityClient.listAllWorkspaces(), [identityClient]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [surface, setSurface] = useState<SurfaceView>(
    initialSurface ?? (workspace ? "home" : "tasks"),
  );
  const surfaceNavRef = useRef<HTMLElement | null>(null);
  const surfaceIndicator = useSurfaceTabIndicator(surfaceNavRef, surface);
  const glassMode = useGlassMode();
  const topbarGlassRef = useLiquidGlass<HTMLElement>();
  const sidebarGlassRef = useLiquidGlass<HTMLElement>();
  useScrollFade(surfaceNavRef, surface);
  useEffect(() => onSurfaceChange?.(surface), [onSurfaceChange, surface]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  /** 窄屏钻取视图：list ↔ detail（≤900px 生效，桌面始终双栏并存） */
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  /** 每次点击任务卡片递增，强制详情 effect 重新执行（selectedId 不变时也能刷新） */
  const [detailEpoch, setDetailEpoch] = useState(0);
  /** 侧栏任务列表滚动模式：常规滚动条 / 每 3 张卡一组的折叠滚动 */
  const [scrollMode, setScrollMode] = useState<ScrollMode>(() => getScrollMode());

  const changeScrollMode = useCallback((mode: ScrollMode): void => {
    setScrollMode(mode);
    applyScrollMode(mode);
  }, []);
  const toggleGlassMode = useCallback((): void => {
    applyGlassMode(glassMode === "liquid" ? "frosted" : "liquid");
  }, [glassMode]);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [selectedTask, setSelectedTask] = useState<Task>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>("connecting");
  const [serviceError, setServiceError] = useState<string>();
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showWorkspaces, setShowWorkspaces] = useState(false);
  const [adminInitialTab, setAdminInitialTab] = useState<
    "members" | "teams" | "invitations" | "audit"
  >("members");
  // Bumped whenever the settings dialog closes so open pickers re-run
  // discovery against the (possibly changed) account set.
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [form, setForm] = useState<CreateTaskForm>(() => initialForm(workspace));
  const [isCreating, setIsCreating] = useState(false);
  const [actionError, setActionError] = useState<string>();
  // Creation failures stay inside the create dialog; task-action failures
  // surface as the detail toast.
  const [createError, setCreateError] = useState<string>();
  const [cancellingTaskId, setCancellingTaskId] = useState<string>();
  const [confirmTaskAction, setConfirmTaskAction] = useState<{
    task: Task;
    action: "archive" | "recovery";
  }>();
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);
  const [isActionErrorHovered, setIsActionErrorHovered] = useState(false);
  const [isCreateErrorHovered, setIsCreateErrorHovered] = useState(false);
  const [actionBusy, setActionBusy] = useState<string>();
  const createKeyRef = useRef(new CreateIdempotencyKeys());
  const listRequestRef = useRef(0);
  const taskDetailRequestRef = useRef(0);

  useEffect(() => {
    if (!actionError) {
      setIsActionErrorHovered(false);
      return;
    }
    if (isActionErrorHovered) return;
    const timeoutId = window.setTimeout(() => {
      setActionError((current) => (current === actionError ? undefined : current));
    }, 1000);
    return () => window.clearTimeout(timeoutId);
  }, [actionError, isActionErrorHovered]);

  // Creation failures use the same transient behavior as task-action errors:
  // slide in, auto-dismiss after 1s, and stay while hovered.
  useEffect(() => {
    if (!createError) {
      setIsCreateErrorHovered(false);
      return;
    }
    if (isCreateErrorHovered) return;
    const timeoutId = window.setTimeout(() => {
      setCreateError((current) => (current === createError ? undefined : current));
    }, 1000);
    return () => window.clearTimeout(timeoutId);
  }, [createError, isCreateErrorHovered]);

  const selectTask = useCallback((task: Task | undefined): void => {
    const taskId = task?.id;
    taskDetailRequestRef.current += 1;
    const previousId = selectedIdRef.current;
    selectedIdRef.current = taskId;
    setSelectedId(taskId);
    // 列表已包含完整任务快照：直接显示所选任务，再后台刷新详情。
    // 同一任务保留当前详情和本地输入；只有主动返回首页才清空。
    if (previousId !== taskId) {
      setSelectedTask(task);
      setRuns([]);
    }
    setMobileView(taskId ? "detail" : "list");
    setActionError(undefined);
    setActionBusy(undefined);
    setDetailEpoch((n) => n + 1);
  }, []);

  const reportRequestError = useCallback(
    (caught: unknown, report: (message: string) => void = setActionError): void => {
      // 401 flips the auth gate; 403 is reported by the permission banner.
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) return;
      // A scoped 404 means this locator is no longer the caller's workspace:
      // re-read the live membership list instead of showing a task error.
      if (scoped && caught instanceof ApiError && caught.code === "NOT_FOUND") {
        onWorkspaceUnavailable();
        return;
      }
      report(errorMessage(caught));
    },
    [onWorkspaceUnavailable, scoped],
  );

  const loadTasks = useCallback(
    async (showConnecting = false): Promise<void> => {
      const requestId = ++listRequestRef.current;
      if (showConnecting) setServiceStatus("connecting");
      try {
        const page = await client.listTasks();
        if (requestId !== listRequestRef.current) return;
        setTasks(page.items);
        setNextCursor(page.next_cursor);
        setServiceStatus("connected");
        setServiceError(undefined);
      } catch (caught) {
        if (requestId !== listRequestRef.current) return;
        if (caught instanceof ApiError && caught.status === 401) return;
        if (scoped && caught instanceof ApiError && caught.code === "NOT_FOUND") {
          onWorkspaceUnavailable();
          return;
        }
        if (caught instanceof ApiError && caught.status === 403) {
          setServiceStatus("connected");
          setServiceError(undefined);
          return;
        }
        setServiceStatus("offline");
        setServiceError(errorMessage(caught));
      }
    },
    [client, onWorkspaceUnavailable, scoped],
  );

  const loadMoreTasks = useCallback(async (): Promise<void> => {
    if (!nextCursor || isLoadingMore) return;
    const cursor = nextCursor;
    const listRequestId = listRequestRef.current;
    setIsLoadingMore(true);
    try {
      const page = await client.listTasks(undefined, cursor);
      if (listRequestId !== listRequestRef.current) return;
      setTasks((current) => {
        const knownIds = new Set(current.map((task) => task.id));
        return [...current, ...page.items.filter((task) => !knownIds.has(task.id))];
      });
      setNextCursor(page.next_cursor);
    } catch (caught) {
      if (listRequestId === listRequestRef.current) reportRequestError(caught);
    } finally {
      setIsLoadingMore(false);
    }
  }, [client, isLoadingMore, nextCursor, reportRequestError]);

  useEffect(() => {
    void loadTasks(true);
  }, [loadTasks]);

  const refreshSelectedTask = useCallback(async (): Promise<void> => {
    const requestedId = selectedIdRef.current;
    if (!requestedId) return;
    const requestId = ++taskDetailRequestRef.current;
    try {
      const [task, taskRuns] = await Promise.all([
        client.getTask(requestedId),
        client.getRuns(requestedId),
      ]);
      if (selectedIdRef.current !== requestedId || taskDetailRequestRef.current !== requestId) {
        return;
      }
      setSelectedTask(task);
      setRuns(taskRuns);
      setTasks((current) => current.map((entry) => (entry.id === task.id ? task : entry)));
      setServiceStatus("connected");
      setServiceError(undefined);
    } catch (caught) {
      if (selectedIdRef.current !== requestedId || taskDetailRequestRef.current !== requestId) {
        return;
      }
      reportRequestError(caught);
    }
  }, [client, reportRequestError]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedTask(undefined);
      setRuns([]);
      return;
    }
    void refreshSelectedTask();
  }, [refreshSelectedTask, selectedId, detailEpoch]);

  const handleStreamEvent = useCallback(
    (event: TaskEvent): void => {
      if (event.task_id !== selectedIdRef.current) return;
      if (event.type === "task.status_changed" || event.type === "task.terminal") {
        void refreshSelectedTask();
        void loadTasks();
      }
    },
    [loadTasks, refreshSelectedTask],
  );
  const stream = useTaskStream(
    client,
    selectedId,
    handleStreamEvent,
    selectedTask ? TERMINAL_STATUSES.has(selectedTask.status) : false,
  );

  const visibleTasks = tasks.filter((task) =>
    filter === "all"
      ? !isTaskArchived(task)
      : filter === "cancelled"
        ? isTaskArchived(task)
        : !isTaskArchived(task) && task.status === filter,
  );
  const stackedScroll = scrollMode === "stacked";

  const taskListRef = useRef<HTMLDivElement | null>(null);

  /** 折叠堆叠效果：中心清晰，上下边缘重叠、缩小和淡化 */
  useStackFold(taskListRef, stackedScroll, `${visibleTasks.length}:${filter}`);

  async function handleQuickCancel(task: Task): Promise<void> {
    if (
      readOnly ||
      (TERMINAL_STATUSES.has(task.status) && task.status !== "cancelled") ||
      isTaskArchived(task) ||
      cancellingTaskId
    )
      return;
    setCancellingTaskId(task.id);
    setActionError(undefined);
    try {
      const cancelled =
        task.status === "cancelled"
          ? await client.archiveTask(task.id)
          : await client.cancelTask(task.id);
      listRequestRef.current += 1;
      setTasks((current) =>
        current.map((entry) => (entry.id === cancelled.id ? cancelled : entry)),
      );
      if (selectedIdRef.current === cancelled.id) {
        taskDetailRequestRef.current += 1;
        setSelectedTask(cancelled);
      }
    } catch (caught) {
      reportRequestError(caught);
    } finally {
      setCancellingTaskId(undefined);
    }
  }

  async function handleQuickRecovery(task: Task): Promise<void> {
    if (readOnly || task.status !== "cancelled" || !isTaskArchived(task) || cancellingTaskId)
      return;
    setCancellingTaskId(task.id);
    setActionError(undefined);
    try {
      const recovered = await client.recoverTask(task.id);
      listRequestRef.current += 1;
      setTasks((current) =>
        current.map((entry) => (entry.id === recovered.id ? recovered : entry)),
      );
      if (selectedIdRef.current === recovered.id) {
        taskDetailRequestRef.current += 1;
        setSelectedTask(recovered);
      }
    } catch (caught) {
      reportRequestError(caught);
    } finally {
      setCancellingTaskId(undefined);
    }
  }

  function requestTaskAction(task: Task, action: "archive" | "recovery"): void {
    confirmationTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmTaskAction({ task, action });
  }

  function closeTaskConfirmation(): void {
    setConfirmTaskAction(undefined);
    confirmationTriggerRef.current?.focus();
  }

  function openCreateDialog(): void {
    setCreateError(undefined);
    setShowCreate(true);
  }

  function closeCreateDialog(): void {
    setShowCreate(false);
    setCreateError(undefined);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (readOnly || !form.summary.trim()) return;
    setIsCreating(true);
    setCreateError(undefined);
    try {
      const input = {
        repository_id: form.repositoryId.trim(),
        base_ref: form.baseRef.trim(),
        summary: form.summary.trim(),
        ...(form.sourceReference.trim() ? { source_reference: form.sourceReference.trim() } : {}),
        ...(form.acceptanceCriteria.trim()
          ? { acceptance_criteria: splitCriteria(form.acceptanceCriteria) }
          : {}),
      };
      const idempotencyKey = createKeyRef.current.forInput(input);
      const task = await client.createTask(input, idempotencyKey);
      createKeyRef.current.complete(input);
      selectTask(task);
      setShowCreate(false);
      setCreateError(undefined);
      setForm(initialForm(workspace));
      await loadTasks();
    } catch (caught) {
      reportRequestError(caught, setCreateError);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleTaskAction(
    action: "approve" | "reject" | "cancel",
    digest?: string,
  ): Promise<void> {
    if (readOnly || !selectedTask) return;
    const taskId = selectedTask.id;
    setActionBusy(action);
    setActionError(undefined);
    try {
      const task =
        action === "cancel"
          ? await client.cancelTask(taskId)
          : await client.approveTask(taskId, {
              decision: action,
              scope_digest: digest ?? "",
            });
      listRequestRef.current += 1;
      if (selectedIdRef.current === taskId) {
        taskDetailRequestRef.current += 1;
        setSelectedTask(task);
      }
      setTasks((current) => current.map((entry) => (entry.id === task.id ? task : entry)));
    } catch (caught) {
      if (selectedIdRef.current === taskId) reportRequestError(caught);
    } finally {
      if (selectedIdRef.current === taskId) setActionBusy(undefined);
    }
  }

  return (
    <>
      <div className="scene" aria-hidden="true">
        <div className="scene-base" />
        <div className="scene-glow scene-glow-accent" />
        <div className="scene-glow scene-glow-cool" />
        <div className="scene-grid" />
        <div className="scene-grain" />
      </div>
      <div className="top-scrim" aria-hidden="true" />
      <div className="app-shell">
        <header className="topbar glass" ref={topbarGlassRef}>
          <div className="brand-lockup">
            <span className={`brand-name brand-${serviceStatus}`}>
              <span className="brand-initial">F</span>orge<span className="brand-initial">P</span>
              ilot
            </span>
            <span className="visually-hidden" role="status">
              {serviceStatusLabel(serviceStatus)}
            </span>
          </div>
          <nav className="surface-nav" aria-label="Workbench views" ref={surfaceNavRef}>
            {surfaceIndicator && (
              <span
                className="surface-tab-indicator"
                aria-hidden="true"
                style={{
                  transform: `translateX(${surfaceIndicator.left}px)`,
                  width: `${surfaceIndicator.width}px`,
                }}
              />
            )}
            <button
              type="button"
              className={`surface-tab ${surface === "tasks" ? "surface-tab-active" : ""}`}
              aria-current={surface === "tasks" ? "page" : undefined}
              onClick={() => setSurface("tasks")}
            >
              <SurfaceIcon surface="tasks" />
              Tasks
            </button>
            <button
              type="button"
              className={`surface-tab ${surface === "issues" ? "surface-tab-active" : ""}`}
              aria-current={surface === "issues" ? "page" : undefined}
              onClick={() => setSurface("issues")}
            >
              <SurfaceIcon surface="issues" />
              Issues
            </button>
            <button
              type="button"
              className={`surface-tab ${surface === "memory" ? "surface-tab-active" : ""}`}
              aria-current={surface === "memory" ? "page" : undefined}
              onClick={() => setSurface("memory")}
            >
              <SurfaceIcon surface="memory" />
              Memory
            </button>
            <button
              type="button"
              className={`surface-tab ${surface === "rsi" ? "surface-tab-active" : ""}`}
              aria-current={surface === "rsi" ? "page" : undefined}
              onClick={() => setSurface("rsi")}
            >
              <SurfaceIcon surface="rsi" />
              RSI
            </button>
            <button
              type="button"
              className={`surface-tab ${surface === "dashboard" ? "surface-tab-active" : ""}`}
              aria-current={surface === "dashboard" ? "page" : undefined}
              onClick={() => setSurface("dashboard")}
            >
              <SurfaceIcon surface="dashboard" />
              Dashboard
            </button>
            <button
              type="button"
              className={`surface-tab ${surface === "security" ? "surface-tab-active" : ""}`}
              aria-current={surface === "security" ? "page" : undefined}
              onClick={() => setSurface("security")}
            >
              <SurfaceIcon surface="security" />
              Security
            </button>
          </nav>
          <div className="topbar-actions">
            {auth.session && (
              <div className="account-chip">
                <span className="account-name" title={auth.session.user.display_name}>
                  {auth.session.user.display_name}
                </span>
                <button
                  className="button button-quiet button-small"
                  onClick={() => void auth.signOut()}
                >
                  Sign out
                </button>
              </div>
            )}
            <button
              className="button button-quiet button-small"
              onClick={() => {
                setSurface(workspace ? "home" : "tasks");
                selectTask(undefined);
                setMobileView("detail");
              }}
              aria-label="Home"
              aria-current={
                surface === "home" || (surface === "tasks" && !selectedId) ? "page" : undefined
              }
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
              </svg>
              <span className="action-label">Home</span>
            </button>
            <button
              className="button button-quiet button-small"
              onClick={() => setShowSettings(true)}
              aria-label="Open settings"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
              </svg>
              <span className="action-label">Settings</span>
            </button>
            {auth.session &&
              (auth.session.memberships.length > 0 || auth.session.enterprise_roles.length > 0) && (
                <button
                  className="button button-quiet button-small"
                  onClick={() => setShowWorkspaces(true)}
                  aria-label="Open workspace administration"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  <span className="action-label">Workspaces</span>
                </button>
              )}
            <button
              type="button"
              className="button button-quiet button-small glass-toggle"
              onClick={toggleGlassMode}
              aria-label={
                glassMode === "liquid" ? "Switch to frosted glass" : "Switch to liquid glass"
              }
              title={glassMode === "liquid" ? "Switch to frosted glass" : "Switch to liquid glass"}
            >
              <GlassModeIcon mode={glassMode} />
              <span className="action-label glass-toggle-label">
                {glassMode === "liquid" ? "Liquid" : "Frosted"}
              </span>
            </button>
          </div>
        </header>

        {surface === "home" && workspace && (
          <main className="workspace-home" aria-labelledby="workspace-home-title">
            <section className="workspace-home-card">
              <span className="eyebrow">Workspace</span>
              <h1 id="workspace-home-title">{workspace.name}</h1>
              <WorkspaceSwitcher
                workspace={workspace}
                workspaces={workspaces}
                onSelect={onSelectWorkspace}
              />
              <div className="workspace-home-actions">
                <button className="button button-primary" onClick={() => setSurface("tasks")}>
                  Open Tasks
                </button>
                <button className="button button-secondary" onClick={() => setSurface("issues")}>
                  Open Issues
                </button>
              </div>
            </section>
            {(workspace.role === "owner" || workspace.role === "admin") && (
              <section className="workspace-home-card" aria-labelledby="workspace-setup-title">
                <span className="eyebrow">Get started</span>
                <h2 id="workspace-setup-title">Set up your team</h2>
                <div className="workspace-home-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setAdminInitialTab("invitations");
                      setShowWorkspaces(true);
                    }}
                  >
                    Invite members
                  </button>
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setAdminInitialTab("teams");
                      setShowWorkspaces(true);
                    }}
                  >
                    Create a team
                  </button>
                  <button
                    className="button button-quiet"
                    onClick={() => {
                      setAdminInitialTab("members");
                      setShowWorkspaces(true);
                    }}
                  >
                    Manage workspace
                  </button>
                </div>
              </section>
            )}
          </main>
        )}

        <div
          className="workspace"
          data-view={mobileView}
          data-scroll-lock={surface === "tasks" && !selectedId ? "true" : undefined}
          hidden={surface !== "tasks"}
        >
          <aside className="sidebar glass" ref={sidebarGlassRef}>
            <div className="sidebar-heading">
              <div className="sidebar-heading-main">
                <div className="sidebar-title-row">
                  <h1>Tasks</h1>
                  {!readOnly && (
                    <button
                      type="button"
                      className="task-create"
                      onClick={openCreateDialog}
                      aria-label="New task"
                      title="New task"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M7 1.5v11M1.5 7h11" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              <span className="task-count">{visibleTasks.length}</span>
            </div>
            {workspace && surface === "tasks" && (
              <WorkspaceSwitcher
                workspace={workspace}
                workspaces={workspaces}
                onSelect={onSelectWorkspace}
              />
            )}
            <div className="filter-row" role="group" aria-label="Task filters">
              {STATUS_FILTERS.map((status) => (
                <button
                  className={`filter-chip ${filter === status ? "filter-chip-active" : ""}`}
                  key={status}
                  onClick={() => setFilter(status)}
                >
                  {status === "all" ? "All" : formatStatus(status)}
                </button>
              ))}
            </div>
            <div
              ref={taskListRef}
              className="task-list"
              data-scroll={stackedScroll ? "stacked" : "normal"}
            >
              {visibleTasks.length === 0 ? (
                <div className="empty-sidebar">
                  <div className="empty-icon">⌁</div>
                  <p>
                    {serviceStatus === "offline"
                      ? "Node service is offline."
                      : readOnly
                        ? "Viewer access is read-only."
                        : "No tasks in this view."}
                  </p>
                  {!readOnly && (
                    <button className="button button-quiet" onClick={openCreateDialog}>
                      Start a task
                    </button>
                  )}
                </div>
              ) : (
                visibleTasks.map((task) => (
                  <TaskListItem
                    key={task.id}
                    task={task}
                    selected={task.id === selectedId}
                    readOnly={readOnly}
                    onClick={() => selectTask(task)}
                    onArchive={() => requestTaskAction(task, "archive")}
                    onRecovery={() => requestTaskAction(task, "recovery")}
                    busy={cancellingTaskId === task.id}
                  />
                ))
              )}
              {nextCursor && (
                <button
                  className="button button-quiet button-small load-more"
                  onClick={() => void loadMoreTasks()}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? "Loading…" : "Load more tasks"}
                </button>
              )}
            </div>
            <div className="sidebar-footer">
              <div className="security-note">
                <span className="security-icon" aria-hidden="true">
                  ◈
                </span>
                <div>
                  <strong>Local-only control</strong>
                  <span>Redacted evidence · no shell access</span>
                </div>
              </div>
            </div>
          </aside>

          <main className="main-panel">
            {auth.notice && (
              <div className="connection-banner permission-banner" role="alert">
                <span className="banner-dot" />
                <div>
                  <strong>Permission denied</strong>
                  <span>{auth.notice}</span>
                </div>
                <button className="button button-quiet button-small" onClick={auth.dismissNotice}>
                  Dismiss
                </button>
              </div>
            )}
            {serviceStatus === "offline" && (
              <div className="connection-banner" role="alert">
                <span className="banner-dot" />
                <div>
                  <strong>Node service unavailable</strong>
                  <span>{serviceError ?? "Check the local service and try again."}</span>
                </div>
                <button
                  className="button button-quiet button-small"
                  onClick={() => void loadTasks(true)}
                >
                  Retry connection
                </button>
              </div>
            )}
            {actionError && (
              <div
                className="inline-error"
                role="alert"
                onMouseEnter={() => setIsActionErrorHovered(true)}
                onMouseLeave={() => setIsActionErrorHovered(false)}
              >
                <span>{actionError}</span>
                <button aria-label="Dismiss error" onClick={() => setActionError(undefined)}>
                  ×
                </button>
              </div>
            )}
            {selectedTask ? (
              <TaskDetail
                key={selectedTask.id}
                task={selectedTask}
                workspaceName={workspace?.name}
                readOnly={readOnly}
                runs={runs}
                events={stream.events.filter((event) => event.task_id === selectedTask.id)}
                streamConnection={stream.connection}
                streamError={stream.error}
                client={client}
                actionBusy={cancellingTaskId === selectedTask.id ? "cancel" : actionBusy}
                onAction={handleTaskAction}
                onCancel={() => requestTaskAction(selectedTask, "archive")}
                onRefresh={() => void refreshSelectedTask()}
                onBack={() => {
                  setMobileView("list");
                  selectTask(undefined);
                }}
              />
            ) : (
              <WelcomePanel
                readOnly={readOnly}
                onCreate={openCreateDialog}
                onBack={() => setMobileView("list")}
              />
            )}
          </main>
        </div>

        {surface === "issues" && (
          <IssuesWorkbench
            client={client}
            currentUserId={auth.session?.user.id}
            loadWorkspaces={loadWorkspaces}
          />
        )}

        {surface === "memory" && (
          <MemoryWorkbench
            client={client}
            session={auth.session}
            loadTeams={loadMemoryTeams}
            loadWorkspaces={loadWorkspaces}
          />
        )}

        {surface === "rsi" && (
          <RsiWorkbench
            client={client}
            currentUserId={auth.session?.user.id}
            loadWorkspaces={loadWorkspaces}
          />
        )}

        {surface === "dashboard" && (
          <DashboardWorkbench client={client} loadWorkspaces={loadWorkspaces} />
        )}

        {surface === "security" && (
          <SecurityWorkbench
            client={client}
            session={auth.session}
            loadWorkspaces={loadWorkspaces}
          />
        )}

        {createError && (
          <div
            className="create-error-toast"
            role="alert"
            onMouseEnter={() => setIsCreateErrorHovered(true)}
            onMouseLeave={() => setIsCreateErrorHovered(false)}
          >
            <span>{createError}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setCreateError(undefined)}
            >
              ×
            </button>
          </div>
        )}
        {showCreate && (
          <CreateTaskDialog
            workspace={workspace}
            form={form}
            isCreating={isCreating}
            onChange={setForm}
            onClose={closeCreateDialog}
            onOpenSettings={() => setShowSettings(true)}
            onSubmit={handleCreate}
            refreshToken={settingsEpoch}
          />
        )}
        {showSettings && (
          <SettingsDialog
            onClose={() => {
              setShowSettings(false);
              setSettingsEpoch((value) => value + 1);
            }}
            scrollMode={scrollMode}
            onScrollModeChange={changeScrollMode}
          />
        )}
        {confirmTaskAction && (
          <TaskActionDialog
            action={confirmTaskAction.action}
            task={confirmTaskAction.task}
            onClose={closeTaskConfirmation}
            onConfirm={() => {
              const { task, action } = confirmTaskAction;
              closeTaskConfirmation();
              void (action === "archive" ? handleQuickCancel(task) : handleQuickRecovery(task));
            }}
          />
        )}
        {showWorkspaces && auth.session && (
          <WorkspaceAdminDialog
            client={identityClient}
            session={auth.session}
            initialTab={adminInitialTab}
            onClose={() => {
              setShowWorkspaces(false);
              void auth.retry();
            }}
          />
        )}
      </div>
    </>
  );
}

function serviceStatusLabel(status: ServiceStatus): string {
  return status === "connected"
    ? "Node connected"
    : status === "connecting"
      ? "Connecting"
      : "Node offline";
}

function TaskActionDialog({
  action,
  task,
  onClose,
  onConfirm,
}: {
  action: "archive" | "recovery";
  task: Task;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const archive = action === "archive";
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal glass task-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-confirm-title"
        aria-describedby="task-confirm-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (
            event.key === "Tab" &&
            event.shiftKey &&
            document.activeElement === cancelRef.current
          ) {
            event.preventDefault();
            confirmRef.current?.focus();
          } else if (
            event.key === "Tab" &&
            !event.shiftKey &&
            document.activeElement === confirmRef.current
          ) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
        }}
      >
        <h2 id="task-confirm-title">{archive ? "Archive task?" : "Recover task?"}</h2>
        <p id="task-confirm-description">
          {archive
            ? task.status === "cancelled"
              ? "Move this task to Cancelled."
              : "This will cancel the task and move it to Cancelled."
            : "Restore this task to All. Its run remains cancelled."}
        </p>
        <div className="modal-actions task-confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="button button-secondary"
            onClick={onClose}
          >
            Go back
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="button button-primary"
            onClick={onConfirm}
          >
            {archive ? "Archive task" : "Recover task"}
          </button>
        </div>
      </section>
    </div>
  );
}

function TaskListItem({
  task,
  selected,
  readOnly,
  onClick,
  onArchive,
  onRecovery,
  busy,
}: {
  task: Task;
  selected: boolean;
  readOnly: boolean;
  onClick: () => void;
  onArchive: () => void;
  onRecovery: () => void;
  busy: boolean;
}): ReactElement {
  const canRecover = !readOnly && task.status === "cancelled" && isTaskArchived(task);
  const canArchive =
    !readOnly &&
    !canRecover &&
    (!TERMINAL_STATUSES.has(task.status) || task.status === "cancelled");
  return (
    <article
      className={`task-list-item ${selected ? "task-list-item-selected" : ""} ${canArchive || canRecover ? "task-list-item-actionable" : ""}`}
    >
      <div className="task-list-item-topline">
        <span className={`status-pip status-${task.status}`} />
        <span className="task-list-status task-list-status-label">{formatStatus(task.status)}</span>
        {(canArchive || canRecover) && (
          <button
            type="button"
            className={`task-archive-pill ${canRecover ? "task-recovery-pill" : ""}`}
            onClick={canRecover ? onRecovery : onArchive}
            disabled={busy}
            aria-label={canRecover ? "Recover task" : "Archive task"}
          >
            {busy
              ? canRecover
                ? "Recovering…"
                : "Archiving…"
              : canRecover
                ? "Recovery"
                : "Archived"}
          </button>
        )}
        <span className="task-list-time">{formatDate(task.updated_at)}</span>
      </div>
      <button type="button" className="task-list-open" onClick={onClick}>
        <div className="task-list-summary">{redactText(task.request.summary)}</div>
        <div className="task-list-repo">
          <span>{redactText(task.repository.display_name)}</span>
        </div>
      </button>
    </article>
  );
}

function WelcomePanel({
  readOnly,
  onCreate,
  onBack,
}: {
  readOnly: boolean;
  onCreate: () => void;
  onBack: () => void;
}): ReactElement {
  return (
    <section className="welcome-panel">
      <button type="button" className="detail-back" onClick={onBack}>
        ← Tasks
      </button>
      <HeroLogo />
      <span className="eyebrow">Controlled remediation</span>
      <h2>Turn a reported problem into an auditable change.</h2>
      <p>
        ForgePilot keeps the operator in control. Start a task to follow risk, approval, execution,
        and evidence from one local workspace.
      </p>
      {!readOnly && (
        <button className="button button-primary" onClick={onCreate}>
          Create your first task <span aria-hidden="true">→</span>
        </button>
      )}
      <div className="welcome-principles">
        <span>Least privilege</span>
        <span>Redacted timeline</span>
        <span>Head-bound evidence</span>
      </div>
    </section>
  );
}

interface TaskDetailProps {
  task: Task;
  workspaceName?: string;
  readOnly: boolean;
  runs: RunSummary[];
  events: TaskEvent[];
  streamConnection: ReturnType<typeof useTaskStream>["connection"];
  streamError: string | undefined;
  client: ForgePilotClient;
  actionBusy: string | undefined;
  onAction: (action: "approve" | "reject" | "cancel", digest?: string) => Promise<void>;
  onCancel: () => void;
  onRefresh: () => void;
  /** 窄屏钻取：返回任务列表 */
  onBack?: () => void;
}

function TaskDetail({
  task,
  workspaceName,
  readOnly,
  runs,
  events,
  streamConnection,
  streamError,
  client,
  actionBusy,
  onAction,
  onCancel,
  onRefresh,
  onBack,
}: TaskDetailProps): ReactElement {
  const [artifact, setArtifact] = useState<{
    metadata: ArtifactMetadata;
    value?: Record<string, unknown>;
  }>();
  const [artifactBusy, setArtifactBusy] = useState<string>();
  const [artifactError, setArtifactError] = useState<string>();
  const [message, setMessage] = useState("");
  const [messageMode, setMessageMode] = useState<"steer" | "follow_up">("steer");
  const [messageSent, setMessageSent] = useState(false);
  const digest = approvalScopeDigest(events, task.id);
  const timelineRows = buildTimelineRows(events);
  const piSummary = resolvePiSummary(task, events);
  const percentage = progressPercent(task.progress.actions_completed, task.progress.actions_total);
  const canCancel = !readOnly && !TERMINAL_STATUSES.has(task.status);

  async function browseArtifact(metadata: ArtifactMetadata): Promise<void> {
    if (!metadata.available) return;
    setArtifactBusy(metadata.artifact_id);
    setArtifactError(undefined);
    try {
      const value = await client.getArtifact(task.id, metadata.artifact_id);
      setArtifact({ metadata, value });
    } catch (caught) {
      setArtifactError(errorMessage(caught));
    } finally {
      setArtifactBusy(undefined);
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!message.trim()) return;
    try {
      await client.sendMessage(task.id, { mode: messageMode, content: message.trim() });
      setMessage("");
      setMessageSent(true);
      window.setTimeout(() => setMessageSent(false), 2200);
    } catch (caught) {
      setArtifactError(errorMessage(caught));
    }
  }

  return (
    <section className="detail-view">
      <div className="detail-header">
        {onBack && (
          <button type="button" className="detail-back" onClick={onBack}>
            ← Tasks
          </button>
        )}
        <div className="detail-heading">
          <div className="breadcrumb">TASK / {shortId(task.id, 18)}</div>
          <h2>{redactText(task.request.summary)}</h2>
          <div className="detail-subline">
            {workspaceName && (
              <>
                <span>{workspaceName}</span>
                <span className="divider">/</span>
              </>
            )}
            <span>{redactText(task.repository.display_name)}</span>
            <span className="divider">/</span>
            <span className="mono">{redactText(task.repository.base_ref)}</span>
            <span className="divider">·</span>
            <span>Updated {formatDate(task.updated_at)}</span>
          </div>
        </div>
        <div className="detail-actions">
          <div className={`status-pill status-pill-${task.status}`}>
            <span className="status-pip" /> {formatStatus(task.status)}
          </div>
          {canCancel && (
            <button
              className="button button-secondary"
              disabled={actionBusy === "cancel"}
              onClick={onCancel}
            >
              {actionBusy === "cancel" ? "Cancelling…" : "Cancel task"}
            </button>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main-column">
          {task.status === "awaiting_approval" && (
            <ApprovalCard
              task={task}
              digest={digest}
              busy={actionBusy}
              readOnly={readOnly}
              onAction={onAction}
            />
          )}
          {task.status_reason && (
            <div className="reason-card">
              <span className="reason-icon">!</span>
              <div>
                <strong>Run note</strong>
                <p>{redactText(task.status_reason)}</p>
              </div>
            </div>
          )}
          <section className="card glass progress-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Current run</span>
                <h3>{task.current_run_id ? shortId(task.current_run_id, 18) : "Preparing run"}</h3>
              </div>
              <span className="connection-label">
                <span
                  className={`stream-dot stream-${TERMINAL_STATUSES.has(task.status) ? "offline" : streamConnection}`}
                />
                {streamConnection === "connected"
                  ? TERMINAL_STATUSES.has(task.status)
                    ? "Finished"
                    : "Live"
                  : streamConnection === "reconnecting"
                    ? "Reconnecting"
                    : "Syncing"}
              </span>
            </div>
            {streamError && streamConnection === "reconnecting" && (
              <div className="stream-note">
                Timeline paused while the local service reconnects. Events will resume
                automatically.
              </div>
            )}
            <div className="progress-metrics">
              <div>
                <span className="metric-label">Phase</span>
                <strong>
                  {task.progress.phase ? redactText(task.progress.phase) : "Not started"}
                </strong>
              </div>
              <div>
                <span className="metric-label">Actions</span>
                <strong>
                  {task.progress.actions_completed}
                  {task.progress.actions_total !== null
                    ? ` / ${task.progress.actions_total}`
                    : " completed"}
                </strong>
              </div>
              <div>
                <span className="metric-label">Risk</span>
                <strong>{task.risk ? redactText(task.risk.class) : "Pending"}</strong>
              </div>
            </div>
            <div
              className="progress-track"
              aria-label={
                percentage === undefined ? "Progress unavailable" : `${percentage}% complete`
              }
            >
              <span style={{ width: `${percentage ?? 8}%` }} />
            </div>
          </section>

          <section className="card glass pi-summary-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Pi</span>
                <h3>Pi summary</h3>
              </div>
              <span className={`pi-summary-state pi-summary-${piSummary.state}`}>
                {piSummaryStateLabel(piSummary)}
              </span>
            </div>
            <p className="pi-summary-copy">{piSummaryHeadline(piSummary)}</p>
            <div className="pi-summary-meta">
              {piSummary.runId && <span>run {shortId(piSummary.runId, 12)}</span>}
              {piSummary.turnId && <span>{piSummary.turnId}</span>}
              {piSummary.updatedAt && <span>{formatDate(piSummary.updatedAt)}</span>}
            </div>
            <span className="pi-summary-note">
              Raw Pi text is never displayed. The Node-side summary is the only Pi text source.
            </span>
          </section>

          <section className="card glass timeline-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Trace</span>
                <h3>Activity timeline</h3>
              </div>
              <span className="event-count">{events.length} events</span>
            </div>
            {events.length === 0 ? (
              <div className="card-empty">Waiting for the first task event.</div>
            ) : (
              <div className="timeline">
                {timelineRows.map((row) =>
                  row.kind === "pi_turn" ? (
                    <PiTurnEvent key={row.key} row={row} />
                  ) : (
                    <TimelineEvent key={row.key} event={row.event} />
                  ),
                )}
              </div>
            )}
          </section>

          {!TERMINAL_STATUSES.has(task.status) && !readOnly && (
            <form
              className="card glass message-card"
              onSubmit={(event) => void submitMessage(event)}
            >
              <div className="card-heading">
                <div>
                  <span className="eyebrow">Operator input</span>
                  <h3>Guide this run</h3>
                </div>
                {messageSent && <span className="success-label">Message queued</span>}
              </div>
              <div className="message-controls">
                <Select
                  value={messageMode}
                  onChange={(v) => setMessageMode(v as typeof messageMode)}
                  options={[
                    { value: "steer", label: "Steer current turn" },
                    { value: "follow_up", label: "Queue follow-up" },
                  ]}
                  className="message-mode-select"
                />
                <button
                  className="button button-primary button-small"
                  type="submit"
                  disabled={!message.trim()}
                >
                  Send
                </button>
              </div>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Add a bounded instruction for Pi…"
                rows={3}
              />
              <span className="field-hint">
                Input is sent to the current task session and remains inside the local control
                plane.
              </span>
            </form>
          )}
        </div>

        <aside className="detail-side-column">
          <section className="card glass identity-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Task binding</span>
                <h3>Repository scope</h3>
              </div>
            </div>
            <InfoRow label="Repository" value={redactText(task.repository.display_name)} />
            <InfoRow label="Base ref" value={redactText(task.repository.base_ref)} mono />
            <InfoRow label="Base revision" value={shortId(task.repository.base_sha, 16)} mono />
            <InfoRow label="Task ID" value={shortId(task.id, 16)} mono />
            {task.request.source_reference && (
              <InfoRow label="Source" value={redactText(task.request.source_reference)} />
            )}
          </section>

          <section className="card glass artifacts-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Evidence</span>
                <h3>Artifacts</h3>
              </div>
              <span className="event-count">Redacted</span>
            </div>
            <div className="artifact-list">
              {task.artifacts.index.length === 0 ? (
                <div className="card-empty compact">Artifacts appear as the run produces them.</div>
              ) : (
                task.artifacts.index.map((metadata) => (
                  <ArtifactRow
                    key={metadata.artifact_id}
                    metadata={metadata}
                    busy={artifactBusy === metadata.artifact_id}
                    onBrowse={() => void browseArtifact(metadata)}
                  />
                ))
              )}
            </div>
            {artifactError && <div className="artifact-error">{artifactError}</div>}
            {artifact && (
              <div className="artifact-viewer">
                <div className="artifact-viewer-heading">
                  <strong>{redactText(artifact.metadata.artifact_id)}</strong>
                  <button aria-label="Close artifact" onClick={() => setArtifact(undefined)}>
                    ×
                  </button>
                </div>
                <pre>{JSON.stringify(sanitizeValue(artifact.value), null, 2)}</pre>
              </div>
            )}
          </section>

          <section className="card glass runs-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">History</span>
                <h3>Run history</h3>
              </div>
              <button className="icon-button" aria-label="Refresh task" onClick={onRefresh}>
                ↻
              </button>
            </div>
            {runs.length === 0 ? (
              <div className="card-empty compact">No run history yet.</div>
            ) : (
              <div className="run-list">
                {runs.map((run) => (
                  <div className="run-row" key={run.run_id}>
                    <span className={`status-pip status-${run.state}`} />
                    <span className="mono">{shortId(run.run_id, 14)}</span>
                    <span>{redactText(run.state.replaceAll("_", " "))}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function ApprovalCard({
  task,
  digest,
  busy,
  readOnly,
  onAction,
}: {
  task: Task;
  digest: string | undefined;
  busy: string | undefined;
  readOnly: boolean;
  onAction: (action: "approve" | "reject", digest?: string) => Promise<void>;
}): ReactElement {
  const glowRef = useRef<HTMLDivElement>(null);
  useAmbientDrift(glowRef);
  const approvalGlassRef = useLiquidGlass<HTMLElement>();

  return (
    <section className="approval-card glass" ref={approvalGlassRef}>
      <div ref={glowRef} className="approval-glow" aria-hidden="true" />
      <div className="approval-icon">⌁</div>
      <div className="approval-copy">
        <span className="eyebrow">Human checkpoint</span>
        <h3>Review before capabilities are granted</h3>
        <p>
          This task is classified as <strong>{task.risk?.class ?? "elevated"}</strong>. Approve only
          if the repository scope and acceptance criteria match your intent.
        </p>
        <div className="approval-lock">
          <span>◈</span>
          <span>{digest ? "Scope locked to this exact run" : "Waiting for the scope digest"}</span>
        </div>
        {readOnly ? (
          <div className="approval-lock">
            <span>◈</span>
            <span>Viewer access cannot record an approval</span>
          </div>
        ) : (
          <div className="approval-actions">
            <button
              className="button button-primary"
              disabled={!digest || !!busy}
              onClick={() => void onAction("approve", digest)}
            >
              {busy === "approve" ? "Recording…" : "Approve run"}
            </button>
            <button
              className="button button-secondary"
              disabled={!digest || !!busy}
              onClick={() => void onAction("reject", digest)}
            >
              {busy === "reject" ? "Recording…" : "Reject"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function PiTurnEvent({ row }: { row: PiTurnRow }): ReactElement {
  return (
    <div className="timeline-event timeline-pi-turn">
      <div className="timeline-marker" aria-hidden="true">
        ✦
      </div>
      <div className="timeline-content">
        <div className="timeline-title">
          <strong>Pi summary</strong>
          <time dateTime={row.startedAt}>{formatDate(row.startedAt)}</time>
        </div>
        <p className="timeline-delta">{piTurnSummary(row)}</p>
      </div>
    </div>
  );
}

function TimelineEvent({ event }: { event: TaskEvent }): ReactElement {
  return (
    <div className={`timeline-event timeline-${event.type.replaceAll(".", "-")}`}>
      <div className="timeline-marker" aria-hidden="true">
        {event.type === "task.terminal" ? "✓" : event.type === "approval.required" ? "!" : "·"}
      </div>
      <div className="timeline-content">
        <div className="timeline-title">
          <strong>{eventLabel(event.type)}</strong>
          <time dateTime={event.occurred_at}>{formatDate(event.occurred_at)}</time>
        </div>
        <p>{redactText(eventSummary(event))}</p>
      </div>
    </div>
  );
}

function ArtifactRow({
  metadata,
  busy,
  onBrowse,
}: {
  metadata: ArtifactMetadata;
  busy: boolean;
  onBrowse: () => void;
}): ReactElement {
  return (
    <div className="artifact-row">
      <div className={`artifact-icon ${metadata.available ? "artifact-available" : ""}`}>
        {metadata.available ? "✓" : "·"}
      </div>
      <div className="artifact-copy">
        <strong>{redactText(metadata.artifact_id.replaceAll("_", " "))}</strong>
        <span>
          {metadata.available ? `Head ${shortId(metadata.head_sha, 12)}` : "Not available yet"}
        </span>
      </div>
      <button
        className="icon-button"
        disabled={!metadata.available || busy}
        onClick={onBrowse}
        aria-label={`Browse ${metadata.artifact_id}`}
      >
        {busy ? "…" : "→"}
      </button>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

function CreateTaskDialog({
  workspace,
  form,
  isCreating,
  onChange,
  onClose,
  onOpenSettings,
  onSubmit,
  refreshToken,
}: {
  workspace?: Workspace;
  form: CreateTaskForm;
  isCreating: boolean;
  onChange: (form: CreateTaskForm) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  refreshToken: number;
}): ReactElement {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="modal glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">New remediation</span>
            <h2 id="new-task-title">Create a controlled task</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>
        <p className="modal-intro">
          Describe the bounded change. ForgePilot pins the repository and base revision before work
          begins.
        </p>
        <form onSubmit={(event) => void onSubmit(event)}>
          {workspace ? (
            <div className="form-grid">
              <label>
                Repository
                <input value={workspace.repository.repository_id} readOnly />
              </label>
              <label>
                Base ref
                <input
                  value={form.baseRef}
                  onChange={(event) => onChange({ ...form, baseRef: event.target.value })}
                  placeholder="main"
                  required
                />
              </label>
            </div>
          ) : (
            <RepositoryPicker
              repositoryId={form.repositoryId}
              baseRef={form.baseRef}
              onChange={(patch) => onChange({ ...form, ...patch })}
              onOpenSettings={onOpenSettings}
              refreshToken={refreshToken}
            />
          )}
          <label>
            <span className="label-text">
              Task summary <span className="required-dot">*</span>
            </span>
            <textarea
              value={form.summary}
              onChange={(event) => onChange({ ...form, summary: event.target.value })}
              placeholder="What should ForgePilot investigate or prepare?"
              rows={3}
              required
            />
          </label>
          <label>
            Source reference
            <input
              value={form.sourceReference}
              onChange={(event) => onChange({ ...form, sourceReference: event.target.value })}
              placeholder="Issue or incident URL"
            />
          </label>
          <label>
            Acceptance criteria
            <textarea
              value={form.acceptanceCriteria}
              onChange={(event) => onChange({ ...form, acceptanceCriteria: event.target.value })}
              placeholder="Tests stay green\nNo changes outside the task scope"
              rows={3}
            />
          </label>
          <div className="modal-footer">
            <span className="field-hint">
              Retrying unchanged details reuses the same idempotency key.
            </span>
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={onClose}>
                Close
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={isCreating || !form.summary.trim()}
              >
                {isCreating ? "Creating…" : "Create task"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function splitCriteria(value: string): string[] {
  return value
    .split("\n")
    .map((criterion) => criterion.trim())
    .filter(Boolean);
}

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiConfigurationError)
    return (
      window.forgePilotConfig?.startupError ||
      "Configure the loopback Node service; default startup requires FORGEPILOT_BASE_SHA."
    );
  if (caught instanceof ApiError) return `${caught.code}: ${redactText(caught.message)}`;
  return caught instanceof Error
    ? redactText(caught.message)
    : "The request could not be completed.";
}
