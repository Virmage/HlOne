/**
 * useStudioConfig — Loads the active StudioConfig for the current deploy.
 *
 * Resolution order:
 *   1. `window.__STUDIO_CONFIG__` — set by Studio preview iframe via postMessage
 *   2. `NEXT_PUBLIC_STUDIO_CONFIG` env var — baked in at build time on forked deploys
 *   3. Imported `studio.config.json` at repo root — set by Studio deploy
 *   4. Default HLOne config (everything enabled) — what the flagship runs
 *
 * Default behavior: when no config is found, returns DEFAULT_CONFIG with all
 * widgets enabled. This means the flagship HLOne deployment at hlone.xyz
 * behaves exactly as before — zero breaking change.
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

/** In-memory cache to avoid repeat parsing */
let cachedConfig: StudioConfig | null = null;

function loadConfigSync(): StudioConfig {
  if (cachedConfig) return cachedConfig;

  // 1. Preview mode: config injected by Studio iframe
  if (typeof window !== "undefined" && window.__STUDIO_CONFIG__) {
    const winConfig = window.__STUDIO_CONFIG__;
    cachedConfig = winConfig;
    return winConfig;
  }

  // 2. Build-time env var (base64-encoded JSON)
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
    // Listen for preview-mode config updates via postMessage
    const onMessage = (e: MessageEvent) => {
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
