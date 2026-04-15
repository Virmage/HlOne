"use client";

import { useState, useEffect } from "react";

// Countries restricted by Derive (options) — ISO 3166-1 alpha-2 codes
const DERIVE_RESTRICTED: Set<string> = new Set([
  "US", // United States
  "AU", // Australia
  "CA", // Canada
  "CU", // Cuba
  "NI", // Nicaragua
  "PA", // Panama
  "IR", // Iran
  "IQ", // Iraq
  "SY", // Syria
  "YE", // Yemen
  "LY", // Libya
  "ML", // Mali
  "SO", // Somalia
  "SD", // Sudan
  "ZW", // Zimbabwe
  "CI", // Ivory Coast
  "CD", // DR Congo
  "MM", // Myanmar
  "KP", // North Korea
  "RU", // Russia
  "UA", // Ukraine (Crimea/Donetsk/Luhansk — can't distinguish by country code alone, block UA-level for safety)
]);

interface GeoCheckResult {
  loading: boolean;
  restricted: boolean;
  country: string | null;
}

const CACHE_KEY = "hlone-geo";
const CACHE_TTL = 3600_000; // 1 hour

export function useGeoCheck(): GeoCheckResult {
  const [state, setState] = useState<GeoCheckResult>({
    loading: true,
    restricted: false,
    country: null,
  });

  useEffect(() => {
    // Check sessionStorage cache first
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const { country, ts } = JSON.parse(cached);
        if (Date.now() - ts < CACHE_TTL) {
          setState({
            loading: false,
            restricted: DERIVE_RESTRICTED.has(country),
            country,
          });
          return;
        }
      }
    } catch {}

    // Fetch from free IP geolocation API
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("https://ipapi.co/json/", {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error("geo api error");
        const data = await res.json();
        const country = data.country_code || null;

        if (!cancelled) {
          setState({
            loading: false,
            restricted: country ? DERIVE_RESTRICTED.has(country) : false,
            country,
          });
          // Cache the result
          try {
            sessionStorage.setItem(
              CACHE_KEY,
              JSON.stringify({ country, ts: Date.now() })
            );
          } catch {}
        }
      } catch {
        // If geo check fails, allow access (fail open — don't block users on API errors)
        if (!cancelled) {
          setState({ loading: false, restricted: false, country: null });
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return state;
}
