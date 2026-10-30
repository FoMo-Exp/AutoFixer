/** One "双柱穿珠" hero round: full spin, counter-rotating gates, Möbius pearl. */
import { useEffect } from "react";
import type { RefObject } from "react";

export const ROUND_MS = 2600;

export interface PearlPos {
  x: number;
  y: number;
  z: number;
}

export interface RoundPose {
  /** Group rotation around Y — one full turn per round. */
  spinDeg: number;
  /** Gentle group nod around X. */
  nodDeg: number;
  /** Left gate rotation (right gate mirrors it). */
  pillarLDeg: number;
  pillarRDeg: number;
  pearl: PearlPos;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Half-sine bump that rises from rest and settles back to rest across [start, end]. */
function bump(t: number, start: number, end: number): number {
  if (t <= start || t >= end) return 0;
  return Math.sin((Math.PI * (t - start)) / (end - start));
}

/** Exact rest values, so closed-loop keyframes never carry float dust. */
function snap(value: number): number {
  return Math.abs(value) < 1e-9 ? 0 : value;
}

export interface LogoRoundKeyframes {
  spin: Keyframe[];
  pillarL: Keyframe[];
  pillarR: Keyframe[];
  pearl: Keyframe[];
}

/** Sample the round curve into closed-loop WAAPI keyframes per moving part. */
export function buildRoundKeyframes(samples = 25): LogoRoundKeyframes {
  const spin: Keyframe[] = [];
  const pillarL: Keyframe[] = [];
  const pillarR: Keyframe[] = [];
  const pearl: Keyframe[] = [];
  for (let index = 0; index < samples; index += 1) {
    const offset = index / (samples - 1);
    const pose = roundPose(offset);
    spin.push({ offset, transform: `rotateX(${pose.nodDeg}deg) rotateY(${pose.spinDeg}deg)` });
    pillarL.push({ offset, transform: `rotateY(${pose.pillarLDeg}deg)` });
    pillarR.push({ offset, transform: `rotateY(${pose.pillarRDeg}deg)` });
    const { x, y, z } = pose.pearl;
    pearl.push({ offset, transform: `translate3d(${x}px, ${y}px, ${z}px)` });
  }
  return { spin, pillarL, pillarR, pearl };
}

/**
 * Pose at round progress `t` (0..1). The curve is closed: t = 0 and t = 1 are
 * the static rest pose, so looping and early pausing both land seamlessly.
 */
export function roundPose(t: number): RoundPose {
  const tilt = 52 * bump(t, 0, 0.62);
  // Pearl finale: lemniscate around both gates whose depth phase drifts half a
  // turn (Möbius flip) while the envelope lands it back on the center point.
  const u = clamp01((t - 0.28) / 0.72);
  const env = u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
  const phi = 2 * Math.PI * u;
  return {
    spinDeg: snap(360 * t),
    nodDeg: snap(9 * Math.sin(2 * Math.PI * t)),
    pillarLDeg: snap(tilt),
    pillarRDeg: snap(-tilt),
    pearl: {
      x: snap(env * 9.6 * Math.sin(phi)),
      y: snap(env * 3.4 * Math.sin(2 * phi)),
      z: snap(env * 7.2 * Math.sin(phi + Math.PI * u)),
    },
  };
}

/**
 * Play the hero round on the mark inside `rootRef`: one round per mount (i.e.
 * every navigation back to the welcome screen), looping while the pointer rests
 * on the logo. A boundary timer settles the scene on the exact rest pose when
 * the round ends unhovered; leaving mid-loop lets the current round finish
 * first, so the pearl always lands back on its point.
 */
export function useLogoRound(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const spin = root.querySelector<HTMLElement>(".hero-logo-spin");
    const pillarL = root.querySelector<HTMLElement>(".hero-logo-pillar-left");
    const pillarR = root.querySelector<HTMLElement>(".hero-logo-pillar-right");
    const pearl = root.querySelector<HTMLElement>(".hero-logo-pearl");
    if (!spin || !pillarL || !pillarR || !pearl) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) return;

    const frames = buildRoundKeyframes();
    const options: KeyframeAnimationOptions = {
      duration: ROUND_MS,
      easing: "linear",
      fill: "both",
      iterations: Infinity,
    };
    const animations = [
      spin.animate(frames.spin, options),
      pillarL.animate(frames.pillarL, options),
      pillarR.animate(frames.pillarR, options),
      pearl.animate(frames.pearl, options),
    ];

    let hovered = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    // All four animations share one timeline. Playback events cannot be relied
    // on for boundaries (repeat does not fire reliably), so a timer wakes at
    // each iteration boundary — exactly where the closed round is at rest.
    const timeline = animations[0];

    const stopAll = (): void => {
      animations.forEach((animation) => {
        // cancel() rejects the finished promise; keep the teardown quiet.
        void animation.finished.catch(() => undefined);
        animation.cancel();
      });
    };
    const scheduleSettleCheck = (): void => {
      const current = Number(timeline.currentTime ?? 0);
      const nextBoundary = (Math.floor(current / ROUND_MS) + 1) * ROUND_MS;
      settleTimer = setTimeout(checkSettle, nextBoundary - current);
    };
    const checkSettle = (): void => {
      if (hovered) {
        scheduleSettleCheck();
        return;
      }
      // Release the animations: the mark falls back to its static CSS pose,
      // which is exactly the rest mark, whatever the timer drift was.
      stopAll();
    };
    const enter = (): void => {
      hovered = true;
      animations.forEach((animation) => animation.play());
      clearTimeout(settleTimer);
      scheduleSettleCheck();
    };
    const leave = (): void => {
      hovered = false;
    };
    root.addEventListener("mouseenter", enter);
    root.addEventListener("mouseleave", leave);

    let interrupted = false;
    const updateVisibility = (): void => {
      if (document.hidden) {
        interrupted = animations.some((animation) => animation.playState === "running");
        clearTimeout(settleTimer);
        if (interrupted) animations.forEach((animation) => animation.pause());
      } else if (interrupted) {
        interrupted = false;
        animations.forEach((animation) => animation.play());
        scheduleSettleCheck();
      }
    };
    document.addEventListener("visibilitychange", updateVisibility);
    scheduleSettleCheck();

    return () => {
      clearTimeout(settleTimer);
      root.removeEventListener("mouseenter", enter);
      root.removeEventListener("mouseleave", leave);
      document.removeEventListener("visibilitychange", updateVisibility);
      stopAll();
    };
  }, [rootRef]);
}
