import { useEffect, useMemo, useState } from "react";
import type { ApiConfig } from "../api/config";
import {
  createBrowserAuthController,
  createDesktopAuthController,
  createLegacyAuthController,
  type AuthController,
  type AuthSnapshot,
  type DesktopAuthBridge,
} from "./controller";

export interface AuthApi extends AuthSnapshot, AuthController {
  desktop: boolean;
}

export function useAuth(config: ApiConfig): AuthApi {
  const [controller] = useState<AuthController>(() => {
    if (config.authMode === "desktop" && typeof window !== "undefined") {
      const bridge = (window as Window & { forgePilotAuth?: DesktopAuthBridge }).forgePilotAuth;
      if (bridge) return createDesktopAuthController(bridge);
    }
    if (config.authMode === "browser") {
      return createBrowserAuthController({ baseUrl: config.baseUrl });
    }
    return createLegacyAuthController();
  });
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    void controller.initialize();
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return useMemo(
    () => ({
      ...snapshot,
      getSnapshot: controller.getSnapshot,
      subscribe: controller.subscribe,
      initialize: controller.initialize,
      retry: controller.retry,
      signIn: controller.signIn,
      cancelSignIn: controller.cancelSignIn,
      signOut: controller.signOut,
      csrfToken: controller.csrfToken,
      refreshCsrfToken: controller.refreshCsrfToken,
      handleUnauthorized: controller.handleUnauthorized,
      handleForbidden: controller.handleForbidden,
      dismissNotice: controller.dismissNotice,
      dispose: controller.dispose,
      desktop: config.authMode === "desktop",
    }),
    [snapshot, controller, config.authMode],
  );
}
