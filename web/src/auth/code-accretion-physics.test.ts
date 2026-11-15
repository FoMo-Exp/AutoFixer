import { describe, expect, it } from "vitest";
import { createAccretionPath, sampleAccretion, samplePath } from "./code-accretion-physics";

describe("accretion trajectories", () => {
  it("feeds both sides into a common rotation while radius decreases", () => {
    for (const right of [false, true]) {
      const path = createAccretionPath(1440, 810, right, 0);
      expect(path[0].x > 720).toBe(right);
      for (let index = 1; index < path.length; index += 1) {
        expect(path[index].phase).toBeLessThan(path[index - 1].phase);
        expect(path[index].radius).toBeLessThan(path[index - 1].radius);
        expect(path[index].distance).toBeGreaterThan(path[index - 1].distance);
      }
      expect(path.at(-1)!.radius).toBeLessThanOrEqual(1.008);
      expect(path.at(-1)!.capture).toBe(1);
    }
  });

  it("accelerates inward before apparent angular motion slows near capture", () => {
    const path = createAccretionPath(1440, 810, false, 0);
    const angularStep = (radius: number): number => {
      const index = path.findIndex((sample) => sample.radius <= radius);
      return path[index - 1].phase - path[index].phase;
    };
    expect(angularStep(1.7)).toBeGreaterThan(angularStep(4));
    expect(angularStep(1.015)).toBeLessThan(angularStep(1.7));
  });

  it("projects the far side above the shadow and foreground across the disk", () => {
    const path = createAccretionPath(1440, 810, false, 0);
    const far = path.filter((sample) => sample.farSide > 0.8 && Math.abs(sample.x - 720) < 90);
    const near = path.filter((sample) => sample.farSide < -0.8);
    expect(far.length).toBeGreaterThan(0);
    expect(near.length).toBeGreaterThan(0);
    expect(far.every((sample) => sample.y < 810 * 0.62 - 90)).toBe(true);
    expect(near.every((sample) => sample.y > 810 * 0.62)).toBe(true);
  });

  it("keeps source and orbit phases stable across viewport resizing", () => {
    const small = createAccretionPath(720, 405, true, 1);
    const large = createAccretionPath(1440, 810, true, 1);
    expect(large.length).toBe(small.length);
    for (const progress of [0, 0.2, 0.5, 0.8, 1]) {
      const a = samplePath(small, progress);
      const b = samplePath(large, progress);
      expect(b.x).toBeCloseTo(a.x * 2, 8);
      expect(b.y).toBeCloseTo(a.y * 2, 8);
    }
  });

  it("samples time monotonically with a bounded, continuous capture fade", () => {
    const path = createAccretionPath(1440, 810, true, -1);
    let previous = sampleAccretion(path, 0);
    for (let index = 1; index <= 100; index += 1) {
      const state = sampleAccretion(path, index / 100);
      expect(state.progress).toBeGreaterThan(previous.progress);
      expect(state.capture).toBeGreaterThanOrEqual(previous.capture);
      expect(state.capture).toBeGreaterThanOrEqual(0);
      expect(state.capture).toBeLessThanOrEqual(1);
      expect(Number.isFinite(samplePath(path, state.progress).x)).toBe(true);
      previous = state;
    }
  });
});
