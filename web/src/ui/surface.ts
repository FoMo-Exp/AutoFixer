/**
 * Surface (dark/light) preference for the workbench chrome.
 *
 * Stored in localStorage under "fp-surface" and applied to
 * document.documentElement as data-surface, mirroring the prototype
 * (design-demos/dir-2.html). The accent itself is not switchable —
 * Signal orange is the single brand color; the surface only swaps the
 * neutral and semantic ramps (see styles.css light override).
 */

export type Surface = "dark" | "light";

const STORAGE_KEY = "fp-surface";

export function getSurface(): Surface {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applySurface(surface: Surface): void {
  document.documentElement.dataset.surface = surface;
  try {
    window.localStorage.setItem(STORAGE_KEY, surface);
  } catch {
    /* storage unavailable (private mode); the session still applies */
  }
}

export function initSurface(): void {
  applySurface(getSurface());
}
