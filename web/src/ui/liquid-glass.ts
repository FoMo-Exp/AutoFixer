/*
 * Glasswork — MIT License, Copyright (c) 2026 Kubai087
 * Source: https://github.com/kubai087/glasswork
 *
 * This copy is vendored for ForgePilot. The logic is the upstream rim lens,
 * ported to TypeScript with unchanged geometry; the CSS material rules in
 * styles.css are adapted from glass.css under the same license.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The rim lens of Lumno's liquid glass, as a standalone module.
 *
 *   const lens = liquidGlass(element, { rim: 40, edge: 1.1, power: 2.6, dispersion: 0.15 });
 *   lens.update({ rim: 32 });   // change any option later
 *   lens.destroy();
 *
 * The wallpaper behind a surface's rim bends inward, the way the edge of a
 * thick glass slab refracts, and splits slightly into its colors there. An
 * SVG displacement map drives the bend through `backdrop-filter: url(#…)`,
 * which only Chromium draws; everywhere else nothing happens and the
 * CSS-only glass stays. The element must put `var(--glass-lens,)` last in
 * its backdrop-filter:
 *
 *   backdrop-filter: blur(2px) saturate(180%) var(--glass-lens,);
 *
 * The map is a nine-slice lens: only the rim bends, and a rim depends on the
 * corner's radius and shape and the rim's width alone, so a lens is four
 * corner tiles and four one-pixel edge strips (stretched along the sides)
 * over a flat middle. The tiles are built and decoded once per rim and shared
 * by every surface; a surface that resizes only moves its tiles.
 */

export interface LiquidGlassOptions {
  /** The widest the rim gets, in CSS pixels. */
  rim?: number;
  /** How far inward the very edge samples the scene, in rim widths. */
  edge?: number;
  /** How fast the bend falls off across the rim: (1 - d / rim) ^ power. */
  power?: number;
  /** Red bends this much further and blue this much less; 0 for one pass. */
  dispersion?: number;
  /** The corner's radius in pixels; read from the element when null. */
  radius?: number | null;
  /** The superellipse exponent (2 is a circle); read from the element when null. */
  corner?: number | null;
  /** Turns the lens off without destroying it. */
  enabled?: boolean;
  /** The custom property the filter goes in. */
  property?: string;
}

export interface LiquidGlassHandle {
  supported: boolean;
  bezel: number;
  update(next?: LiquidGlassOptions): void;
  refresh(): void;
  destroy(): void;
}

interface LensOptions {
  rim: number;
  edge: number;
  power: number;
  dispersion: number;
  radius: number | null;
  corner: number | null;
  enabled: boolean;
  property: string;
}

interface TileSet {
  size: number;
  urls: string[];
}

interface BuiltLens {
  id: string;
  host: SVGSVGElement;
  filter: SVGFilterElement;
  pieces: SVGImageElement[];
  passes: { el: SVGFEDisplacementMapElement }[];
  tiles: TileSet;
}

interface CurrentLens {
  key: string;
  lens: BuiltLens;
  width: number;
  height: number;
}

const LENS_DEFAULTS: LensOptions = {
  rim: 40,
  edge: 1.1,
  power: 2.6,
  dispersion: 0.15,
  radius: null,
  corner: null,
  enabled: true,
  property: "--glass-lens",
};

// A circular corner's exponent (CSS corner-shape: round).
const ROUND_CORNER = 2;

// Too small a surface has no flat middle to look through.
const LENS_MIN_PX = 32;

// While the rim keeps changing (a slider being dragged, a window being
// resized), the lens already there bends to the new width and the new
// tiles are built once it has been still this long.
const SETTLE_MS = 140;

const SVG = "http://www.w3.org/2000/svg";

// Only Chromium draws url() in backdrop-filter. Firefox parses it and draws
// nothing; Safari (and every browser on iOS) draws none of it either.
function isLensSupported(): boolean {
  if (typeof CSS === "undefined" || !CSS.supports?.("backdrop-filter", "url(#a)")) {
    return false;
  }
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Firefox\//.test(ua);
}

// The superellipse exponent of a computed CSS corner-shape. round is a
// circle and squircle is superellipse(2); anything else reads as round.
function cornerExponent(shape: string | null | undefined): number {
  const value = String(shape || "").trim();
  if (value === "squircle") return 4;
  const match = /^superellipse\(\s*([^)\s]+)\s*\)$/.exec(value);
  const k = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(k) && k >= 0 ? 2 ** k : ROUND_CORNER;
}

// ---------- The map ----------

// How much of the rim's bend a point keeps, `depth` of the way across it.
function rimStrength(depth: number, power: number): number {
  return depth >= 1 ? 0 : (1 - Math.max(0, depth)) ** power;
}

