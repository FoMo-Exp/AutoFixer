// Visual accretion model, not a null-geodesic integrator. Dimensionless radius
// is calibrated to the apparent shadow in the artwork, not a Schwarzschild radius.
// Research and intentional approximations: docs/black-hole-motion.md.
export type Point = { x: number; y: number };
export type AccretionSample = Point & {
  distance: number;
  radius: number;
  phase: number;
  capture: number;
  beaming: number;
  farSide: number;
};

export function smoothstep(start: number, end: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

export function createAccretionPath(
  width: number,
  height: number,
  right: boolean,
  lane: number,
): AccretionSample[] {
  const samples: AccretionSample[] = [];
  const shadowRadius = height * 0.18;
  const dt = 0.035;
  let radius = 5.6 + lane * 0.22;
  let phase = (right ? 0 : Math.PI) + lane * 0.14 + (right ? -0.08 : 0.06);
  let distance = 0;
  for (let step = 0; step < 6000; step += 1) {
    const x = radius * Math.cos(phase);
    const farSide = Math.sin(phase);
    const inclination = 0.085 + lane * 0.008;
    const planeHeight = radius * farSide * inclination;
    const lens = Math.exp(-Math.pow(x / 1.16, 4)) * smoothstep(0, 0.25, farSide);
    const arcRadius = 1.04 ** 2 - x ** 2;
    // Smooth the lens caustic: a hard square-root corner folds a finite-width
    // code ribbon into a fan at the shoulders of the apparent shadow.
    const arc =
      Math.sqrt((arcRadius + Math.sqrt(arcRadius ** 2 + 0.04)) * 0.5) * (1 + 0.055 * (radius - 1));
    const y = -planeHeight * (1 - lens) - arc * lens;
    const position = { x: width * 0.5 + x * shadowRadius, y: height * 0.62 + y * shadowRadius };
    const previous = samples[samples.length - 1];
    if (previous) distance += Math.hypot(position.x - previous.x, position.y - previous.y);
    samples.push({
      ...position,
      distance,
      radius,
      phase,
      farSide,
      capture: 1 - smoothstep(1.015, 1.65, radius),
      // Fixed camera: the right side approaches the observer in this rotation.
      beaming: Math.max(0.4, Math.min(1.28, 0.86 + Math.cos(phase) * 0.36)),
    });
    if (radius <= 1.008) break;
    // Kepler-like differential rotation outside the capture region. The lapse
    // is an artistic distant-observer timing factor, not a GR coordinate solver.
    const lapse = Math.sqrt(Math.max(0.012, 1 - 1 / radius));
    const plunge = 1 - smoothstep(1.25, 1.85, radius);
    phase -= (1.4 / radius ** 1.5) * lapse * dt;
    radius -= (0.2 / Math.sqrt(radius)) * (1 + 2 * plunge) * lapse * dt;
  }
  return samples;
}

export function sampleAccretion(
  path: AccretionSample[],
  age: number,
): {
  progress: number;
  radius: number;
  capture: number;
  beaming: number;
  farSide: number;
} {
  const index = Math.max(0, Math.min(1, age)) * (path.length - 1);
  const before = path[Math.floor(index)];
  const after = path[Math.min(path.length - 1, Math.floor(index) + 1)];
  const t = index - Math.floor(index);
  const mix = (a: number, b: number): number => a + (b - a) * t;
  return {
    progress: mix(before.distance, after.distance) / path[path.length - 1].distance,
    radius: mix(before.radius, after.radius),
    capture: mix(before.capture, after.capture),
    beaming: mix(before.beaming, after.beaming),
    farSide: mix(before.farSide, after.farSide),
  };
}

export function samplePath(path: AccretionSample[], progress: number): Point {
  const target = Math.max(0, Math.min(1, progress)) * path[path.length - 1].distance;
  let low = 0;
  let high = path.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (path[middle].distance < target) low = middle;
    else high = middle;
  }
  const before = path[low];
  const after = path[high];
  const t = (target - before.distance) / Math.max(0.001, after.distance - before.distance);
  return { x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t };
}
