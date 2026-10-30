// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStackFold } from "./use-stack-fold";

const HEIGHT = 560;
const CARD_HEIGHT = 100;
const PITCH = 106;
const COUNT = 13;
const MAX_SCROLL = (COUNT - 1) * PITCH + CARD_HEIGHT - HEIGHT;

function Harness({ enabled = true, scrollTop = 0, padding = 0 }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current!;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: HEIGHT },
      scrollHeight: { configurable: true, value: MAX_SCROLL + HEIGHT + padding * 2 },
    });
    list.scrollTop = scrollTop;
    Array.from(list.children).forEach((item, index) => {
      Object.defineProperties(item, {
        offsetTop: { configurable: true, value: padding + index * PITCH },
        offsetHeight: { configurable: true, value: CARD_HEIGHT },
      });
    });
  }, [scrollTop, padding]);
  useStackFold(ref, enabled, COUNT);
  return (
    <div ref={ref} style={{ rowGap: "6px", padding }}>
      {Array.from({ length: COUNT }, (_, index) => (
        <button key={index} className="task-list-item">
          Task {index}
        </button>
      ))}
    </div>
  );
}

// Recover painted bounds from the transform and its edge origin. Layout in
// happy-dom is supplied above; assertions concern overlap and reachability.
function paintedCard(item: HTMLElement, scrollTop: number) {
  const [, translate, scaleValue] = item.style.transform.match(
    /translateY\(([-\d.]+)px\) scale\(([\d.]+)\)/,
  )!;
  const scale = Number(scaleValue);
  const top =
    item.offsetTop -
    scrollTop +
    Number(translate) +
    (item.style.transformOrigin === "center bottom" ? CARD_HEIGHT * (1 - scale) : 0);
  return { top, bottom: top + CARD_HEIGHT * scale, scale, opacity: Number(item.style.opacity) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("stacked task cards", () => {
  it("overlaps cards inside both viewport edges, with nearer cards on top", () => {
    const scrollTop = 500;
    const { getAllByRole } = render(<Harness scrollTop={scrollTop} />);
    const items = getAllByRole("button");
    for (const [nearIndex, farIndex] of [
      [4, 3],
      [10, 11],
    ]) {
      const near = paintedCard(items[nearIndex], scrollTop);
      const far = paintedCard(items[farIndex], scrollTop);
      expect(Math.min(near.bottom, far.bottom)).toBeGreaterThan(Math.max(near.top, far.top));
      expect(far.top).toBeGreaterThanOrEqual(0);
      expect(far.bottom).toBeLessThanOrEqual(HEIGHT);
      expect(far.scale).toBeLessThan(near.scale);
      expect(far.opacity).toBeLessThan(near.opacity);
      expect(Number(items[farIndex].style.zIndex)).toBeLessThan(
        Number(items[nearIndex].style.zIndex),
      );
    }
    const middle = paintedCard(items[7], scrollTop);
    expect(middle.scale).toBe(1);
    expect(middle.opacity).toBe(1);
  });

  it("opens the first and last cards fully at the scroll limits and resets normal mode", () => {
    const { getAllByRole, rerender } = render(<Harness />);
    expect(paintedCard(getAllByRole("button")[0], 0)).toEqual({
      top: 0,
      bottom: 100,
      scale: 1,
      opacity: 1,
    });
    rerender(<Harness enabled={false} scrollTop={MAX_SCROLL} />);
    for (const item of getAllByRole("button")) {
      expect(item.style.cssText).toBe("");
    }
    rerender(<Harness scrollTop={MAX_SCROLL} />);
    expect(paintedCard(getAllByRole("button")[COUNT - 1], MAX_SCROLL)).toEqual({
      top: HEIGHT - CARD_HEIGHT,
      bottom: HEIGHT,
      scale: 1,
      opacity: 1,
    });
  });

  it("updates the stack after scrolling while preserving layout positions", () => {
    let nextFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { getAllByRole } = render(<Harness />);
    const items = getAllByRole("button");
    const list = items[0].parentElement!;
    expect(Number(items[7].style.opacity)).toBeLessThan(1);
    list.scrollTop = 500;
    fireEvent.scroll(list);
    nextFrame!(0);
    expect(Number(items[7].style.opacity)).toBe(1);
    expect(items[7].offsetTop).toBe(7 * PITCH);
    expect(list.scrollHeight).toBe(MAX_SCROLL + HEIGHT);
  });

  it("keeps first and last cards fully open inside the shadow padding", () => {
    const padding = 8;
    const { getAllByRole, rerender } = render(<Harness padding={padding} />);
    expect(paintedCard(getAllByRole("button")[0], 0)).toEqual({
      top: padding,
      bottom: padding + CARD_HEIGHT,
      scale: 1,
      opacity: 1,
    });
    const scrollTop = MAX_SCROLL + padding * 2;
    rerender(<Harness enabled={false} padding={padding} scrollTop={scrollTop} />);
    rerender(<Harness padding={padding} scrollTop={scrollTop} />);
    expect(paintedCard(getAllByRole("button")[COUNT - 1], scrollTop)).toEqual({
      top: HEIGHT - padding - CARD_HEIGHT,
      bottom: HEIGHT - padding,
      scale: 1,
      opacity: 1,
    });
  });

  it("keeps visible folded layers out of the shadow padding", () => {
    const padding = 8;
    const scrollTop = 288;
    const { getAllByRole } = render(<Harness padding={padding} scrollTop={scrollTop} />);
    for (const item of getAllByRole("button")) {
      const card = paintedCard(item, scrollTop);
      if (card.opacity === 0) continue;
      expect(card.top).toBeGreaterThanOrEqual(padding);
      expect(card.bottom).toBeLessThanOrEqual(HEIGHT - padding);
    }
  });
});
