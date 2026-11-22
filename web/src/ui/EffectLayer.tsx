import { useEffect, useRef } from "react";
import type { ReactElement, RefObject } from "react";
import { EFFECT_PALETTES } from "./image-effects";
import type { EffectPalette, EffectSettings } from "./image-effects";

interface EffectLayerProps {
  sourceRef: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  settings: EffectSettings;
  lightSurfacePaletteReveal?: {
    centerX: number;
    centerY: number;
    radiusX: number;
    radiusY: number;
    feather: number;
    coreRadiusX: number;
    coreRadiusY: number;
    shadowFloor: number;
    shadowSaturation: number;
  };
}

const ASCII_CHARS = "  .,:;-=+xX08S#&@";
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const PALETTE_STOPS: Record<Exclude<EffectPalette, "original">, number[]> = {
  meadow: [0, 0.4, 0.74, 1],
  blue: [0, 0.4, 0.74, 1],
  amber: [0, 0.4, 0.74, 1],
  lavender: [0, 0.4, 0.74, 1],
  mono: [0, 0.4, 0.74, 1],
};

function range(value: number, min: number, max: number): number {
  return min + ((max - min) * value) / 100;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function luminance(red: number, green: number, blue: number): number {
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function createPaletteLookup(palette: EffectPalette): Uint8ClampedArray | undefined {
  if (palette === "original") return undefined;
  const colors = EFFECT_PALETTES[palette].map(parseHex);
  const positions = PALETTE_STOPS[palette];
  const lookup = new Uint8ClampedArray(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    const tone = index / 255;
    const stop = Math.min(2, positions.findIndex((position) => position >= tone) - 1);
    const segment = Math.max(0, stop);
    const progress = clamp(
      (tone - positions[segment]) / (positions[segment + 1] - positions[segment]),
    );
    for (let channel = 0; channel < 3; channel += 1) {
      const start = colors[segment][channel];
      const end = colors[segment + 1][channel];
      lookup[index * 3 + channel] = Math.round(start + (end - start) * progress);
    }
  }
  return lookup;
}

function colorToHsv(red: number, green: number, blue: number): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToColor(hue: number, saturation: number, value: number): [number, number, number] {
  const sector = hue * 6;
  const index = Math.floor(sector);
  const fraction = sector - index;
  const low = value * (1 - saturation);
  const descending = value * (1 - fraction * saturation);
  const ascending = value * (1 - (1 - fraction) * saturation);
  const colors: [number, number, number][] = [
    [value, ascending, low],
    [descending, value, low],
    [low, value, ascending],
    [low, descending, value],
    [ascending, low, value],
    [value, low, descending],
  ];
  const color = colors[((index % 6) + 6) % 6];
  return [Math.round(color[0] * 255), Math.round(color[1] * 255), Math.round(color[2] * 255)];
}

function getSourceSize(source: HTMLImageElement | HTMLVideoElement): [number, number] {
  if (source.tagName.toLowerCase() === "video") {
    const video = source as HTMLVideoElement;
    return [video.videoWidth, video.videoHeight];
  }
  const image = source as HTMLImageElement;
  return [image.naturalWidth || image.width, image.naturalHeight || image.height];
}

function isReady(source: HTMLImageElement | HTMLVideoElement): boolean {
  if (source.tagName.toLowerCase() === "video") {
    return (source as HTMLVideoElement).readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }
  const image = source as HTMLImageElement;
  return image.complete && getSourceSize(image)[0] > 0;
}

function coverSource(
  context: CanvasRenderingContext2D,
  source: HTMLImageElement | HTMLVideoElement,
  width: number,
  height: number,
): void {
  const [sourceWidth, sourceHeight] = getSourceSize(source);
  if (!sourceWidth || !sourceHeight) return;
  const coverScale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * coverScale;
  const drawHeight = sourceHeight * coverScale;
  context.drawImage(
    source,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function recolorSamples(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  lookup: Uint8ClampedArray | undefined,
): ImageData {
  const image = context.getImageData(0, 0, width, height);
  if (!lookup) return image;
  const { data } = image;
  for (let pixel = 0; pixel < data.length; pixel += 4) {
    const tone = Math.round(luminance(data[pixel], data[pixel + 1], data[pixel + 2]) * 255);
    const source = tone * 3;
    data[pixel] = lookup[source];
    data[pixel + 1] = lookup[source + 1];
    data[pixel + 2] = lookup[source + 2];
    data[pixel + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return image;
}

function percentileRange(image: ImageData): [number, number] {
  const values: number[] = [];
  const pixels = image.data.length / 4;
  const samples = Math.min(12_000, pixels);
  for (let sample = 0; sample < samples; sample += 1) {
    const pixel = Math.floor((sample * (pixels - 1)) / Math.max(1, samples - 1));
    const offset = pixel * 4;
    values.push(luminance(image.data[offset], image.data[offset + 1], image.data[offset + 2]));
  }
  values.sort((first, second) => first - second);
  const low = values[Math.floor((values.length - 1) * 0.08)] ?? 0;
  const high = values[Math.floor((values.length - 1) * 0.92)] ?? 1;
  return [low, high];
}

function readPixel(image: ImageData, x: number, y: number): [number, number, number] {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function toneAt(
  lightness: number,
  low: number,
  high: number,
  darkInk: boolean,
  strength: number,
): number {
  const raw = darkInk ? 1 - lightness : lightness;
  const normalized =
    high - low < 0.025
      ? raw
      : clamp(darkInk ? (high - lightness) / (high - low) : (lightness - low) / (high - low));
  const mix = 0.72 + 0.14 * strength;
  const tone = raw * (1 - mix) + normalized * mix;
  const black = 0.22 * strength;
  const white = 1 - 0.08 * strength;
  const level = clamp((tone - black) / (white - black));
  return level * (1 - strength) + smoothstep(level) * strength;
}

function applyMask(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  amount: number,
): void {
  const lightPage = document.documentElement.dataset.surface === "light";
  const bases = lightPage ? [0.54, 0.2, 0.38] : [0.44, 0.2, 0.5];
  const alpha = (base: number): number =>
    amount <= 50 ? base * (amount / 50) ** 1.08 : base + (1 - base) * ((amount - 50) / 50) ** 1.08;
  const color = lightPage ? "255, 255, 255" : "0, 0, 0";
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `rgba(${color}, ${alpha(bases[0])})`);
  gradient.addColorStop(0.42, `rgba(${color}, ${alpha(bases[1])})`);
  gradient.addColorStop(1, `rgba(${color}, ${alpha(bases[2])})`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function applyLightSurfaceWash(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.78)");
  gradient.addColorStop(0.42, "rgba(255, 255, 255, 0.86)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0.96)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function drawLightSurfacePaletteReveal(
  context: CanvasRenderingContext2D,
  revealCanvas: HTMLCanvasElement,
  paletteRevealCanvas: HTMLCanvasElement,
  paletteCanvas: HTMLCanvasElement,
  width: number,
  height: number,
  deviceScale: number,
  reveal: NonNullable<EffectLayerProps["lightSurfacePaletteReveal"]>,
): void {
  paletteRevealCanvas.width = paletteCanvas.width;
  paletteRevealCanvas.height = paletteCanvas.height;
  const paletteRevealContext = paletteRevealCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!paletteRevealContext) return;
  paletteRevealContext.drawImage(paletteCanvas, 0, 0);
  const paletteImage = paletteRevealContext.getImageData(
    0,
    0,
    paletteRevealCanvas.width,
    paletteRevealCanvas.height,
  );
  const { data } = paletteImage;
  for (let pixel = 0; pixel < data.length; pixel += 4) {
    if (data[pixel + 3] === 0) continue;
    const pixelIndex = pixel / 4;
    const x = (pixelIndex % paletteRevealCanvas.width) / paletteRevealCanvas.width;
    const y = Math.floor(pixelIndex / paletteRevealCanvas.width) / paletteRevealCanvas.height;
    const coreX = (x - reveal.centerX) / reveal.coreRadiusX;
    const coreY = (y - reveal.centerY) / reveal.coreRadiusY;
    const inCore = coreX * coreX + coreY * coreY <= 1;
    if (!inCore) {
      const glowOpacity = smoothstep(
        clamp((luminance(data[pixel], data[pixel + 1], data[pixel + 2]) - 0.06) / 0.32),
      );
      data[pixel + 3] = Math.round(data[pixel + 3] * glowOpacity);
      continue;
    }

    const [hue, saturation, value] = colorToHsv(data[pixel], data[pixel + 1], data[pixel + 2]);
    if (value < reveal.shadowFloor) {
      const [red, green, blue] = hsvToColor(
        hue,
        Math.max(saturation, reveal.shadowSaturation),
        reveal.shadowFloor,
      );
      data[pixel] = red;
      data[pixel + 1] = green;
      data[pixel + 2] = blue;
    }
    data[pixel + 3] = 255;
  }
  paletteRevealContext.putImageData(paletteImage, 0, 0);

  revealCanvas.width = Math.max(1, Math.round(width * deviceScale));
  revealCanvas.height = Math.max(1, Math.round(height * deviceScale));
  const revealContext = revealCanvas.getContext("2d");
  if (!revealContext) return;

  revealContext.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  revealContext.drawImage(paletteRevealCanvas, 0, 0, width, height);
  revealContext.save();
  revealContext.globalCompositeOperation = "destination-in";
  revealContext.translate(width * reveal.centerX, height * reveal.centerY);
  revealContext.scale(width * reveal.radiusX, height * reveal.radiusY);
  const gradient = revealContext.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
  gradient.addColorStop(Math.max(0, 1 - reveal.feather), "rgba(0, 0, 0, 1)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  revealContext.fillStyle = gradient;
  revealContext.beginPath();
  revealContext.arc(0, 0, 1, 0, Math.PI * 2);
  revealContext.fill();
  revealContext.restore();
  context.drawImage(revealCanvas, 0, 0, width, height);
  const tokens = getComputedStyle(document.documentElement);
  const accentRgb = tokens.getPropertyValue("--accent-rgb").trim();
  const amberRgb = tokens.getPropertyValue("--amber-rgb").trim();
  if (!accentRgb || !amberRgb) return;
  paintRadialEllipse(context, width, height, reveal, reveal.radiusX, reveal.radiusY, [
    [0, `rgba(${accentRgb}, 0.12)`],
    [0.58, `rgba(${amberRgb}, 0.34)`],
    [0.86, `rgba(${amberRgb}, 0.24)`],
    [1, `rgba(${amberRgb}, 0)`],
  ]);
  paintRadialEllipse(context, width, height, reveal, reveal.coreRadiusX, reveal.coreRadiusY, [
    [0, `rgba(${accentRgb}, 0.92)`],
    [0.72, `rgba(${accentRgb}, 0.84)`],
    [1, `rgba(${amberRgb}, 0.58)`],
  ]);
}

function paintRadialEllipse(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  reveal: NonNullable<EffectLayerProps["lightSurfacePaletteReveal"]>,
  radiusX: number,
  radiusY: number,
  stops: Array<[number, string]>,
): void {
  context.save();
  context.translate(width * reveal.centerX, height * reveal.centerY);
  context.scale(width * radiusX, height * radiusY);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawAscii(
  context: CanvasRenderingContext2D,
  image: ImageData,
  width: number,
  height: number,
  settings: EffectSettings,
  low: number,
  high: number,
): void {
  const strength = settings.strength / 100;
  const darkInk = settings.inkTone === "shadows";
  const fontSize = Math.round(range(settings.size, 7, width < 720 ? 22 : 24));
  context.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const widestGlyph = Math.max(
    ...Array.from(ASCII_CHARS).map((character) => context.measureText(character).width),
  );
  const glyphHeight =
    context.measureText("@").actualBoundingBoxAscent +
    context.measureText("@").actualBoundingBoxDescent;
  const stepX = Math.max(range(settings.spacing, 8, 24), widestGlyph * 1.08);
  const stepY = Math.max(range(settings.spacing, 9, 26), glyphHeight * 1.12, fontSize * 1.04);

  for (let y = stepY / 2; y < height; y += stepY) {
    const sampleY = Math.min(image.height - 1, Math.floor((y / height) * image.height));
    for (let x = stepX / 2; x < width; x += stepX) {
      const sampleX = Math.min(image.width - 1, Math.floor((x / width) * image.width));
      const [red, green, blue] = readPixel(image, sampleX, sampleY);
      const lightness = luminance(red, green, blue);
      const tone = toneAt(lightness, low, high, darkInk, strength);
      if (tone <= 0.02) continue;
      const character = ASCII_CHARS[Math.round(tone * 16)];
      if (!character || character === " ") continue;

      const [hue, saturation, value] = colorToHsv(red, green, blue);
      const liftedValue = value + (1 - value) * (0.24 + 0.18 * strength + 0.24 * tone);
      const liftedSaturation = clamp(saturation * (1 + 0.16 + 0.2 * strength));
      const [inkRed, inkGreen, inkBlue] = hsvToColor(hue, liftedSaturation, liftedValue);
      const opacity = clamp((0.12 + 0.7 * tone) * (0.72 + 0.28 * strength), 0.06, 0.94);
      context.fillStyle = `rgba(${inkRed}, ${inkGreen}, ${inkBlue}, ${opacity})`;
      context.fillText(character, x, y);
    }
  }
}

function drawDither(
  context: CanvasRenderingContext2D,
  scratch: HTMLCanvasElement,
  image: ImageData,
  width: number,
  height: number,
  settings: EffectSettings,
): void {
  const smallWidth = Math.max(
    1,
    Math.ceil(width / Math.max(2, Math.round(range(settings.size, 2, width < 720 ? 7 : 9)))),
  );
  const pixelSize = Math.max(2, Math.round(range(settings.size, 2, width < 720 ? 7 : 9)));
  const smallHeight = Math.max(1, Math.ceil(height / pixelSize));
  scratch.width = smallWidth;
  scratch.height = smallHeight;
  const smallContext = scratch.getContext("2d", { willReadFrequently: false });
  if (!smallContext) return;

  const output = smallContext.createImageData(smallWidth, smallHeight);
  const strength = settings.strength / 100;
  const levels = Math.max(2, Math.round(range(settings.strength, 8, 2)));
  const blend = range(settings.strength, 0.32, 1);
  const patternScale = Math.max(1, Math.round(range(settings.spacing, 1, 4)));
  const saturationFactor = 1 + 0.06 + 0.18 * strength;

  for (let blockY = 0; blockY < smallHeight; blockY += 1) {
    for (let blockX = 0; blockX < smallWidth; blockX += 1) {
      const centerX = Math.min(width, (blockX + 0.5) * pixelSize);
      const centerY = Math.min(height, (blockY + 0.5) * pixelSize);
      const sourceX = Math.min(image.width - 1, Math.floor((centerX / width) * image.width));
      const sourceY = Math.min(image.height - 1, Math.floor((centerY / height) * image.height));
      const [red, green, blue] = readPixel(image, sourceX, sourceY);
      const lightness = luminance(red, green, blue) * 255;
      const saturated = [red, green, blue].map((channel) =>
        clamp(lightness + (channel - lightness) * saturationFactor, 0, 255),
      );
      const threshold =
        (BAYER_4X4[Math.floor(blockY / patternScale) % 4][Math.floor(blockX / patternScale) % 4] +
          0.5) /
        16;
      const targetOffset = (blockY * smallWidth + blockX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const scaled = (saturated[channel] / 255) * (levels - 1);
        const floorValue = Math.floor(scaled);
        const quantized = floorValue + (scaled - floorValue > threshold ? 1 : 0);
        const target = (quantized / (levels - 1)) * 255;
        output.data[targetOffset + channel] = Math.round(
          saturated[channel] + (target - saturated[channel]) * blend,
        );
      }
      output.data[targetOffset + 3] = 255;
    }
  }
  smallContext.putImageData(output, 0, 0);
  context.imageSmoothingEnabled = false;
  context.drawImage(scratch, 0, 0, width, height);
}

export function EffectLayer({
  sourceRef,
  settings,
  lightSurfacePaletteReveal,
}: EffectLayerProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(settings);
  const renderRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    settingsRef.current = settings;
    const timer = window.setTimeout(() => renderRef.current(), 72);
    return () => window.clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const source = sourceRef.current;
    const wrapper = canvas?.parentElement;
    const context = canvas?.getContext("2d", { willReadFrequently: false });
    if (!canvas || !source || !wrapper || !context) return;

    const sampleCanvas = document.createElement("canvas");
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    const ditherCanvas = document.createElement("canvas");
    const revealCanvas = document.createElement("canvas");
    const paletteRevealCanvas = document.createElement("canvas");
    const transitionCanvas = document.createElement("canvas");
    const transitionContext = transitionCanvas.getContext("2d");
    if (!sampleContext || !transitionContext) return;

    let disposed = false;
    let visible = true;
    let rafId: number | undefined;
    let frameCallbackId: number | undefined;
    let transitionRafId: number | undefined;
    let transitionStarted = 0;
    let previousSignature = "";

    const stopVideoFrames = (): void => {
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      rafId = undefined;
      if (frameCallbackId !== undefined && "cancelVideoFrameCallback" in source) {
        (source as HTMLVideoElement).cancelVideoFrameCallback(frameCallbackId);
      }
      frameCallbackId = undefined;
    };

    const draw = (): void => {
      if (disposed || !isReady(source)) return;
      const bounds = wrapper.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const deviceScale = Math.min(window.devicePixelRatio || 1, 1.6, 2048 / width, 2048 / height);
      const pixelWidth = Math.max(1, Math.round(width * deviceScale));
      const pixelHeight = Math.max(1, Math.round(height * deviceScale));
      const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
      if (resized) {
        transitionStarted = 0;
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      const activeSettings = settingsRef.current;
      const signature = `${activeSettings.filter}:${activeSettings.palette}`;
      if (
        !resized &&
        previousSignature &&
        previousSignature !== signature &&
        canvas.width &&
        canvas.height
      ) {
        transitionCanvas.width = canvas.width;
        transitionCanvas.height = canvas.height;
        transitionContext.clearRect(0, 0, canvas.width, canvas.height);
        transitionContext.drawImage(canvas, 0, 0);
        transitionStarted = performance.now();
      }
      previousSignature = signature;

      const sampleScale = Math.min(480 / width, 480 / height);
      sampleCanvas.width = Math.max(1, Math.round(width * sampleScale));
      sampleCanvas.height = Math.max(1, Math.round(height * sampleScale));
      sampleContext.fillStyle = "#ffffff";
      sampleContext.fillRect(0, 0, sampleCanvas.width, sampleCanvas.height);
      sampleContext.imageSmoothingEnabled = true;
      try {
        coverSource(sampleContext, source, sampleCanvas.width, sampleCanvas.height);
      } catch {
        return;
      }
      const image = recolorSamples(
        sampleContext,
        sampleCanvas.width,
        sampleCanvas.height,
        createPaletteLookup(activeSettings.palette),
      );
      const [low, high] = percentileRange(image);

      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, width, height);
      if (activeSettings.filter === "ascii") {
        context.imageSmoothingEnabled = true;
        if (document.documentElement.dataset.surface === "light") {
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          if (lightSurfacePaletteReveal) {
            drawLightSurfacePaletteReveal(
              context,
              revealCanvas,
              paletteRevealCanvas,
              sampleCanvas,
              width,
              height,
              deviceScale,
              lightSurfacePaletteReveal,
            );
          }
        } else {
          context.drawImage(sampleCanvas, 0, 0, width, height);
        }
        applyMask(context, width, height, activeSettings.mask);
        drawAscii(context, image, width, height, activeSettings, low, high);
      } else {
        drawDither(context, ditherCanvas, image, width, height, activeSettings);
        applyMask(context, width, height, activeSettings.mask);
        if (document.documentElement.dataset.surface === "light") {
          applyLightSurfaceWash(context, width, height);
        }
      }

      if (transitionStarted > 0) {
        const progress = clamp((performance.now() - transitionStarted) / 150);
        if (progress < 1) {
          context.globalAlpha = 1 - progress;
          context.drawImage(transitionCanvas, 0, 0, width, height);
          context.globalAlpha = 1;
          if (transitionRafId === undefined && source.tagName.toLowerCase() !== "video") {
            transitionRafId = requestAnimationFrame(() => {
              transitionRafId = undefined;
              draw();
            });
          }
        } else {
          transitionStarted = 0;
        }
      }
    };
    renderRef.current = draw;

    const video =
      source.tagName.toLowerCase() === "video" ? (source as HTMLVideoElement) : undefined;
    const scheduleVideoFrames = (): void => {
      if (!video || disposed || !visible || video.paused || video.ended) return;
      if (typeof video.requestVideoFrameCallback === "function") {
        frameCallbackId = video.requestVideoFrameCallback(() => {
          frameCallbackId = undefined;
          draw();
          scheduleVideoFrames();
        });
      } else {
        rafId = requestAnimationFrame(() => {
          rafId = undefined;
          draw();
          scheduleVideoFrames();
        });
      }
    };
    const onPlay = (): void => scheduleVideoFrames();
    const onPause = (): void => stopVideoFrames();
    const onLoaded = (): void => {
      draw();
      scheduleVideoFrames();
    };

    if (video) {
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("loadeddata", onLoaded);
      video.addEventListener("seeked", draw);
      if (!video.paused) scheduleVideoFrames();
    } else {
      source.addEventListener("load", onLoaded);
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(draw);
    resizeObserver?.observe(wrapper);
    const visibilityObserver =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            if (visible) {
              draw();
              scheduleVideoFrames();
            } else {
              stopVideoFrames();
            }
          });
    visibilityObserver?.observe(wrapper);
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-surface"],
    });
    draw();

    return () => {
      disposed = true;
      stopVideoFrames();
      if (transitionRafId !== undefined) cancelAnimationFrame(transitionRafId);
      resizeObserver?.disconnect();
      visibilityObserver?.disconnect();
      themeObserver.disconnect();
      video?.removeEventListener("play", onPlay);
      video?.removeEventListener("pause", onPause);
      video?.removeEventListener("loadeddata", onLoaded);
      video?.removeEventListener("seeked", draw);
      if (!video) source.removeEventListener("load", onLoaded);
      renderRef.current = () => undefined;
    };
  }, [sourceRef]);

  return <canvas aria-hidden="true" className="effect-layer" ref={canvasRef} />;
}
