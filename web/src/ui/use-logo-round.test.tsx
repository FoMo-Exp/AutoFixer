// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRoundKeyframes, ROUND_MS, roundPose, useLogoRound } from "./use-logo-round";

/** Sample t densely so curve-level claims do not depend on keyframe counts. */
function samples(steps: number) {
  return Array.from({ length: steps + 1 }, (_, index) => roundPose(index / steps));
}

describe("roundPose", () => {
  it("starts and ends at the rest pose so the round closes", () => {
    for (const t of [0, 1]) {
      const pose = roundPose(t);
      expect(pose.pearl).toEqual({ x: 0, y: 0, z: 0 });
      expect(pose.pillarLDeg).toBe(0);
      expect(pose.pillarRDeg).toBe(0);
      expect(pose.nodDeg).toBe(0);
      expect(pose.spinDeg % 360).toBe(0);
    }
  });

  it("spins the mark one full turn over a round", () => {
    expect(roundPose(0.5).spinDeg).toBeCloseTo(180);
    expect(roundPose(1).spinDeg).toBeCloseTo(360);
  });

  it("counter-rotates the pillars so one turns inward and the other outward", () => {
    const tilted = samples(40).filter((pose) => pose.pillarLDeg !== 0);
    expect(tilted.length).toBeGreaterThan(0);
    for (const pose of tilted) {
      expect(pose.pillarLDeg).toBeGreaterThan(0);
      expect(pose.pillarRDeg).toBe(-pose.pillarLDeg);
    }
  });

  it("keeps pillar motion in the first half and settles them before the pearl finale", () => {
    const at = (from: number, to: number) =>
      Array.from({ length: 21 }, (_, index) => roundPose(from + ((to - from) * index) / 20));
    expect(at(0, 0.6).some((pose) => pose.pillarLDeg !== 0)).toBe(true);
    expect(at(0.7, 1).every((pose) => pose.pillarLDeg === 0)).toBe(true);
  });

  it("sends the pearl across both pillars", () => {
    const xs = samples(60).map((pose) => pose.pearl.x);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(Math.min(...xs)).toBeLessThan(0);
  });

  it("weaves the pearl between the inner and outer surfaces", () => {
    const zs = samples(60).map((pose) => pose.pearl.z);
    expect(Math.max(...zs)).toBeGreaterThan(0);
    expect(Math.min(...zs)).toBeLessThan(0);
  });
});

describe("buildRoundKeyframes", () => {
  it("marches offsets from 0 to 1, one keyframe per sample", () => {
    const { spin } = buildRoundKeyframes();
    expect(spin).toHaveLength(25);
    spin.forEach((frame, index) => expect(frame.offset).toBeCloseTo(index / 24));
  });

  it("leaves the mark at rest at both ends of the round", () => {
    const frames = buildRoundKeyframes();
    expect(frames.spin[0].transform).toBe("rotateX(0deg) rotateY(0deg)");
    expect(frames.spin[24].transform).toBe("rotateX(0deg) rotateY(360deg)");
    expect(frames.pillarL[0].transform).toBe("rotateY(0deg)");
    expect(frames.pillarR[24].transform).toBe("rotateY(0deg)");
  });

  it("returns the pearl to its exact resting point at both ends", () => {
    const { pearl } = buildRoundKeyframes();
    expect(pearl[0].transform).toBe("translate3d(0px, 0px, 0px)");
    expect(pearl[24].transform).toBe("translate3d(0px, 0px, 0px)");
  });
});

interface FakeAnimation {
  playState: string;
  currentTime: number | null;
  finished: Promise<never>;
  listeners: Map<string, Set<() => void>>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  play: () => void;
  pause: () => void;
  cancel: () => void;
  playCalls: number;
  pauseCalls: number;
  cancelCalls: number;
}

interface Captured {
  element: Element;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  anim: FakeAnimation;
}

let captured: Captured[] = [];
let originalAnimate: unknown;

