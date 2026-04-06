"use client";

import { useRef, useCallback } from "react";

/**
 * JS-driven ticker animation using requestAnimationFrame.
 * Uses a callback ref so animation starts when the element mounts,
 * even if the component initially returns null (data not loaded yet).
 * Immune to React re-render jolts.
 */
export function useTickerAnimation(
  durationSeconds: number = 60,
  reverse: boolean = false
) {
  const progressRef = useRef(0);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const pausedRef = useRef(false);
  const elRef = useRef<HTMLDivElement | null>(null);

  const trackRef = useCallback((el: HTMLDivElement | null) => {
    // Cleanup previous animation if element changes
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }

    elRef.current = el;
    if (!el) return;

    // Reset timing (but keep progress so remounts in same render cycle don't jolt)
    lastTimeRef.current = 0;

    const step = (timestamp: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;

      if (!pausedRef.current) {
        const delta = timestamp - lastTimeRef.current;
        const durationMs = durationSeconds * 1000;
        progressRef.current = (progressRef.current + delta / durationMs) % 1;

        const t = progressRef.current;
        const translate = reverse ? (-50 + t * 50) : (-t * 50);
        el.style.transform = `translate3d(${translate}%, 0, 0)`;
      }

      lastTimeRef.current = timestamp;
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
  }, [durationSeconds, reverse]);

  const onMouseEnter = useCallback(() => {
    pausedRef.current = true;
  }, []);

  const onMouseLeave = useCallback(() => {
    pausedRef.current = false;
    lastTimeRef.current = 0;
  }, []);

  return { trackRef, onMouseEnter, onMouseLeave };
}
