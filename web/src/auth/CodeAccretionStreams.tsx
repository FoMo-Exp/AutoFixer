import { useEffect, useRef } from "react";
import type { ReactElement } from "react";

import {
  createAccretionPath,
  sampleAccretion,
  samplePath,
  smoothstep,
} from "./code-accretion-physics";
import type { Point, AccretionSample as Sample } from "./code-accretion-physics";
type Snippet = { source: string; keywords: string[] };

// Decorative source examples only; these strings are never executed.
const snippets: Snippet[] = [
  {
    source: "const plan = await prepare(issue);\nawait requestReview(plan);",
    keywords: ["const", "await"],
  },
  {
    source: "def prepare(issue):\n    return Plan(issue, approved=False)",
    keywords: ["def", "return", "False"],
  },
  {
    source: "func review(ctx Context) error {\n    return gate.Check(ctx)\n}",
    keywords: ["func", "return", "error"],
  },
  {
    source: "let change = prepare(&issue)?;\nreview.submit(change).await?;",
    keywords: ["let", "await"],
  },
  {
    source: "SELECT title, state FROM issues\nWHERE state = 'open';",
    keywords: ["SELECT", "FROM", "WHERE"],
  },
  {
    source: "public Plan prepare(Issue issue) {\n    return planner.create(issue);\n}",
    keywords: ["public", "return"],
  },
  {
    source: "auto change = prepare(issue);\nif (gate.accepts(change)) review(change);",
    keywords: ["auto", "if"],
  },
  {
    source: "def review(change)\n  gate.check(change) if change.ready?\nend",
    keywords: ["def", "if", "end"],
  },
  {
    source: "let plan = try await prepare(issue)\nreturn ReviewRequest(plan: plan)",
    keywords: ["let", "try", "await", "return"],
  },
  { source: "dotnet build --no-restore\ngit diff --stat", keywords: ["dotnet", "git"] },
];

function drawBentSnippet(
  context: CanvasRenderingContext2D,
  image: HTMLCanvasElement,
  path: Sample[],
  progress: number,
  scale: number,
  alpha: number,
  width: number,
  height: number,
  fieldStrength: number,
  capture: number,
): void {
  if (alpha < 0.01 || scale < 0.025) return;
  const center = samplePath(path, progress);
  const proximity = Math.hypot(
    (center.x - width * 0.5) / (width * 0.23),
    (center.y - height * 0.62) / (height * 0.25),
  );
  const bend = smoothstep(0.015, 0.16, progress) * (1 - smoothstep(1.05, 2.7, proximity));
  // Tide stretching: along the flow the ribbon elongates, across it the glyphs
  // compress, so the last visible moment reads as matter being pulled apart.
  const plunge = smoothstep(0.55, 1, capture);
  const stretch = 1 + bend * (0.45 + fieldStrength * 1.2) + plunge * 1.1;
  const squeeze = Math.max(0.42, 1 - bend * (0.22 + fieldStrength * 0.4) - plunge * 0.3);
  const totalLength = path[path.length - 1].distance;
  // Keep the code reading left to right wherever the orbit runs. Choosing the
  // strip order from the local screen tangent keeps the glyphs upright on both
  // the far and near side; the orbit itself still runs in one direction.
  const ahead = samplePath(path, Math.min(1, progress + 0.008));
  const behind = samplePath(path, Math.max(0, progress - 0.008));
  const tangentX = ahead.x - behind.x;
  const tangentY = ahead.y - behind.y;
  const tangentSpeed = Math.hypot(tangentX, tangentY);
  const uprightness = tangentSpeed > 0.001 ? Math.abs(tangentX) / tangentSpeed : 0;
  // The reading direction flips where the orbit turns and the tangent goes
  // vertical — the left and right edges of the bright disk. Fade the whole
  // snippet through that turn so the swap is not a visible jump.
  const edgeFade = smoothstep(0.2, 0.5, uprightness);
  const reading = tangentX >= 0 ? 1 : -1;
  context.save();
  context.globalAlpha = alpha;
  // Source-over keeps the glyphs readable over the bright band; screen blending
  // blew them out to white exactly where the capture moment is.
  context.globalCompositeOperation = "source-over";
  if (bend < 0.002) {
    context.drawImage(
      image,
      center.x - (image.width * scale) / 4,
      center.y - (image.height * scale) / 4,
      (image.width * scale) / 2,
      (image.height * scale) / 2,
    );
    context.restore();
    return;
  }
  const stripAlpha = alpha * edgeFade;
  if (stripAlpha < 0.01) {
    context.restore();
    return;
  }

  // Raster strips follow different positions and tangents on the same curve.
  // This deforms the glyphs themselves, rather than rotating a rectangular card.
  const mapEdge = (sourceX: number): Point & { progress: number } => {
    const localX = (sourceX / 2 - image.width / 4) * scale;
    const distance =
      localX * stretch * (1 + ((bend * localX) / Math.max(1, image.width * scale)) * 0.55);
    const edgeProgress = progress + (reading * distance) / totalLength;
    const curved = samplePath(path, edgeProgress);
    return {
      x: center.x + distance * (1 - bend) + (curved.x - center.x) * bend,
      y: center.y + (curved.y - center.y) * bend,
      progress: edgeProgress,
    };
  };
  for (let sourceX = 0; sourceX < image.width; sourceX += 4) {
    const stripWidth = Math.min(4.25, image.width - sourceX);
    const before = mapEdge(sourceX);
    const after = mapEdge(sourceX + stripWidth);
    // Strips past either end of the orbit have crossed the horizon. Dropping
    // them eats the ribbon strip by strip instead of stacking every leftover
    // strip on the path endpoint, which piled up into a bright blob.
    const mid = (before.progress + after.progress) / 2;
    if (mid < 0 || mid > 1) continue;
    const edge = smoothstep(0, 0.035, mid) * (1 - smoothstep(0.965, 1, mid));
    if (edge < 0.02) continue;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    // At the left and right turning points of the projected orbit the path runs
    // momentarily vertical. The strip transform maps glyph columns onto that
    // tangent while keeping the text upright, so both transform axes become
    // parallel and the glyphs collapse into a sliver that flips with `reading`.
    // Fade through the turn: the code sinks into the bright limb and returns
    // upright on the other side instead of shivering.
    const stripSpeed = Math.hypot(dx, dy);
    const uprightness = stripSpeed > 0.001 ? Math.abs(dx) / stripSpeed : 0;
    const readable = smoothstep(0.2, 0.5, uprightness);
    if (readable < 0.02) continue;
    context.save();
    context.globalAlpha = stripAlpha * edge * readable;
    context.translate(before.x, before.y);
    // Match both strip edges exactly to the warp; an approximate tangent scale
    // creates visible gaps and comb-like bands in the soft emission layer. The
    // glyph column stays vertical so text never turns upside down mid-orbit.
    context.transform(dx / (stripWidth / 2), dy / (stripWidth / 2), 0, scale * squeeze, 0, 0);
    context.drawImage(
      image,
      sourceX,
      0,
      stripWidth,
      image.height,
      0,
      -image.height / 4,
      stripWidth / 2,
      image.height / 2,
    );
    context.restore();
  }
  context.restore();
}

