import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

export function BlackHoleMotion(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof WebGL2RenderingContext === "undefined") return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void import("./black-hole-scene").then(({ mountBlackHoleScene }) => {
      if (cancelled) return;
      try {
        cleanup = mountBlackHoleScene(canvas);
      } catch {
        // The local black-hole image remains visible when WebGL is unavailable.
      }
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return <canvas className="auth-mode-motion" ref={canvasRef} />;
}
