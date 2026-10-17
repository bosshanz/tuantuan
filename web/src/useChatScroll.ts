import type { UIEvent, WheelEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const atBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
const syncEdges = (element: HTMLElement) => {
  const wrap = element.parentElement;
  wrap?.toggleAttribute("data-scrolled", element.scrollTop > 4);
  wrap?.toggleAttribute("data-more-below", element.scrollHeight - element.scrollTop - element.clientHeight > 4);
};

/** Follow intent survives content/layout changes until the reader deliberately leaves or returns to the bottom. */
export function useChatScroll() {
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const previousTop = useRef(0);
  const readingAnchor = useRef<{ id: string; offset: number; top: number } | null>(null);
  const [following, setFollowing] = useState(true);
  const setFollow = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);
  const sync = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    if (followingRef.current && element.scrollTop < previousTop.current - 0.5 && !atBottom(element)) setFollow(false);
    if (followingRef.current) {
      // Even a no-op scrollTo cancels a browser's pending smooth history jump.
      if (!atBottom(element)) element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      previousTop.current = element.scrollTop;
    }
    syncEdges(element);
  }, [setFollow]);
  const followLatest = useCallback(() => {
    setFollow(true);
    sync();
  }, [setFollow, sync]);
  const pause = useCallback(() => {
    const element = listRef.current;
    if (!element || element.scrollHeight <= element.clientHeight) return;
    setFollow(false);
    // A wheel/touch gesture must also cancel a pending smooth jump to the tail.
    element.scrollTo({ top: element.scrollTop, behavior: "instant" });
    previousTop.current = element.scrollTop;
  }, [setFollow]);

  // Capture immediately before prepending, so scrolling while the request was pending is respected.
  const preserveReadingPosition = useCallback(() => {
    const element = listRef.current;
    if (!element || followingRef.current) return;
    const top = element.getBoundingClientRect().top;
    const firstVisible = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (message) => message.getBoundingClientRect().bottom > top,
    );
    if (!firstVisible) return;
    readingAnchor.current = {
      id: firstVisible.dataset.messageId as string,
      offset: firstVisible.getBoundingClientRect().top - top,
      top: element.scrollTop,
    };
  }, []);

  useLayoutEffect(() => {
    const element = listRef.current;
    const anchor = readingAnchor.current;
    if (!element || !anchor) return;
    readingAnchor.current = null;
    const message = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
    element.scrollTop = message
      ? element.scrollTop + message.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
      : anchor.top;
    previousTop.current = element.scrollTop;
    syncEdges(element);
  });

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(sync);
    resize.observe(element);
    const observeContent = () => {
      for (const child of observed) {
        if (child.parentElement === element) continue;
        resize.unobserve(child);
        observed.delete(child);
      }
      for (const child of element.children) {
        if (observed.has(child)) continue;
        observed.add(child);
        resize.observe(child);
      }
    };
    const mutation = new MutationObserver(() => {
      observeContent();
      sync();
    });
    mutation.observe(element, { childList: true, subtree: true, characterData: true });
    observeContent();
    sync();
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [sync]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const top = element.scrollTop;
      const movedUp = top < previousTop.current - 0.5;
      const movedDown = top > previousTop.current + 0.5;
      // This also handles scrollbar drags and in-page jumps without cancelling their smooth motion.
      if (followingRef.current && movedUp && !atBottom(element)) setFollow(false);
      else if (!followingRef.current && movedDown && atBottom(element)) setFollow(true);
      previousTop.current = top;
      syncEdges(element);
    },
    [setFollow],
  );
  const onWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) pause();
      else if (event.deltaY > 0 && atBottom(event.currentTarget)) followLatest();
    },
    [pause, followLatest],
  );
  return { listRef, following, followLatest, preserveReadingPosition, onScroll, onWheel, onTouchMove: pause, pause };
}
