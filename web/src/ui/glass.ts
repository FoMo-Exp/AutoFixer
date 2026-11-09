import { useSyncExternalStore } from "react";

/**
 * Glass material preference for the workbench chrome.
 *
 * Stored in localStorage under "fp-glass" and applied to
 * document.documentElement as data-glass. "liquid" is the near-clear material
 * with the SVG rim lens; "frosted" is the dense, heavily blurred material
 * with the lens switched off. The mode only changes the material — layout,
 * tokens, and status colors do not move with it.
 */

export type GlassMode = "liquid" | "frosted";

const STORAGE_KEY = "fp-glass";
const listeners = new Set<() => void>();

let current: GlassMode = "liquid";

function readStored(): GlassMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "frosted" ? "frosted" : "liquid";
  } catch {
    return "liquid";
  }
}

export function getGlassMode(): GlassMode {
  return current;
}

export function applyGlassMode(mode: GlassMode): void {
  current = mode;
  document.documentElement.dataset.glass = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage unavailable (private mode); the session still applies */
  }
  for (const listener of listeners) listener();
}

export function initGlassMode(): void {
  applyGlassMode(readStored());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useGlassMode(): GlassMode {
  return useSyncExternalStore(subscribe, getGlassMode);
}
