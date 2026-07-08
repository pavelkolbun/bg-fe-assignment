import { useEffect, useRef, useState } from 'react';

export interface VirtualRange {
  start: number;
  end: number; // exclusive
  totalHeight: number;
  offsetY: number;
}

const OVERSCAN = 8;

/**
 * Minimal fixed-row-height windowing: no dependency, ~40 lines. We don't need
 * variable heights, sticky groups, or horizontal virtualization here, so a
 * library would buy us nothing but bundle size and API surface to learn.
 */
export function useVirtualRange(
  containerRef: React.RefObject<HTMLDivElement | null>,
  itemCount: number,
  rowHeight: number,
): VirtualRange {
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0, totalHeight: 0, offsetY: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const compute = () => {
      const scrollTop = el.scrollTop;
      const viewportHeight = el.clientHeight;
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
      const visibleCount = Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2;
      const end = Math.min(itemCount, start + visibleCount);
      setRange({
        start,
        end,
        totalHeight: itemCount * rowHeight,
        offsetY: start * rowHeight,
      });
    };

    const onScroll = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        compute();
      });
    };

    compute();
    el.addEventListener('scroll', onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(compute);
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef, itemCount, rowHeight]);

  return range;
}
