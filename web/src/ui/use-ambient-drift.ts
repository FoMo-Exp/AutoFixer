import { useEffect } from "react";
import type { RefObject } from "react";

const RESTING_TRANSFORM = "translate(-22%, -4%) scale(1.05)";

/** Move a decorative light toward a fresh random destination each segment. */
export function useAmbientDrift(ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const light = ref.current;
    if (!light) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    let current = RESTING_TRANSFORM;

    const drift = (): void => {
      const x = Math.random() * 48 - 24;
      const y = Math.random() * 28 - 14;
      const scale = 0.95 + Math.random() * 0.2;
      const next = `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%) scale(${scale.toFixed(3)})`;
      animation = light.animate([{ transform: current }, { transform: next }], {
        duration: 16000 + Math.random() * 10000,
        easing: "ease-in-out",
        fill: "forwards",
      });
      animation.onfinish = () => {
        current = next;
        animation?.cancel();
        drift();
      };
      if (document.hidden) animation.pause();
    };

    const updatePreference = (): void => {
      animation?.cancel();
      animation = undefined;
      current = RESTING_TRANSFORM;
      if (!reducedMotion.matches) drift();
    };
    const updateVisibility = (): void => {
      if (document.hidden) animation?.pause();
      else animation?.play();
    };

    updatePreference();
    reducedMotion.addEventListener("change", updatePreference);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      animation?.cancel();
      reducedMotion.removeEventListener("change", updatePreference);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [ref]);
}