function installFakeAnimate(): void {
  originalAnimate = Element.prototype.animate;
  Element.prototype.animate = function (
    this: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): Animation {
    let rejectFinished!: (reason: unknown) => void;
    // Like the platform: finished rejects when the animation is canceled.
    const finished = new Promise<never>((_resolve, reject) => {
      rejectFinished = reject;
    });
    const listeners = new Map<string, Set<() => void>>();
    const anim: FakeAnimation = {
      playState: "running",
      currentTime: 0,
      finished,
      listeners,
      playCalls: 0,
      pauseCalls: 0,
      cancelCalls: 0,
      addEventListener(type, listener) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      play() {
        anim.playCalls += 1;
        anim.playState = "running";
      },
      pause() {
        anim.pauseCalls += 1;
        anim.playState = "paused";
      },
      cancel() {
        anim.cancelCalls += 1;
        anim.playState = "idle";
        anim.currentTime = null;
        rejectFinished(new DOMException("The animation was canceled.", "AbortError"));
      },
    };
    captured.push({ element: this, frames, options, anim });
    return anim as unknown as Animation;
  } as typeof Element.prototype.animate;
}

function Harness({ scene = true }: { scene?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLogoRound(ref);
  return (
    <div ref={ref} data-testid="logo">
      {scene && (
        <div className="hero-logo-spin">
          <div className="hero-logo-pillar-left" />
          <div className="hero-logo-pillar-right" />
          <div className="hero-logo-pearl" />
        </div>
      )}
    </div>
  );
}

/** Advance the platform clocks: running animations tick, scheduled timers fire. */
function elapse(ms: number): void {
  captured.forEach((entry) => {
    if (entry.anim.playState === "running") {
      entry.anim.currentTime = (entry.anim.currentTime ?? 0) + ms;
    }
  });
  vi.advanceTimersByTime(ms);
}

describe("useLogoRound", () => {
  beforeEach(() => {
    captured = [];
    installFakeAnimate();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Element.prototype.animate = originalAnimate as typeof Element.prototype.animate;
    vi.unstubAllGlobals();
  });

  it("drives spin, both gates, and the pearl with one closed round", () => {
    render(<Harness />);
    expect(captured.map((entry) => entry.element.className)).toEqual([
      "hero-logo-spin",
      "hero-logo-pillar-left",
      "hero-logo-pillar-right",
      "hero-logo-pearl",
    ]);
    const frames = buildRoundKeyframes();
    expect(captured[0].frames).toEqual(frames.spin);
    expect(captured[3].frames).toEqual(frames.pearl);
    expect(captured[0].options.duration).toBe(ROUND_MS);
    expect(captured[0].options.iterations).toBe(Infinity);
  });

  it("plays one round on mount, then settles on the exact rest pose", () => {
    render(<Harness />);
    expect(captured.every((entry) => entry.anim.playState === "running")).toBe(true);
    elapse(ROUND_MS + 40); // a late boundary tick still settles
    expect(captured.every((entry) => entry.anim.cancelCalls === 1)).toBe(true);
    // released animations fall back to the static CSS pose: the exact rest mark
    expect(captured.every((entry) => entry.anim.playState === "idle")).toBe(true);
  });

  it("keeps the round looping while the pointer stays on the logo", () => {
    render(<Harness />);
    fireEvent.mouseEnter(screen.getByTestId("logo"));
    elapse(ROUND_MS);
    elapse(ROUND_MS);
    expect(captured.every((entry) => entry.anim.pauseCalls === 0)).toBe(true);
  });

  it("settles at the round boundary after the pointer leaves", () => {
    render(<Harness />);
    fireEvent.mouseEnter(screen.getByTestId("logo"));
    fireEvent.mouseLeave(screen.getByTestId("logo"));
    elapse(ROUND_MS);
    expect(captured.every((entry) => entry.anim.cancelCalls === 1)).toBe(true);
  });

  it("resumes and keeps looping when the pointer re-enters after settling", () => {
    render(<Harness />);
    elapse(ROUND_MS);
    fireEvent.mouseEnter(screen.getByTestId("logo"));
    expect(captured.every((entry) => entry.anim.playCalls === 1)).toBe(true);
    expect(captured.every((entry) => entry.anim.playState === "running")).toBe(true);
    elapse(ROUND_MS * 2);
    // still hovered: no further settle on top of the mount round
    expect(captured.every((entry) => entry.anim.cancelCalls === 1)).toBe(true);
  });

  it("pauses while the tab is hidden and resumes after", () => {
    render(<Harness />);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(captured.every((entry) => entry.anim.pauseCalls === 1)).toBe(true);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(captured.every((entry) => entry.anim.playCalls === 1)).toBe(true);
  });

  it("stands down under prefers-reduced-motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    );
    render(<Harness />);
    expect(captured).toHaveLength(0);
  });

  it("stands down when the scene markup is missing", () => {
    render(<Harness scene={false} />);
    expect(captured).toHaveLength(0);
  });
});