// The rim's contours run from the outline (depth 0) to the rim's inner edge
// (depth 1), each the outline inset by that share of the rim. A corner
// tighter than the rim widens its inner contours toward one as wide as the
// rim, so the bend turns the corner smoothly instead of snapping along the
// diagonal (a seam the color split would light).
function contourRadius(depth: number, radius: number, bezel: number): number {
  if (radius >= bezel) return radius - depth * bezel;
  return (1 - depth) * (radius + (bezel - radius) * depth * (2 - depth));
}

function isWithinContour(
  x: number,
  y: number,
  depth: number,
  radius: number,
  bezel: number,
  corner: number,
): boolean {
  const inset = depth * bezel;
  if (x < inset || y < inset) return false;
  const curve = contourRadius(depth, radius, bezel);
  const center = inset + curve;
  if (x >= center || y >= center) return true;
  return ((center - x) / curve) ** corner + ((center - y) / curve) ** corner <= 1;
}

// The inward bend at a point `x` and `y` from a corner's two edges.
function bendNearCorner(
  x: number,
  y: number,
  radius: number,
  bezel: number,
  corner: number,
  power: number,
): [number, number] {
  if (isWithinContour(x, y, 1, radius, bezel, corner)) return [0, 0];
  let depth = 0;
  if (isWithinContour(x, y, 0, radius, bezel, corner)) {
    // The contours are nested, so the depth a point lies at is found by halving.
    let low = 0;
    let high = 1;
    // 14 halvings place a point within 1/16000 of the rim: finer than a pixel.
    for (let step = 0; step < 14; step += 1) {
      const middle = (low + high) / 2;
      if (isWithinContour(x, y, middle, radius, bezel, corner)) low = middle;
      else high = middle;
    }
    depth = low;
  }
  const strength = rimStrength(depth, power);
  const curve = contourRadius(depth, radius, bezel);
  const center = depth * bezel + curve;
  if (x < center && y < center && curve > 0) {
    // Across the corner's curve: along its normal.
    const nx = Math.max(0, (center - x) / curve) ** (corner - 1);
    const ny = Math.max(0, (center - y) / curve) ** (corner - 1);
    const length = Math.hypot(nx, ny) || 1;
    return [(nx / length) * strength, (ny / length) * strength];
  }
  return x < y ? [strength, 0] : [0, strength];
}

// Inward offset at a point: unit direction times strength (1 at the rim's
// outer edge, 0 in the flat middle).
function rimDisplacement(
  x: number,
  y: number,
  width: number,
  height: number,
  {
    bezel,
    radius,
    corner = ROUND_CORNER,
    power = LENS_DEFAULTS.power,
  }: { bezel: number; radius: number; corner?: number; power?: number },
): [number, number] {
  const rim = Math.min(bezel, height / 2, width / 2);
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const [inwardX, inwardY] = bendNearCorner(
    Math.min(x, width - x),
    Math.min(y, height - y),
    r,
    rim,
    corner,
    power,
  );
  if (inwardX === 0 && inwardY === 0) return [0, 0];
  return [x < width / 2 ? inwardX : -inwardX, y < height / 2 ? inwardY : -inwardY];
}

// Where each tile sits on a surface of this size: corners (top left, top
// right, bottom left, bottom right) then edges (top, bottom, left, right).
function lensLayout(
  width: number,
  height: number,
  size: number,
): [number, number, number, number][] {
  const across = Math.max(1, width - size * 2);
  const down = Math.max(1, height - size * 2);
  return [
    [0, 0, size, size],
    [width - size, 0, size, size],
    [0, height - size, size, size],
    [width - size, height - size, size, size],
    [size, 0, across, size],
    [size, height - size, across, size],
    [0, size, size, down],
    [width - size, size, size, down],
  ];
}

// The tiles' pixels, read off a probe surface one pixel wider than two
// tiles. Red is the sideways bend and green the vertical one, 128 none.
function tilePixels(
  radius: number,
  bezel: number,
  corner: number,
  power: number,
): { size: number; tiles: { width: number; height: number; data: Uint8ClampedArray }[] } {
  const size = Math.max(1, Math.ceil(Math.max(radius, bezel)));
  const probe = size * 2 + 1;
  const geometry = { bezel, radius, corner, power };
  return {
    size,
    tiles: lensLayout(probe, probe, size).map(([left, top, w, h]) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const [dx, dy] = rimDisplacement(left + x + 0.5, top + y + 0.5, probe, probe, geometry);
          const i = (y * w + x) * 4;
          data[i] = Math.round(128 + dx * 127);
          data[i + 1] = Math.round(128 + dy * 127);
          data[i + 2] = 128;
          data[i + 3] = 255;
        }
      }
      return { width: w, height: h, data };
    }),
  };
}

