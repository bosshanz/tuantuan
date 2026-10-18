import type { UIEvent, WheelEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { reducedMotion } from "./motion";

const atBottom = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
export type ReadingAnchor = { id: string; offset: number; top: number };
const readingTargetTop = (element: HTMLElement, anchor: ReadingAnchor) => {
  const message = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
  if (!message) return anchor.top;
  const box = message.getBoundingClientRect();
  // A display change can shorten the anchor message; retain some of it rather than skipping past it.
  const offset = box.height + anchor.offset <= 0 ? Math.min(0, 32 - box.height) : anchor.offset;
  return Math.max(
    0,
    Math.min(
      element.scrollHeight - element.clientHeight,
      element.scrollTop + box.top - element.getBoundingClientRect().top - offset,
    ),
  );
};
const syncEdges = (element: HTMLElement) => {
  const wrap = element.parentElement;
  wrap?.toggleAttribute("data-scrolled", element.scrollTop > 4);
  wrap?.toggleAttribute("data-more-below", element.scrollHeight - element.scrollTop - element.clientHeight > 4);
};

/** Follow intent survives content/layout changes until the reader deliberately leaves or returns to the bottom. */
export function useChatScroll() {
  const listRef = useRef<HTMLElement>(null);
  const followingRef = useRef(true);
  const previousTop = useRef(0);
  const viewportHeight = useRef(0);
  const readingTop = useRef<number | null>(null);
  const readingAnchor = useRef<ReadingAnchor | null>(null);
  const restoring = useRef<{ anchor: ReadingAnchor; top: number } | null>(null);
  const latestScrollFrame = useRef<number | null>(null);
  const [following, setFollowing] = useState(true);
  const cancelLatestScroll = useCallback(() => {
    if (latestScrollFrame.current !== null) cancelAnimationFrame(latestScrollFrame.current);
    latestScrollFrame.current = null;
  }, []);
  const setFollow = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);
  const finishRestoring = useCallback(
    (element: HTMLElement) => {
      restoring.current = null;
      const bottom = atBottom(element);
      readingTop.current = bottom ? null : element.scrollTop;
      previousTop.current = element.scrollTop;
      setFollow(bottom);
      syncEdges(element);
    },
    [setFollow],
  );
  const sync = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    const resized = viewportHeight.current !== element.clientHeight;
    viewportHeight.current = element.clientHeight;
    if (restoring.current) {
      const top = readingTargetTop(element, restoring.current.anchor);
      // History can arrive during the return motion. Rebase the same message anchor after prepending.
      if (Math.abs(top - restoring.current.top) > 0.5) {
        restoring.current.top = top;
        element.scrollTo({ top, behavior: reducedMotion() ? "instant" : "smooth" });
      }
      if (Math.abs(element.scrollTop - top) <= 1) finishRestoring(element);
      syncEdges(element);
      return;
    }
    if (
      !resized &&
      latestScrollFrame.current === null &&
      followingRef.current &&
      element.scrollTop < previousTop.current - 0.5 &&
      !atBottom(element)
    ) {
      readingTop.current = element.scrollTop;
      setFollow(false);
    }
    if (followingRef.current) {
      // Even a no-op scrollTo cancels a browser's pending smooth history jump.
      if (!atBottom(element)) element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      previousTop.current = element.scrollTop;
    } else if (resized && readingTop.current !== null) {
      const top = element.scrollTop;
      const clamped = top < readingTop.current && atBottom(element);
      // Focus can scroll synchronously before its scroll event. Respect that newer position;
      // only a viewport expansion that actually clamps the old position should keep the old top.
      if (Math.abs(top - previousTop.current) > 0.5 && !clamped) readingTop.current = top;
      // A larger viewport can fit the entire transcript and clamp scrollTop to zero. Keep the
      // reader's intended position for when a terminal/panel makes the viewport smaller again.
      element.scrollTop = readingTop.current;
      previousTop.current = element.scrollTop;
    }
    syncEdges(element);
  }, [setFollow, finishRestoring]);
  const followLatest = useCallback(() => {
    cancelLatestScroll();
    restoring.current = null;
    readingAnchor.current = null;
    readingTop.current = null;
    const element = listRef.current;
    if (element) {
      // An interrupted native smooth scroll can deliver one last compositor frame after this
      // instant jump. Keep the explicit Latest intent through scrollend, or two paints for a no-op.
      latestScrollFrame.current = requestAnimationFrame(() => {
        latestScrollFrame.current = requestAnimationFrame(() => {
          latestScrollFrame.current = null;
        });
      });
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
      previousTop.current = element.scrollTop;
    }
    setFollow(true);
    sync();
  }, [cancelLatestScroll, setFollow, sync]);
  const pause = useCallback(() => {
    cancelLatestScroll();
    restoring.current = null;
    const element = listRef.current;
    if (!element || element.scrollHeight <= element.clientHeight) return;
    setFollow(false);
    // A wheel/touch gesture must also cancel a pending smooth jump to the tail.
    element.scrollTo({ top: element.scrollTop, behavior: "instant" });
    previousTop.current = element.scrollTop;
    readingTop.current = element.scrollTop;
  }, [cancelLatestScroll, setFollow]);

  const captureReadingPosition = useCallback((onlyWhenPaused = false): ReadingAnchor | null => {
    if (onlyWhenPaused && followingRef.current) return null;
    const element = listRef.current;
    if (!element) return null;
    const top = element.getBoundingClientRect().top;
    const firstVisible = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (message) => message.getBoundingClientRect().bottom > top,
    );
    if (!firstVisible) return null;
    return {
      id: firstVisible.dataset.messageId as string,
      offset: firstVisible.getBoundingClientRect().top - top,
      top: element.scrollTop,
    };
  }, []);

  // Capture immediately before prepending, so scrolling while the request was pending is respected.
  const preserveReadingPosition = useCallback(
    (snapshot?: ReadingAnchor | null) => {
      // A rapid display reversal can reuse the original anchor after the shorter view clamps scrollTop.
      if (snapshot) {
        restoring.current = null;
        readingAnchor.current = snapshot;
        return snapshot;
      }
      if (followingRef.current) return null;
      readingAnchor.current = restoring.current?.anchor ?? captureReadingPosition();
      return readingAnchor.current;
    },
    [captureReadingPosition],
  );

  const restoreReadingPosition = useCallback(
    (anchor: ReadingAnchor, instant = false) => {
      const element = listRef.current;
      if (!element?.querySelector(`[data-message-id="${CSS.escape(anchor.id)}"]`)) return false;
      cancelLatestScroll();
      readingAnchor.current = null;
      setFollow(false);
      const top = readingTargetTop(element, anchor);
      restoring.current = { anchor, top };
      element.scrollTo({ top, behavior: instant || reducedMotion() ? "instant" : "smooth" });
      previousTop.current = element.scrollTop;
      readingTop.current = element.scrollTop;
      if (Math.abs(element.scrollTop - top) <= 1) finishRestoring(element);
      syncEdges(element);
      return true;
    },
    [cancelLatestScroll, setFollow, finishRestoring],
  );

  useLayoutEffect(() => {
    const element = listRef.current;
    const anchor = readingAnchor.current;
    if (!element || !anchor) return;
    readingAnchor.current = null;
    if (restoring.current?.anchor === anchor) {
      sync();
      return;
    }
    element.scrollTop = readingTargetTop(element, anchor);
    previousTop.current = element.scrollTop;
    readingTop.current = element.scrollTop;
    syncEdges(element);
  });

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const onScrollEnd = () => {
      if (restoring.current && Math.abs(element.scrollTop - restoring.current.top) <= 1) finishRestoring(element);
      if (atBottom(element)) cancelLatestScroll();
    };
    const cancelRestoring = () => {
      cancelLatestScroll();
      restoring.current = null;
    };
    const onReadingKey = (event: KeyboardEvent) => {
      if (
        event.target === element &&
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      )
        cancelRestoring();
    };
    element.addEventListener("scrollend", onScrollEnd);
    element.addEventListener("pointerdown", cancelRestoring);
    element.addEventListener("keydown", onReadingKey);
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
      cancelLatestScroll();
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener("scrollend", onScrollEnd);
      element.removeEventListener("pointerdown", cancelRestoring);
      element.removeEventListener("keydown", onReadingKey);
    };
  }, [cancelLatestScroll, sync, finishRestoring]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const element = event.currentTarget;
      if (latestScrollFrame.current !== null && followingRef.current) {
        sync();
        return;
      }
      if (element.clientHeight !== viewportHeight.current) {
        sync();
        return;
      }
      const top = element.scrollTop;
      const movedUp = top < previousTop.current - 0.5;
      const movedDown = top > previousTop.current + 0.5;
      // This also handles scrollbar drags and in-page jumps without cancelling their smooth motion.
      if (followingRef.current && movedUp && !atBottom(element)) setFollow(false);
      else if (!restoring.current && !followingRef.current && movedDown && atBottom(element)) {
        readingTop.current = null;
        setFollow(true);
      }
      if (!followingRef.current && (movedUp || movedDown)) readingTop.current = top;
      previousTop.current = top;
      syncEdges(element);
    },
    [setFollow, sync],
  );
  const onWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      cancelLatestScroll();
      restoring.current = null;
      if (event.deltaY < 0) pause();
      else if (event.deltaY > 0 && atBottom(event.currentTarget)) followLatest();
    },
    [cancelLatestScroll, pause, followLatest],
  );
  return {
    listRef,
    following,
    followLatest,
    captureReadingPosition,
    restoreReadingPosition,
    preserveReadingPosition,
    onScroll,
    onWheel,
    onTouchMove: pause,
    pause,
  };
}
