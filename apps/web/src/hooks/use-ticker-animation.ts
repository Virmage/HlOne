"use client";

import { useRef, useCallback, useEffect } from "react";

/**
 * Pixel-based infinite ticker using requestAnimationFrame.
 * Measures actual content width for seamless looping.
 * Content must be duplicated (rendered twice) in the DOM.
 */
export function useTickerAnimation(
  durationSeconds: number = 60,
  reverse: boolean = false
) {
  const offsetRef = useRef(0);       // current pixel offset
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const pausedRef = useRef(false);
  const elRef = useRef<HTMLDivElement | null>(null);
  const contentWidthRef = useRef(0);  // width of one copy of content

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    // The track has two identical children — measure the first one
    const firstChild = el.children[0] as HTMLElement | undefined;
    if (firstChild) {
      contentWidthRef.current = firstChild.scrollWidth;
    }
  }, []);

  const trackRef = useCallback((el: HTMLDivElement | null) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }

    elRef.current = el;
    if (!el) return;

    lastTimeRef.current = 0;

    // Measure after a frame so content has rendered
    requestAnimationFrame(() => {
      measure();

      const step = (timestamp: number) => {
        if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;

        if (!pausedRef.current && contentWidthRef.current > 0) {
          const delta = timestamp - lastTimeRef.current;
          // pixels per ms = contentWidth / durationMs
          const speed = contentWidthRef.current / (durationSeconds * 1000);
          const movement = delta * speed;

          if (reverse) {
            offsetRef.current -= movement;
            if (offsetRef.current <= -contentWidthRef.current) {
              offsetRef.current += contentWidthRef.current;
            }
          } else {
            offsetRef.current -= movement;
            // When we've scrolled one full content width, wrap back
            if (offsetRef.current <= -contentWidthRef.current) {
              offsetRef.current += contentWidthRef.current;
            }
          }

          el.style.transform = `translate3d(${offsetRef.current}px, 0, 0)`;
        }

        lastTimeRef.current = timestamp;
        rafRef.current = requestAnimationFrame(step);
      };

      rafRef.current = requestAnimationFrame(step);
    });
  }, [durationSeconds, reverse, measure]);

  // Re-measure when window resizes (content might reflow)
  useEffect(() => {
    const handleResize = () => measure();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [measure]);

  const onMouseEnter = useCallback(() => {
    pausedRef.current = true;
  }, []);

  const onMouseLeave = useCallback(() => {
    pausedRef.current = false;
    lastTimeRef.current = 0; // skip the delta gap while paused
  }, []);

  return { trackRef, onMouseEnter, onMouseLeave };
}
