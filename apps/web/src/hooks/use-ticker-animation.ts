"use client";

import { useRef, useCallback, useEffect } from "react";

/**
 * Pixel-based infinite ticker using requestAnimationFrame.
 * Measures actual content width for seamless looping.
 * Content must be duplicated (rendered twice) in the DOM.
 *
 * reverse=false: scrolls left (content enters from right)
 * reverse=true:  scrolls right (content enters from left)
 * startOffscreen: content starts off-screen and scrolls into view
 */
export function useTickerAnimation(
  durationSeconds: number = 60,
  reverse: boolean = false,
  startOffscreen: boolean = false
) {
  const offsetRef = useRef<number | null>(null); // null = not initialized
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const pausedRef = useRef(false);
  const elRef = useRef<HTMLDivElement | null>(null);
  const contentWidthRef = useRef(0);

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
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
    offsetRef.current = null; // reset for re-init

    requestAnimationFrame(() => {
      measure();

      const step = (timestamp: number) => {
        if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;

        if (!pausedRef.current && contentWidthRef.current > 0) {
          const delta = timestamp - lastTimeRef.current;
          const speed = contentWidthRef.current / (durationSeconds * 1000);
          const movement = delta * speed;

          // Initialize offset on first frame
          if (offsetRef.current === null) {
            if (startOffscreen) {
              // Start with content off-screen: positive offset pushes content right
              offsetRef.current = el.parentElement?.clientWidth ?? window.innerWidth;
            } else if (reverse) {
              // For right-scrolling: start at -contentWidth so content fills viewport
              // Two copies [A][A] at -W shows copy2 in viewport, scrolls right to 0, then resets
              offsetRef.current = -contentWidthRef.current;
            } else {
              offsetRef.current = 0;
            }
          }

          if (reverse) {
            // Scroll right: offset goes from -contentWidth toward 0, then resets
            offsetRef.current += movement;
            if (offsetRef.current >= 0) {
              offsetRef.current -= contentWidthRef.current;
            }
          } else {
            // Scroll left: offset goes from 0 toward -contentWidth, then resets
            offsetRef.current -= movement;
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
  }, [durationSeconds, reverse, startOffscreen, measure]);

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
    lastTimeRef.current = 0;
  }, []);

  return { trackRef, onMouseEnter, onMouseLeave };
}
