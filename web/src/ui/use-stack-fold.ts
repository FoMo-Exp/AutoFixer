import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Stacked-scroll fold effect for the sidebar task list.
 *
 * Reference: react-pop-cards CardStack — per-distance falloff
 * (scale down, opacity down, offset, z-order). Our motion differs: the
 * list scrolls vertically instead of cycling one card at a time, so the
 * "active" card becomes a focus band:
 *
 *   - the band is centred in the scrollport and sized to the cards that
 *     fit the displayable height (≈5 on desktop, fewer on short windows)
 *   - cards inside the band stay crisp (opacity 1, scale 1)
 *   - cards beyond the band get the CardStack falloff: shrunk, dimmed and
 *     tucked behind toward the nearest edge, reading as a folded stack
 *
 * Geometry is read from layout (offsetTop/offsetHeight), never from
 * transformed rects, so the effect cannot feed back on itself.
 */

export function useStackFold(
  listRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  revision: string | number,
): void {
  useEffect(() => {
    const list = listRef.current;
    if (!list || !enabled) return;

    let frame = 0;

    const apply = (): void => {
      frame = 0;
      const items = Array.from(list.querySelectorAll<HTMLElement>(".task-list-item"));
      if (items.length === 0) return;

      const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 6;
      const pitch = items[0].offsetHeight + gap;
      if (pitch <= 0) return;

      const listHeight = list.clientHeight;
      const scrollTop = list.scrollTop;
      const centerY = listHeight / 2;
      // offsetParent 是 sticky 的 .sidebar，需减去列表自身的偏移才是列表内位置
      const listTop = list.offsetTop;

      // 中心核心张数按当前可展示高度确定（桌面约 5 张）
      const coreCount = Math.max(3, Math.floor(listHeight / pitch + 0.25));
      const bandHalf = (coreCount * pitch - gap) / 2;

      for (const item of items) {
        // offsetTop 是布局位置，不受 transform 反馈影响
        const center = item.offsetTop - listTop + item.offsetHeight / 2 - scrollTop - centerY;
        const beyond = Math.max(0, Math.abs(center) - bandHalf);
        const stack = beyond / pitch;
        const fade = Math.min(1, stack / 0.7);

        // CardStack 公式的纵向变体：越远越小、越淡、越向边缘收拢（堆叠）
        const opacity = 1 - fade * 0.7;
        const scale = 1 - fade * 0.18;
        const tuck = Math.sign(center) * Math.min(64, 4 * stack * stack);

        item.style.opacity = opacity.toFixed(3);
        item.style.transform = `translateY(${tuck.toFixed(1)}px) scale(${scale.toFixed(3)})`;
        item.style.zIndex = String(Math.round(100 - fade * 50));
      }
    };

    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    list.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    for (const item of list.querySelectorAll(".task-list-item")) observer.observe(item);

    return () => {
      list.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const item of list.querySelectorAll<HTMLElement>(".task-list-item")) {
        item.style.opacity = "";
        item.style.transform = "";
        item.style.zIndex = "";
      }
    };
  }, [listRef, enabled, revision]);
}