// Tiles for one rim, as decoded PNG data URLs: a filter whose images are
// still decoding draws without its blur, so no surface points at one early.
const tileCache = new Map<string, Promise<TileSet>>();
const TILE_CACHE_MAX = 48;

function lensTiles(radius: number, bezel: number, corner: number, power: number): Promise<TileSet> {
  const key = `${radius}:${bezel}:${corner.toFixed(3)}:${power.toFixed(3)}`;
  let entry = tileCache.get(key);
  if (entry) {
    // Most recently used last.
    tileCache.delete(key);
    tileCache.set(key, entry);
    return entry;
  }
  const { size, tiles } = tilePixels(radius, bezel, corner, power);
  // Encoded with toBlob, which compresses off the main thread, and kept as
  // object URLs for as long as the page lives (a rim's tiles are small).
  entry = Promise.all(
    tiles.map((tile) => {
      const canvas = document.createElement("canvas");
      canvas.width = tile.width;
      canvas.height = tile.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is unavailable.");
      const image = context.createImageData(tile.width, tile.height);
      image.data.set(tile.data);
      context.putImageData(image, 0, 0);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")).then(
        async (blob) => {
          const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png");
          const decoded = new Image();
          decoded.src = url;
          await decoded.decode().catch(() => undefined);
          return url;
        },
      );
    }),
  ).then((urls) => ({ size, urls }));
  tileCache.set(key, entry);
  while (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCache.delete(oldest);
  }
  return entry;
}

// ---------- The filter ----------

function node<T extends SVGElement>(
  tag: string,
  attrs: Record<string, string | number>,
  parent?: Element | null,
): T {
  const el = document.createElementNS(SVG, tag) as T;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  parent?.append(el);
  return el;
}

let filterCount = 0;

// The lens tiles over a flat flood make the map; the backdrop is displaced
// by it once, or once per color channel by its own share of the bend, the
// three added back together (screen on single channels is a sum). Each
// filter gets an <svg> of its own: adding one to an <svg> that holds others
// can make Chrome reload all their images, and a backdrop naming a filter
// whose images are reloading drops its blur.
function buildFilter(width: number, height: number, tiles: TileSet, split: boolean): BuiltLens {
  const id = `liquid-glass-lens-${++filterCount}`;
  const host = node<SVGSVGElement>("svg", {
    "aria-hidden": "true",
    width: 0,
    height: 0,
    style: "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none",
  });
  const filter = node<SVGFilterElement>(
    "filter",
    {
      id,
      filterUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB",
      x: 0,
      y: 0,
      width,
      height,
    },
    host,
  );
  node<SVGFEFloodElement>("feFlood", { "flood-color": "rgb(128,128,128)", result: "flat" }, filter);
  const rects = lensLayout(width, height, tiles.size);
  const pieces = rects.map(([x, y, w, h], index) =>
    node<SVGImageElement>(
      "feImage",
      {
        href: tiles.urls[index],
        preserveAspectRatio: "none",
        x,
        y,
        width: w,
        height: h,
        result: `t${index}`,
      },
      filter,
    ),
  );
  const merge = node<SVGFEMergeElement>("feMerge", { result: "map" }, filter);
  node<SVGFEMergeNodeElement>("feMergeNode", { in: "flat" }, merge);
  rects.forEach((_, index) =>
    node<SVGFEMergeNodeElement>("feMergeNode", { in: `t${index}` }, merge),
  );
  const passes: { el: SVGFEDisplacementMapElement }[] = [];
  const pass = () => {
    passes.push({
      el: node<SVGFEDisplacementMapElement>(
        "feDisplacementMap",
        {
          in: "SourceGraphic",
          in2: "map",
          xChannelSelector: "R",
          yChannelSelector: "G",
          scale: 0,
        },
        filter,
      ),
    });
  };
  if (split) {
    (["r", "g", "b"] as const).forEach((name, channel) => {
      pass();
      // Keeps this channel and alpha: a 1 on the 4x5 matrix's diagonal.
      const keep = Array.from({ length: 20 }, (_, cell) =>
        Number(cell === channel * 6 || cell === 18),
      ).join(" ");
      node<SVGFEColorMatrixElement>(
        "feColorMatrix",
        { type: "matrix", values: keep, result: name },
        filter,
      );
    });
    node<SVGFEBlendElement>("feBlend", { in: "r", in2: "g", mode: "screen" }, filter);
    node<SVGFEBlendElement>("feBlend", { in2: "b", mode: "screen" }, filter);
  } else {
    pass();
  }
  document.body.append(host);
  return { id, host, filter, pieces, passes, tiles };
}