export function CodeAccretionStreams(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const styles = getComputedStyle(canvas);
    const token = (name: string): string => styles.getPropertyValue(name).trim();
    const colors = {
      text: token("--auth-code-text"),
      keyword: token("--auth-code-keyword"),
      string: token("--auth-code-string"),
      number: token("--auth-code-number"),
      function: token("--auth-code-function"),
      type: token("--auth-code-type"),
      operator: token("--auth-code-operator"),
    };
    const fontSize = Number.parseFloat(token("--fs-body")) || 14;
    const glowWide = Number.parseFloat(token("--auth-code-glow-wide"));
    const glowTight = Number.parseFloat(token("--auth-code-glow-tight"));
    const padding = Number.parseFloat(token("--sp-8"));
    const font = `500 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
    const textures = snippets.map((snippet) => {
      const image = document.createElement("canvas");
      const ctx = image.getContext("2d");
      if (!ctx) return image;
      ctx.font = font;
      const lines = snippet.source.split("\n");
      const width =
        Math.ceil(Math.max(...lines.map((line) => ctx.measureText(line).width))) + padding * 2;
      const height = lines.length * 20 + padding * 2;
      image.width = width * 2;
      image.height = height * 2;
      ctx.scale(2, 2);
      ctx.font = font;
      ctx.textBaseline = "top";
      lines.forEach((line, row) => {
        let x = padding;
        const pieces = line.match(/"[^"\n]*"|'[^'\n]*'|\b\d+\b|\b[A-Za-z_][\w]*\b|[^\w"']+/g) ?? [];
        pieces.forEach((piece, index) => {
          let color = colors.text;
          if (/^["']/.test(piece)) color = colors.string;
          else if (/^\d/.test(piece)) color = colors.number;
          else if (snippet.keywords.includes(piece)) color = colors.keyword;
          else if (/^[A-Z]/.test(piece)) color = colors.type;
          else if (pieces[index + 1]?.startsWith("(")) color = colors.function;
          else if (/[=+&?!<>]/.test(piece)) color = colors.operator;
          ctx.fillStyle = color;
          ctx.fillText(piece, x, padding + row * 20);
          x += ctx.measureText(piece).width;
        });
      });
      // Pre-render emission at texture resolution: both glow layers then deform
      // with the glyphs, without running blur filters in the animation loop.
      const glowing = document.createElement("canvas");
      glowing.width = image.width;
      glowing.height = image.height;
      const glow = glowing.getContext("2d");
      if (!glow) return image;
      glow.globalCompositeOperation = "lighter";
      glow.globalAlpha = 0.55;
      glow.filter = `blur(${glowWide * 2}px)`;
      glow.drawImage(image, 0, 0);
      glow.globalAlpha = 0.75;
      glow.filter = `blur(${glowTight * 2}px)`;
      glow.drawImage(image, 0, 0);
      glow.filter = "none";
      glow.globalAlpha = 1;
      glow.globalCompositeOperation = "source-over";
      glow.drawImage(image, 0, 0);
      return glowing;
    });
    const redshifted = textures.map((image) => {
      const tinted = document.createElement("canvas");
      tinted.width = image.width;
      tinted.height = image.height;
      const tint = tinted.getContext("2d");
      if (!tint) return image;
      tint.drawImage(image, 0, 0);
      tint.globalCompositeOperation = "source-in";
      tint.fillStyle = token("--auth-code-capture");
      tint.fillRect(0, 0, tinted.width, tinted.height);
      return tinted;
    });
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 1;
    let height = 1;
    let paths: Sample[][] = [];
    let secondaryPaths: Sample[][] = [];
    let frame = 0;
    let elapsed = 0;
    let previousTime = 0;
    let disposed = false;

    const draw = (): void => {
      const ratio = canvas.width / width;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const mobile = window.innerWidth <= 680;
      const count = mobile ? 3 : 6;
      for (let index = 0; index < count; index += 1) {
        const duration = 24 + (index % 3) * 1.8;
        const age = elapsed / duration + ((index * 0.61803398875) % 1);
        const cycle = age % 1;
        const pathIndex = index % paths.length;
        const path = paths[pathIndex];
        // Distant-observer timing: infalling emission appears to slow as it
        // nears the horizon. Without it the final plunge takes half a second
        // and the swallow is invisible.
        const travel = 1 - (1 - cycle) ** 1.6;
        const state = sampleAccretion(path, travel);
        const { progress, radius, capture, beaming, farSide } = state;
        const fieldStrength = Math.min(1, 1.8 / radius ** 3);
        // Distance reduces apparent size; transverse compression strengthens
        // inward while a lensed arc can still stretch the image tangentially.
        // The floor keeps the last readable moments from collapsing into a speck.
        const scale = (mobile ? 0.62 : 0.95) * (0.26 + 0.74 * (radius / path[0].radius) ** 1.35);
        // Hold full strength until the ribbon is close to the apparent shadow,
        // then redshift and extinguish it at the horizon. The old exponential
        // fade killed the code in open space, so the capture read as a blink.
        const visibility = smoothstep(0.005, 0.075, cycle);
        // Redden well before the horizon so converging ribbons merge as embers,
        // then let the geometric cut at the path end finish the swallow.
        const horizonFade = 1 - smoothstep(0.93, 0.995, capture);
        const tint = smoothstep(0.45, 0.85, capture);
        const alpha = visibility * beaming * 0.86 * horizonFade;
        const textureIndex = (index + Math.floor(age)) % textures.length;
        // The lower image is the same far-side emission seen along a weaker
        // light path, not another stream of matter orbiting below the disk.
        const secondaryAlpha = alpha * smoothstep(0.12, 0.7, farSide) * 0.13;
        if (secondaryAlpha > 0.012) {
          drawBentSnippet(
            context,
            textures[textureIndex],
            secondaryPaths[pathIndex],
            progress,
            scale * 0.68,
            secondaryAlpha,
            width,
            height,
            fieldStrength,
            capture,
          );
        }
        drawBentSnippet(
          context,
          textures[textureIndex],
          path,
          progress,
          scale,
          alpha * (1 - tint),
          width,
          height,
          fieldStrength,
          capture,
        );
        if (tint > 0.015) {
          drawBentSnippet(
            context,
            redshifted[textureIndex],
            path,
            progress,
            scale,
            alpha * tint,
            width,
            height,
            fieldStrength,
            capture,
          );
        }
      }
    };
    const animate = (now: number): void => {
      frame = 0;
      if (previousTime) elapsed += Math.min((now - previousTime) / 1000, 0.1);
      previousTime = now;
      draw();
      if (!motion.matches && !document.hidden && !disposed) frame = requestAnimationFrame(animate);
    };
    const synchronize = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      draw();
      if (!motion.matches && !document.hidden && !disposed) frame = requestAnimationFrame(animate);
    };
    const resize = (): void => {
      width = Math.max(1, canvas.clientWidth);
      height = Math.max(1, canvas.clientHeight);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      paths = Array.from({ length: 6 }, (_, index) =>
        createAccretionPath(width, height, index % 2 === 1, Math.floor(index / 2) - 1),
      );
      secondaryPaths = paths.map((path) =>
        path.map((sample) => ({
          ...sample,
          y: height * 0.62 - (sample.y - height * 0.62) * 0.92,
        })),
      );
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    motion.addEventListener("change", synchronize);
    document.addEventListener("visibilitychange", synchronize);
    resize();
    synchronize();
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener("change", synchronize);
      document.removeEventListener("visibilitychange", synchronize);
    };
  }, []);
  return <canvas className="auth-code-streams" ref={canvasRef} />;
}
