import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  TextureLoader,
  Vector2,
  WebGLRenderer,
} from "three";
import blackHoleImage from "../assets/startup-blackhole-realistic.png";

const vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const fragmentShader = `
uniform sampler2D uImage;
uniform float uTime;
uniform float uMotion;
uniform vec2 uCanvasSize;
uniform vec2 uImageSize;
uniform float uContain;
varying vec2 vUv;

// Image-space coordinates use equal lengths on both axes. The bright far side
// climbs over the shadow; the foreground returns from right to left.
vec2 velocity(vec2 p) {
  float radius = max(length(p), 0.001);
  vec2 clockwise = vec2(p.y, -p.x) / radius;
  float bend = exp(-pow(abs(p.x) / 0.235, 4.0));
  float backSide = smoothstep(-0.014, 0.018, p.y);
  vec2 disk = vec2(mix(-1.0, 1.0, backSide), 0.0);
  vec2 tangent = normalize(mix(disk, clockwise, bend) + vec2(0.0001));
  // Small inward drift, strongest close to the horizon. It never moves the
  // black shadow or emits concentric waves into the surrounding empty space.
  float inward = 0.025 * exp(-pow((radius - 0.205) / 0.1, 2.0));
  return tangent - p / radius * inward;
}

vec2 traceFlow(vec2 sourceUv, float phase) {
  float aspect = uImageSize.x / uImageSize.y;
  vec2 p = (sourceUv - vec2(0.5, 0.38)) * vec2(aspect, 1.0);
  float radius = length(p);
  float speed = mix(0.044, 0.07, 1.0 - smoothstep(0.18, 0.65, radius));
  // Backtrace the curved flow instead of translating a flat ring or highlight.
  float stepSize = phase * speed / 12.0;
  for (int i = 0; i < 12; i++) {
    vec2 first = velocity(p);
    vec2 midpoint = p - first * stepSize * 0.5;
    p -= velocity(midpoint) * stepSize;
  }
  return vec2(0.5, 0.38) + p / vec2(aspect, 1.0);
}

vec3 envelopeAt(vec2 coordinate) {
  vec2 delta = vec2(0.006 * uImageSize.y / uImageSize.x, 0.006);
  return (texture2D(uImage, coordinate).rgb * 2.0
    + texture2D(uImage, coordinate + vec2(delta.x, 0.0)).rgb
    + texture2D(uImage, coordinate - vec2(delta.x, 0.0)).rgb
    + texture2D(uImage, coordinate + vec2(0.0, delta.y)).rgb
    + texture2D(uImage, coordinate - vec2(0.0, delta.y)).rgb) / 6.0;
}

float detailAt(vec2 coordinate) {
  vec3 detail = texture2D(uImage, coordinate).rgb;
  vec3 envelope = envelopeAt(coordinate);
  float signal = max(detail.r, max(detail.g, detail.b));
  float baseline = max(envelope.r, max(envelope.g, envelope.b));
  return clamp(signal / max(baseline, 0.002), 0.5, 1.8);
}

void main() {
  float fitScale = mix(
    max(uCanvasSize.x / uImageSize.x, uCanvasSize.y / uImageSize.y),
    min(uCanvasSize.x / uImageSize.x, uCanvasSize.y / uImageSize.y),
    uContain
  );
  vec2 imageExtent = uImageSize * fitScale;
  vec2 offset = (uCanvasSize - imageExtent) * vec2(0.5, mix(0.54, 0.5, uContain));
  vec2 sourceUv = (vec2(vUv.x, 1.0 - vUv.y) * uCanvasSize - offset) / imageExtent;
  sourceUv.y = 1.0 - sourceUv.y;
  if (min(sourceUv.x, sourceUv.y) < 0.0 || max(sourceUv.x, sourceUv.y) > 1.0) discard;

  vec3 original = texture2D(uImage, sourceUv).rgb;
  vec2 p = (sourceUv - vec2(0.5, 0.38)) * vec2(uImageSize.x / uImageSize.y, 1.0);
  float radius = length(p);
  float brightness = max(original.r, max(original.g, original.b));
  float shadow = smoothstep(0.168, 0.186, radius);
  float region = 1.0 - smoothstep(0.7, 0.86, abs(p.x));
  float lightMask = smoothstep(0.025, 0.14, brightness) * shadow * region;

  // Two staggered flow phases blend continuously: the source texture travels
  // along the bent light band without a visible reset at the end of a cycle.
  float phaseA = fract(uTime / 6.0);
  float phaseB = fract(phaseA + 0.5);
  float blend = abs(phaseA * 2.0 - 1.0);
  float first = detailAt(traceFlow(sourceUv, phaseA));
  float second = detailAt(traceFlow(sourceUv, phaseB));
  vec3 flowing = envelopeAt(sourceUv) * mix(first, second, blend);

  // Preserve the luminous envelope; advect its internal strands. This keeps the
  // horizon edge sharp while the plasma texture actually moves across it.
  float horizonEdge = 1.0 - exp(-pow((radius - 0.18) / 0.009, 2.0));
  lightMask *= horizonEdge;
  gl_FragColor = vec4(mix(original, flowing, lightMask * 0.94 * uMotion), 0.95);
}`;

export function mountBlackHoleScene(canvas: HTMLCanvasElement): () => void {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const uniforms = {
    uImage: { value: null as ReturnType<TextureLoader["load"]> | null },
    uTime: { value: 0 },
    uMotion: { value: 1 },
    uCanvasSize: { value: new Vector2(1, 1) },
    uImageSize: { value: new Vector2(1672, 941) },
    uContain: { value: 0 },
  };
  const geometry = new PlaneGeometry(2, 2);
  const material = new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
  });
  scene.add(new Mesh(geometry, material));
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let elapsed = 0;
  let lastTime = 0;
  let loaded = false;
  let disposed = false;

  const render = (): void => {
    if (!loaded || disposed) return;
    uniforms.uTime.value = motion.matches ? 0 : elapsed;
    uniforms.uMotion.value = motion.matches ? 0 : 1;
    renderer.render(scene, camera);
  };
  const animate = (now: number): void => {
    frame = 0;
    if (lastTime) elapsed += Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    render();
    if (!document.hidden && !motion.matches && !disposed) frame = requestAnimationFrame(animate);
  };
  const synchronize = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    render();
    if (loaded && !document.hidden && !motion.matches && !disposed) {
      frame = requestAnimationFrame(animate);
    }
  };
  const resize = (): void => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    uniforms.uCanvasSize.value.set(width, height);
    uniforms.uContain.value = window.matchMedia("(max-width: 680px)").matches ? 1 : 0;
    render();
  };
  const texture = new TextureLoader().load(blackHoleImage, (image) => {
    if (disposed) return;
    uniforms.uImage.value = image;
    uniforms.uImageSize.value.set(image.image.width, image.image.height);
    loaded = true;
    resize();
    canvas.dataset.ready = "true";
    synchronize();
  });
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  motion.addEventListener("change", synchronize);
  document.addEventListener("visibilitychange", synchronize);
  resize();

  return () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    motion.removeEventListener("change", synchronize);
    document.removeEventListener("visibilitychange", synchronize);
    delete canvas.dataset.ready;
    geometry.dispose();
    material.dispose();
    texture.dispose();
    renderer.dispose();
  };
}
