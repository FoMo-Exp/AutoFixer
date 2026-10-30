/**
 * Task-list scroll mode for the sidebar.
 *
 * - "normal":  regular scrollbar scrolling (default)
 * - "stacked": scroll-snap in groups of 3 cards with a fold effect,
 *              like the macOS app-switcher stack. Only engages when the
 *              list holds more than 10 cards (see STACKED_MIN_TASKS).
 *
 * Persisted in localStorage under "fp-scroll"; the accent itself is not
 * affected — this only changes how the task list scrolls.
 */

export type ScrollMode = "normal" | "stacked";

const STORAGE_KEY = "fp-scroll";

/** Stacked mode only arms past this many cards; below it scrolling barely matters. */
export const STACKED_MIN_TASKS = 10;

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
