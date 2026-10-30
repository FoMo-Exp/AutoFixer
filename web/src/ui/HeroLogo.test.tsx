// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HeroLogo } from "./HeroLogo";

afterEach(() => {
  cleanup();
});

describe("HeroLogo", () => {
  it("renders the double-gate mark as a 3D scene: cuboid gates and one sphere", () => {
    const { container } = render(<HeroLogo />);
    const root = container.querySelector(".hero-logo")!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector(".hero-logo-spin")).not.toBeNull();
    for (const side of ["left", "right"]) {
      const faces = root.querySelectorAll(`.hero-logo-pillar-${side} .hero-logo-face`);
      expect(faces).toHaveLength(6); // cuboid: front/back/left/right/top/bottom
    }
    const pearl = root.querySelectorAll(".hero-logo-pearl");
    expect(pearl).toHaveLength(1);
    expect(pearl[0].querySelectorAll(".hero-logo-pearl-disc")).toHaveLength(25);
  });

  it("keeps the scene to the mark itself — no orbit rings", () => {
    const { container } = render(<HeroLogo />);
    const spin = container.querySelector(".hero-logo-spin")!;
    expect(spin.children).toHaveLength(3);
  });
});
