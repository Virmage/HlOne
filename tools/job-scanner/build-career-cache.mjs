#!/usr/bin/env node
/**
 * Build Career Cache — fetches top 1000 crypto projects from CoinGecko,
 * finds their career pages (Greenhouse, Lever, Ashby, Workable, generic),
 * and saves a cache file for the main scanner to use.
 *
 * Run: node build-career-cache.mjs
 * Takes ~40-50 min due to CoinGecko rate limits.
 */

import { writeFile, readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, "career-cache.json");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CAREER_PATHS = ["/careers", "/jobs", "/join", "/join-us", "/work-with-us", "/open-roles"];
const ATS_PATTERNS = [
  { type: "greenhouse", re: /boards\.greenhouse\.io\/(\w+)/i },
  { type: "greenhouse", re: /greenhouse\.io\/(?:embed\/)?job_board\/(\w+)/i },
  { type: "lever", re: /jobs\.lever\.co\/(\w+)/i },
  { type: "ashby", re: /jobs\.ashbyhq\.com\/(\w[\w-]*)/i },
  { type: "workable", re: /apply\.workable\.com\/(\w[\w-]*)/i },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        console.log(`  Rate limited, waiting 60s...`);
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i < retries) { await sleep(3000); continue; }
      return null;
    }
  }
}

async function fetchText(url, timeout = 8000) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function headCheck(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
    return res.ok;
  } catch { return false; }
}

// Step 1: Get top 1000 coins from CoinGecko
async function getTopCoins() {
  console.log("Fetching top 400 coins from CoinGecko...");
  const coins = [];
  for (let page = 1; page <= 2; page++) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`;
    console.log(`  Page ${page}/2...`);
    const data = await fetchJSON(url);
    if (data) coins.push(...data);
    await sleep(2500);
  }
  // Trim to 400
  const trimmed = coins.slice(0, 400);
  console.log(`  Got ${trimmed.length} coins`);
  return trimmed;
}

// Step 2: Get homepage for each coin
async function getHomepages(coins) {
  console.log("Fetching homepages for each coin...");
  const results = [];
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];
    if (i % 50 === 0) console.log(`  ${i}/${coins.length}...`);
    const data = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${coin.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`);
    if (data?.links?.homepage?.[0]) {
      results.push({
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol?.toUpperCase(),
        rank: i + 1,
        homepage: data.links.homepage[0].replace(/\/$/, ""),
      });
    }
    await sleep(2500); // ~24 req/min, under free tier limit
  }
  console.log(`  Got ${results.length} homepages`);
  return results;
}

// Step 3: Find career pages
async function findCareerPages(projects) {
  console.log("Scanning for career pages...");
  const cache = [];
  const BATCH = 10;

  for (let i = 0; i < projects.length; i += BATCH) {
    const batch = projects.slice(i, i + BATCH);
    if (i % 100 === 0) console.log(`  ${i}/${projects.length}...`);

    const results = await Promise.all(batch.map(async (proj) => {
      const entry = { ...proj, careerUrl: null, atsType: null, atsId: null };

      // Try common career paths
      for (const path of CAREER_PATHS) {
        const url = `${proj.homepage}${path}`;
        const exists = await headCheck(url);
        if (exists) {
          // Fetch the page to look for ATS links
          const html = await fetchText(url);
          if (html) {
            for (const pat of ATS_PATTERNS) {
              const m = html.match(pat.re);
              if (m) {
                entry.atsType = pat.type;
                entry.atsId = m[1];
                entry.careerUrl = url;
                return entry;
              }
            }
            // Generic career page (no recognized ATS)
            entry.atsType = "generic";
            entry.careerUrl = url;
            return entry;
          }
        }
      }

      // Also check the homepage itself for ATS links
      const homeHtml = await fetchText(proj.homepage);
      if (homeHtml) {
        for (const pat of ATS_PATTERNS) {
          const m = homeHtml.match(pat.re);
          if (m) {
            entry.atsType = pat.type;
            entry.atsId = m[1];
            entry.careerUrl = proj.homepage;
            return entry;
          }
        }
      }

      return entry;
    }));

    cache.push(...results);
    await sleep(500);
  }

  const withCareers = cache.filter(c => c.careerUrl);
  console.log(`  Found ${withCareers.length} projects with career pages`);
  return cache;
}

async function main() {
  const startTime = Date.now();
  const coins = await getTopCoins();
  const projects = await getHomepages(coins);
  const cache = await findCareerPages(projects);

  const output = {
    lastBuilt: new Date().toISOString(),
    totalProjects: cache.length,
    withCareerPages: cache.filter(c => c.careerUrl).length,
    projects: cache.filter(c => c.careerUrl), // Only save ones with career pages
  };

  await writeFile(CACHE_PATH, JSON.stringify(output, null, 2));
  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\nDone in ${elapsed} min. Saved ${output.withCareerPages} projects to ${CACHE_PATH}`);
}

main().catch(console.error);
