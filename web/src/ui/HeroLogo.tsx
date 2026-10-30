import { useRef } from "react";
import type { ReactElement } from "react";
import { useLogoRound } from "./use-logo-round";

/** A gate is a true cuboid: six rigid faces, no stacked layers to shimmer. */
const FACES = ["front", "back", "left", "right", "top", "bottom"] as const;
const MERIDIANS = Array.from({ length: 24 }, (_, index) => index * (180 / 24));

function Gate({ side }: { side: "left" | "right" }): ReactElement {
  return (
    <div className={`hero-logo-pillar hero-logo-pillar-${side}`}>
      {FACES.map((face) => (
        <div key={face} className={`hero-logo-face hero-logo-face-${face}`} />
      ))}
    </div>
  );
}

/** Solid, unlit sphere: intersecting great-circle discs retain volume at every angle. */
function Pearl(): ReactElement {
  return (
    <div className="hero-logo-pearl">
      {MERIDIANS.map((angle) => (
        <div
          key={angle}
          className="hero-logo-pearl-disc"
          style={{ transform: `rotateY(${angle}deg)` }}
        />
      ))}
      <div className="hero-logo-pearl-disc" style={{ transform: "rotateX(90deg)" }} />
    </div>
  );
}

/** A1 双柱穿珠 as a 3D scene driven by useLogoRound. */
export function HeroLogo(): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  useLogoRound(rootRef);
  return (
    <div className="hero-logo" ref={rootRef} aria-hidden="true">
      <div className="hero-logo-scene">
        <div className="hero-logo-spin">
          <Gate side="left" />
          <Gate side="right" />
          <Pearl />
        </div>
      </div>
    </div>
  );
}