function placeFilter(lens: BuiltLens, width: number, height: number): void {
  lens.filter.setAttribute("width", String(width));
  lens.filter.setAttribute("height", String(height));
  lensLayout(width, height, lens.tiles.size).forEach(([x, y, w, h], index) => {
    const piece = lens.pieces[index];
    piece.setAttribute("x", String(x));
    piece.setAttribute("y", String(y));
    piece.setAttribute("width", String(w));
    piece.setAttribute("height", String(h));
  });
}

// ---------- A surface ----------

/**
 * Gives `el` a rim lens in its --glass-lens property and keeps it fitted as
 * the element resizes.
 */
export function liquidGlass(el: HTMLElement, options: LiquidGlassOptions = {}): LiquidGlassHandle {
  let opts: LensOptions = { ...LENS_DEFAULTS, ...options };
  const supported = isLensSupported();
  let current: CurrentLens | null = null;
  let token = 0;
  let frame = 0;
  let lastChange = 0;
  let settle = 0;
  let observer: ResizeObserver | null = null;
  const api: LiquidGlassHandle = {
    supported,
    bezel: 0,
    update(next = {}) {
      opts = { ...opts, ...next };
      schedule();
    },
    refresh: () => schedule(),
    destroy,
  };
  if (!supported) {
    // Nothing to draw: every call is a no-op.
    api.update = () => {};
    api.refresh = () => {};
    api.destroy = () => {};
    return api;
  }

  function clear(): void {
    token += 1;
    el.style.removeProperty(opts.property);
    current?.lens.host.remove();
    current = null;
  }

  function setScale(lens: BuiltLens, bezel: number): void {
    const scale = 2 * opts.edge * bezel;
    const split = lens.passes.length > 1;
    lens.passes.forEach((pass, channel) => {
      const share = split ? 1 + (1 - channel) * opts.dispersion : 1;
      pass.el.setAttribute("scale", (scale * share).toFixed(1));
    });
  }

  async function fit(): Promise<void> {
    frame = 0;
    const width = Math.round(el.offsetWidth);
    const height = Math.round(el.offsetHeight);
    if (!opts.enabled || width < LENS_MIN_PX || height < LENS_MIN_PX) {
      clear();
      return;
    }
    const style = getComputedStyle(el);
    const cssRadius = Number.parseFloat(style.borderTopLeftRadius) || 0;
    const radius = Math.round(Math.min(opts.radius ?? cssRadius, width / 2, height / 2));
    const corner = opts.corner ?? cornerExponent(style.getPropertyValue("corner-top-left-shape"));
    const bezel = Math.round(Math.max(4, Math.min(opts.rim, Math.min(width, height) / 3.5)));
    const split = opts.dispersion > 0;
    const key = `${radius}:${bezel}:${corner.toFixed(3)}:${opts.power.toFixed(3)}:${split}`;
    api.bezel = bezel;
    if (current?.key === key) {
      if (current.width !== width || current.height !== height) {
        placeFilter(current.lens, width, height);
        current.width = width;
        current.height = height;
      }
      setScale(current.lens, bezel);
      return;
    }
    const now = performance.now();
    const settling = current && now - lastChange < SETTLE_MS;
    lastChange = now;
    if (settling) {
      if (current && (current.width !== width || current.height !== height)) {
        placeFilter(current.lens, width, height);
        current.width = width;
        current.height = height;
      }
      if (current) setScale(current.lens, bezel);
      clearTimeout(settle);
      settle = window.setTimeout(schedule, SETTLE_MS);
      return;
    }
    // New tiles can take a few frames; until then the lens in use covers
    // the new size, so no part of the surface goes without it.
    if (current && (current.width !== width || current.height !== height)) {
      placeFilter(current.lens, width, height);
      current.width = width;
      current.height = height;
      setScale(current.lens, bezel);
    }
    const mine = ++token;
    const tiles = await lensTiles(radius, bezel, corner, opts.power);
    if (mine !== token) return;
    const lens = buildFilter(width, height, tiles, split);
    setScale(lens, bezel);
    const previous = current;
    current = { key, lens, width, height };
    el.style.setProperty(opts.property, `url(#${lens.id})`);
    // Let the new filter draw before the old one goes.
    if (previous) {
      requestAnimationFrame(() => requestAnimationFrame(() => previous.lens.host.remove()));
    }
  }

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(() => void fit());
  }

  observer = new ResizeObserver(schedule);
  observer.observe(el);

  function destroy(): void {
    observer?.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(settle);
    clear();
  }

  schedule();
  return api;
}
