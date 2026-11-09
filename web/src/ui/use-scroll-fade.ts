import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/**
 * Marks a horizontally scrollable element with `is-scrollable` / `at-start` /
 * `at-end` so the stylesheet can fade the edge that has more content. Only
 * scroll geometry is read — no getBoundingClientRect of transformed values.
 *
 * `revision` re-runs the measurement when the content changes (for the nav,
 * the active surface); the scroll and resize listeners cover the rest.
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>, revision: unknown): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = (): void => {
      const max = element.scrollWidth - element.clientWidth;
      element.classList.toggle("is-scrollable", max > 1);
      element.classList.toggle("at-start", element.scrollLeft <= 1);
      element.classList.toggle("at-end", element.scrollLeft >= max - 1);
    };

    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);

    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref, revision]);
}
