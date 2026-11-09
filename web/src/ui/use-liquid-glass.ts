import { useEffect, useRef, useState } from "react";
import { useGlassMode } from "./glass";
import { liquidGlass } from "./liquid-glass";
import type { LiquidGlassHandle } from "./liquid-glass";

const LENS_OPTIONS = { rim: 40, edge: 1.1, power: 2.6, dispersion: 0.15 };

/**
 * Attaches the Glasswork rim lens to one element through a callback ref, so
 * surfaces that mount conditionally (e.g. a workspace sidebar that appears
 * after its data loads) still get a lens. The lens is created once per node
 * and only toggled when the glass mode changes, so switching between liquid
 * and frosted does not rebuild the filter or its tiles.
 */
export function useLiquidGlass<T extends HTMLElement>(): (node: T | null) => void {
  const [element, setElement] = useState<T | null>(null);
  const handleRef = useRef<LiquidGlassHandle | null>(null);
  const mode = useGlassMode();
  const enabled = mode === "liquid";
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!element) return;
    const handle = liquidGlass(element, { ...LENS_OPTIONS, enabled: enabledRef.current });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [element]);

  useEffect(() => {
    handleRef.current?.update({ enabled });
  }, [enabled]);

  return setElement;
}
