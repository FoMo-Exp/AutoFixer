import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

export interface SurfaceTabIndicator {
  left: number;
  width: number;
}

/**
 * Tracks the active surface tab so one shared indicator can glide between
 * adjacent tabs instead of each tab painting its own active background.
 *
 * Geometry is read from the tab buttons (offsetLeft/offsetWidth), never from
 * the transformed indicator, so the animation cannot feed back on itself.
 * Re-measures on tab changes, container resizes, and font load.
 */
export function useSurfaceTabIndicator(
  navRef: RefObject<HTMLElement | null>,
  surface: string,
): SurfaceTabIndicator | null {
  const [indicator, setIndicator] = useState<SurfaceTabIndicator | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const measure = (): void => {
      const active = nav.querySelector<HTMLElement>(".surface-tab-active");
      if (!active) {
        setIndicator(null);
        return;
      }
      const next = { left: active.offsetLeft, width: active.offsetWidth };
      setIndicator((previous) =>
        previous && previous.left === next.left && previous.width === next.width ? previous : next,
      );
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (observer) {
      observer.observe(nav);
      for (const tab of nav.querySelectorAll(".surface-tab")) observer.observe(tab);
    }
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure).catch(() => undefined);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [navRef, surface]);

  return indicator;
}
