import { useEffect } from "react";
import type { RefObject } from "react";

const STACK_EDGE = 28;
const STACK_LAYERS = 2;

/**
 * Stacked-scroll fold effect for the sidebar task list.
 *
 * Cards in the middle stay crisp. Outside that band, layout distances
 * compress into a small fan at either edge: successive cards overlap,
 * shrink and dim behind the nearer cards. Only the first few layers show.
 * The original layout stays intact so every task remains scrollable.
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

      const listStyle = getComputedStyle(list);
      const gap = Number.parseFloat(listStyle.rowGap) || 6;
      const pitch = items[0].offsetHeight + gap;
      if (pitch <= 0) return;

      const listHeight = list.clientHeight;
      const scrollTop = list.scrollTop;
      const paddingTop = Number.parseFloat(listStyle.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(listStyle.paddingBottom) || 0;
      const contentHeight = listHeight - paddingTop - paddingBottom;
      const reserve = Math.min(
        STACK_EDGE,
        Math.max(0, (contentHeight - items[0].offsetHeight) / 3),
      );
      // Release the edge at the start/end so the first/last task opens fully.
      const topEdge = paddingTop + Math.min(reserve, scrollTop);
      const bottomEdge =
        listHeight -
        paddingBottom -
        Math.min(reserve, Math.max(0, list.scrollHeight - listHeight - scrollTop));

      // Read all layout before writing transforms. The positioned list is
      // each card's offsetParent; transforms never enter these measurements.
      const positions = items.map((item) => ({
        item,
        top: item.offsetTop,
        height: item.offsetHeight,
      }));

      for (const { item, top, height } of positions) {
        const y = top - scrollTop;
        const lowerAnchor = Math.max(topEdge, bottomEdge - height);
        const distance = y < topEdge ? y - topEdge : Math.max(0, y - lowerAnchor);
        const depth = Math.abs(distance) / pitch;
        const layer = Math.min(STACK_LAYERS, depth);
        const direction = Math.sign(distance);
        // Keep just two slim card edges, then fade the remaining layers away.
        const peek = reserve * 0.9 * (1 - Math.exp(-depth / 1.6));
        const tuck = direction * peek - distance;

        const opacity = (1 - layer * 0.22) * Math.max(0, 1 - Math.max(0, depth - STACK_LAYERS));
        const scale = 1 - layer * 0.045;

        item.style.opacity = opacity.toFixed(3);
        item.style.transform = `translateY(${tuck.toFixed(1)}px) scale(${scale.toFixed(3)})`;
        item.style.transformOrigin = distance < 0 ? "center top" : "center bottom";
        item.style.zIndex = String(100 - Math.ceil(Math.min(depth, STACK_LAYERS + 1) * 20));
        item.style.pointerEvents = depth >= STACK_LAYERS + 1 ? "none" : "";
        item.style.setProperty("--stack-content-opacity", Math.max(0, 1 - depth * 2).toFixed(3));
      }
    };

    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const revealFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
      const item = target.closest<HTMLElement>(".task-list-item");
      if (!item) return;
      const top = item.offsetTop - list.scrollTop;
      if (top < STACK_EDGE || top + item.offsetHeight > list.clientHeight - STACK_EDGE) {
        list.scrollTop = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
        schedule();
      }
    };

    apply();
    list.addEventListener("scroll", schedule, { passive: true });
    list.addEventListener("focusin", revealFocus);
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    for (const item of list.querySelectorAll(".task-list-item")) observer.observe(item);

    return () => {
      list.removeEventListener("scroll", schedule);
      list.removeEventListener("focusin", revealFocus);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const item of list.querySelectorAll<HTMLElement>(".task-list-item")) {
        item.style.opacity = "";
        item.style.transform = "";
        item.style.zIndex = "";
        item.style.transformOrigin = "";
        item.style.pointerEvents = "";
        item.style.removeProperty("--stack-content-opacity");
      }
    };
  }, [listRef, enabled, revision]);
}
