/**
 * Task-list scroll mode for the sidebar.
 *
 * - "normal":  regular scrollbar scrolling (default)
 * - "stacked": overlapping, shrinking and fading cards at both edges when
 *              the list overflows.
 *
 * Persisted in localStorage under "fp-scroll"; the accent itself is not
 * affected — this only changes how the task list scrolls.
 */

export type ScrollMode = "normal" | "stacked";

const STORAGE_KEY = "fp-scroll";

export function getScrollMode(): ScrollMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "stacked" ? "stacked" : "normal";
  } catch {
    return "normal";
  }
}

export function applyScrollMode(mode: ScrollMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage unavailable (private mode); the session still applies */
  }
}
