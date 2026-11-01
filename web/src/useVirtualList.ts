import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export function useVirtualList(options: { count: number; rowHeight: number; overscan?: number }) {
  const { count, rowHeight, overscan = 10 } = options;
  const elementRef = useRef<HTMLElement | null>(null);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  const containerRef = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
    setNode(element);
    if (element) {
      setScrollTop(element.scrollTop);
      setHeight(element.clientHeight);
    }
  }, []);

  useEffect(() => {
    if (!node) return;
    setScrollTop(node.scrollTop);
    setHeight(node.clientHeight);
    const onScroll = () => setScrollTop(node.scrollTop);
    node.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [node]);

  const viewportHeight = height > 0 ? height : 640;
  const totalHeight = count * rowHeight;
  const startIndex = count === 0 ? 0 : Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const endIndex =
    count === 0
      ? 0
      : Math.min(count, Math.max(startIndex + 1, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan));
  const offsetTop = startIndex * rowHeight;

  const scrollToIndex = useCallback(
    (index: number) => {
      const element = elementRef.current;
      if (!element || index < 0 || index >= count) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      const viewTop = element.scrollTop;
      const viewHeight = element.clientHeight || 640;
      let nextTop = viewTop;
      if (top < viewTop) nextTop = top;
      else if (bottom > viewTop + viewHeight) nextTop = Math.max(0, bottom - viewHeight);
      if (nextTop !== viewTop) {
        element.scrollTop = nextTop;
        flushSync(() => setScrollTop(nextTop));
      }
    },
    [count, rowHeight],
  );

  return {
    containerRef,
    elementRef,
    totalHeight,
    startIndex,
    endIndex,
    offsetTop,
    scrollToIndex,
  };
}
