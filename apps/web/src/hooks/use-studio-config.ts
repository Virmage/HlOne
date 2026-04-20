/**
 * useStudioConfig — Loads the active StudioConfig for the current deploy.
 *
 * Resolution order:
 *   1. Preview mode (URL ?preview=1): config injected via postMessage from parent Studio iframe
 *   2. `NEXT_PUBLIC_STUDIO_CONFIG` env var — baked in at build time on forked deploys
 *   3. Default HLOne config (everything enabled) — what the flagship runs
 *
 * IMPORTANT — config isolation:
 *   - Preview mode is ONLY active when URL has `?preview=1`. This prevents
 *     config bleed from the Studio preview iframe to the main terminal page
 *     (e.g. when a user navigates from /studio back to /).
 *   - postMessage listener is ONLY registered in preview mode.
 *   - The flagship hlone.xyz deploy has NO env var set → always DEFAULT_CONFIG.
 *   - Forked deploys set NEXT_PUBLIC_STUDIO_CONFIG during Studio deploy flow.
 */

"use client";

import { useEffect, useState } from "react";
import {
  type StudioConfig,
  type WidgetKey,
  DEFAULT_CONFIG,
  isWidgetEnabled,
  WIDGET_CATALOG,
} from "@/lib/studio-config";

// Declare window augmentation for preview mode
declare global {
  interface Window {
    __STUDIO_CONFIG__?: StudioConfig;
  }
}

/** True when we're the preview iframe inside /studio — detected via query param */
function isPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("preview");
  } catch {
    return false;
  }
}

/** In-memory cache to avoid repeat parsing */
let cachedConfig: StudioConfig | null = null;

function loadConfigSync(): StudioConfig {
  if (cachedConfig) return cachedConfig;

  // 1. Preview mode ONLY: config injected by Studio iframe
  if (isPreviewMode() && typeof window !== "undefined" && window.__STUDIO_CONFIG__) {
    const winConfig = window.__STUDIO_CONFIG__;
    cachedConfig = winConfig;
    return winConfig;
  }

  // 2. Build-time env var (base64-encoded JSON) — only for forked deploys
  const envConfig = process.env.NEXT_PUBLIC_STUDIO_CONFIG;
  if (envConfig && typeof envConfig === "string") {
    try {
      const decoded = typeof window !== "undefined"
        ? JSON.parse(atob(envConfig))
        : JSON.parse(Buffer.from(envConfig, "base64").toString("utf-8"));
      const merged = { ...DEFAULT_CONFIG, ...decoded };
      cachedConfig = merged;
      return merged;
    } catch (err) {
      console.warn("[studio-config] Failed to parse NEXT_PUBLIC_STUDIO_CONFIG:", err);
    }
  }

  // 3. Fall through to default (full HLOne)
  cachedConfig = DEFAULT_CONFIG;
  return DEFAULT_CONFIG;
}

/**
 * Hook to access the active StudioConfig with a React-friendly API.
 * Re-reads from window when preview mode updates.
 */
export function useStudioConfig(): {
  config: StudioConfig;
  isEnabled: (key: WidgetKey) => boolean;
  setPreviewConfig: (c: StudioConfig | null) => void;
} {
  const [config, setConfig] = useState<StudioConfig>(() => loadConfigSync());

  useEffect(() => {
    // ONLY listen for postMessage config updates when we're the preview iframe.
    // Prevents accidental config injection into the flagship or forked deploys.
    if (!isPreviewMode()) return;

    const onMessage = (e: MessageEvent) => {
      // Only accept messages from the parent (Studio page) on the same origin
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "STUDIO_CONFIG_UPDATE" && e.data?.config) {
        window.__STUDIO_CONFIG__ = e.data.config;
        cachedConfig = e.data.config;
        setConfig(e.data.config);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return {
    config,
    isEnabled: (key: WidgetKey) => isWidgetEnabled(config, key),
    setPreviewConfig: (c) => {
      if (c) {
        window.__STUDIO_CONFIG__ = c;
        cachedConfig = c;
        setConfig(c);
      } else {
        delete window.__STUDIO_CONFIG__;
        cachedConfig = null;
        setConfig(loadConfigSync());
      }
    },
  };
}

/**
 * Non-hook variant for use outside React components (e.g. layout metadata).
 */
export function getActiveConfig(): StudioConfig {
  return loadConfigSync();
}

/**
 * Non-hook helper for checking widget enablement outside React.
 */
export function isWidgetActive(key: WidgetKey): boolean {
  return isWidgetEnabled(loadConfigSync(), key);
}

// Re-export catalog for convenience
export { WIDGET_CATALOG };
